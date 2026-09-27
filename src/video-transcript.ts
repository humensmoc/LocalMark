import { gdcTranscriptRequest } from "./gdc-transcript";
import { transcriptDeadline } from "./transcript-async";
export type VideoTarget = {
  site: "youtube" | "bilibili" | "gdcvault";
  key: string;
};
export type SubtitleCue = { start: number; end: number; text: string };
export type Transcript = {
  key: string;
  source: string;
  details?: string;
  tracks: { id: string; label: string }[];
  selected: string;
  cues: SubtitleCue[];
};
export function videoTarget(href: string): VideoTarget | null {
  const u = new URL(href);
  const session = u.pathname.match(/^\/play\/(\d+)(?:\/|$)/)?.[1];
  if (/^(www\.)?gdcvault\.com$/.test(u.hostname) && session)
    return { site: "gdcvault", key: `gdcvault:${session}` };
  if (
    /^(www\.)?youtube\.com$/.test(u.hostname) &&
    u.pathname === "/watch" &&
    u.searchParams.get("v")
  )
    return { site: "youtube", key: `youtube:${u.searchParams.get("v")}` };
  const id = u.pathname.match(/^\/video\/(BV[\w]+|av\d+)/i)?.[1];
  if (/^(www\.)?bilibili\.com$/.test(u.hostname) && id)
    return {
      site: "bilibili",
      key: `bilibili:${id}:${Number(u.searchParams.get("p")) || 1}`,
    };
  return null;
}
export function subtitleTime(seconds: number) {
  const t = Math.max(0, Math.floor(seconds));
  return t >= 3600
    ? `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`
    : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

// Serialized by chrome.scripting into MAIN. All runtime helpers must stay inside
// this function: the isolated content script cannot read the site's player data.
export async function readVideoTranscript(
  expectedKey: string,
  trackId?: string,
  refresh = false,
): Promise<Transcript | { error: string }> {
  try {
    type Obj = Record<string, any>;
    const w = window as unknown as Obj,
      u = new URL(location.href);
    const youtube = /^(www\.)?youtube\.com$/.test(u.hostname);
    if (!youtube && !/^(www\.)?bilibili\.com$/.test(u.hostname))
      throw Error("只能读取当前 Bilibili 或 YouTube 视频的字幕。");
    const id = youtube
      ? u.searchParams.get("v")
      : u.pathname.match(/^\/video\/(BV[\w]+|av\d+)/i)?.[1];
    const part = Number(u.searchParams.get("p")) || 1;
    const key = youtube ? `youtube:${id}` : `bilibili:${id}:${part}`;
    if (!id || key !== expectedKey)
      throw Error("视频已切换，正在等待当前视频数据，请重试。");
    const native = w.__localmarkNativeSubtitles;
    if (refresh && native) native.openedKey = "";
    const records: Obj[] = (native?.records || []).filter(
      (r: Obj) => r.key === key,
    );
    function text(o: any): string {
      return typeof o === "string"
        ? o
        : (o?.runs?.map((r: Obj) => r.text || "").join("") ??
            o?.simpleText ??
            o?.content ??
            "");
    }
    function clean(cues: SubtitleCue[]) {
      return cues
        .filter(
          (c) => Number.isFinite(c.start) && c.start >= 0 && c.text.trim(),
        )
        .map((c) => ({
          ...c,
          text: c.text.trim(),
          end: Number.isFinite(c.end) && c.end > c.start ? c.end : c.start + 3,
        }))
        .sort((a, b) => a.start - b.start);
    }
    function walk(root: any, visit: (o: Obj) => void) {
      const seen = new WeakSet<object>();
      function step(o: any, depth: number) {
        if (!o || typeof o !== "object" || depth > 45 || seen.has(o)) return;
        seen.add(o);
        visit(o);
        for (const v of Object.values(o)) step(v, depth + 1);
      }
      step(root, 0);
    }
    async function fileJson(address: string) {
      let response: Response;
      try {
        response = await fetch(address, {
          credentials: "omit",
          signal: AbortSignal.timeout(12000),
        });
      } catch (e) {
        throw Error(
          e instanceof Error && /Timeout|Abort/.test(e.name)
            ? "字幕文件请求超时，请重试。"
            : "字幕文件无法连接：网络、跨域或浏览器拦截。",
        );
      }
      if (!response.ok)
        throw Error(
          `字幕文件返回 HTTP ${response.status}，请重试或在播放器中重新选择字幕。`,
        );
      try {
        return await response.json();
      } catch {
        throw Error("字幕文件不是有效的 JSON 数据。");
      }
    }
    if (!youtube) {
      const currentVideo = w.__INITIAL_STATE__?.videoData;
      const pageInfo =
        currentVideo &&
        (currentVideo.bvid === id || `av${currentVideo.aid}` === id)
          ? currentVideo.pages?.find((p: Obj) => p.page === part)
          : null;
      const metadata = records.filter((r) => r.type === "bili-player");
      const matching = metadata.filter((r) => {
        const d = r.data?.data;
        if (!d || !(d.bvid === id || `av${d.aid}` === id) || !d.cid || !d.aid)
          return false;
        if (pageInfo && String(pageInfo.cid) !== String(d.cid)) return false;
        if (d.page_no && Number(d.page_no) !== part) return false;
        const request = new URL(r.url);
        return (
          (!request.searchParams.has("cid") ||
            request.searchParams.get("cid") === String(d.cid)) &&
          (!request.searchParams.has("bvid") ||
            request.searchParams.get("bvid") === d.bvid) &&
          (!request.searchParams.has("aid") ||
            request.searchParams.get("aid") === String(d.aid))
        );
      });
      const response = matching.at(-1);
      if (!response) {
        const failed = metadata.at(-1);
        if (failed && (failed.status >= 400 || failed.data?.code !== 0))
          throw Error(
            `Bilibili 播放器字幕请求失败：HTTP ${failed.status} / ${failed.data?.message || failed.data?.code}。`,
          );
        if (metadata.length)
          throw Error(
            `已拒绝不属于当前视频 ${id} / P${part} 的字幕信息。请刷新视频页后重试。`,
          );
        throw Error(
          native
            ? "正在等待当前播放器的字幕信息。请打开播放器的字幕菜单；仍无结果时刷新视频页。"
            : "字幕监听尚未加载，请重新加载扩展后刷新视频页。",
        );
      }
      if (response.status >= 400 || response.data.code !== 0)
        throw Error(
          `Bilibili 播放器字幕请求失败：${response.status} / ${response.data.message || response.data.code}`,
        );
      const d = response.data.data,
        available: Obj[] = (d.subtitle?.subtitles || []).filter(
          (t: Obj) => t.subtitle_url,
        );
      if (!available.length)
        throw Error(
          d.need_login_subtitle || d.subtitle?.need_login_subtitle
            ? "Bilibili 提示需要登录后才能查看字幕，请登录后重试。"
            : "当前播放器未提供可读取的字幕选项，画面内嵌文字不能作为字幕文件读取。",
        );
      const addressOf = (t: Obj) => new URL(t.subtitle_url, location.href).href;
      const trackKey = (t: Obj) => String(t.id_str ?? t.id ?? t.lan);
      const files = records.filter(
        (r) =>
          r.type === "bili-file" &&
          available.some((t) => addressOf(t) === r.url),
      );
      const active = files.at(-1);
      const selectedLabel = document
        .querySelector(
          '.bpx-player-ctrl-subtitle-menu-item.bpx-state-active,.bpx-player-ctrl-subtitle-menu-item.active,.bpx-player-ctrl-subtitle-menu-item[aria-checked="true"]',
        )
        ?.textContent?.trim();
      const chosen = trackId
        ? available.find((t) => trackKey(t) === trackId)
        : available.find((t) => t.lan_doc === selectedLabel) ||
          available.find((t) => addressOf(t) === active?.url) ||
          available[0];
      if (!chosen)
        throw Error("所选字幕已不在当前播放器的字幕选项中，请重新选择。");
      const address = new URL(addressOf(chosen));
      if (
        address.protocol !== "https:" ||
        !(
          address.hostname.endsWith(".hdslb.com") ||
          address.hostname.endsWith(".bilibili.com")
        )
      )
        throw Error("播放器返回了不支持的字幕文件地址。");
      const captured = files.filter((r) => r.url === address.href).at(-1);
      const file = captured?.data?.body
        ? captured.data
        : await fileJson(address.href);
      // The file URL must come from this video's actual player response. Never
      // call the unsigned /x/player/v2 endpoint as an independent subtitle source.
      const cues = clean(
        (file.body || []).map((c: Obj) => ({
          start: Number(c.from),
          end: Number(c.to),
          text: String(c.content ?? ""),
        })),
      );
      if (!cues.length) throw Error("当前播放器字幕文件为空或格式不受支持。");
      const ai = /^ai-/.test(chosen.lan);
      return {
        key,
        source: `Bilibili · ${ai ? "AI 自动生成字幕" : "网站字幕"}`,
        selected: trackKey(chosen),
        tracks: available.map((t) => ({
          id: trackKey(t),
          label: t.lan_doc || t.lan || "字幕",
        })),
        cues,
        details: `${currentVideo?.bvid === id ? currentVideo.title + " · " : ""}${d.bvid} · P${part} · CID ${d.cid}；${chosen.lan_doc || chosen.lan}；字幕 ID ${trackKey(chosen)}；来源：当前播放器响应及 ${address.hostname}${address.pathname}`,
      };
    }
    const flexy = document.querySelector(
      "ytd-watch-flexy",
    ) as unknown as Obj | null;
    const player = document.querySelector(
      "#movie_player",
    ) as unknown as Obj | null;
    const liveId =
      player?.getVideoData?.()?.video_id || flexy?.getAttribute("video-id");
    if (liveId && liveId !== id)
      throw Error("视频已切换，正在等待当前视频数据，请重试。");
    const panel =
      document.querySelector(
        'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]',
      ) || document.querySelector("ytd-transcript-renderer");
    const response = records.filter((r) => r.type === "youtube").at(-1);
    const raw: SubtitleCue[] = [],
      tracks: Transcript["tracks"] = [];
    let selected = "native";
    // Match native response to the current video before reading renderer data.
    if (response?.status === 200)
      walk(response.data, (o) => {
        const s = o.transcriptSegmentRenderer || o.transcriptSegmentViewModel;
        if (s)
          raw.push({
            start: Number(s.startMs) / 1000,
            end: Number(s.endMs) / 1000,
            text: text(s.snippet || s.text),
          });
        const endpoint =
          o.continuation?.reloadContinuationData?.continuation ||
          o.serviceEndpoint?.getTranscriptEndpoint?.params;
        if (o.title && endpoint) {
          tracks.push({ id: endpoint, label: text(o.title) });
          if (o.selected) selected = endpoint;
        }
      });
    let cues = clean(raw);
    const nativeCurrent =
      native?.domKey === key ||
      (!native &&
        liveId === id &&
        w.ytInitialPlayerResponse?.videoDetails?.videoId === id);
    if (panel && nativeCurrent) {
      const dom: SubtitleCue[] = [];
      for (const el of panel.querySelectorAll(
        "ytd-transcript-segment-renderer,transcript-segment-view-model",
      )) {
        const stamp =
          el
            .querySelector(
              ".segment-timestamp,.ytwTranscriptSegmentViewModelTimestamp",
            )
            ?.textContent?.trim() || "";
        const s = (el as unknown as Obj).data;
        dom.push({
          start:
            s?.startMs !== undefined
              ? Number(s.startMs) / 1000
              : /^\d+(?::\d{2}){1,2}$/.test(stamp)
                ? stamp.split(":").reduce((v, p) => v * 60 + Number(p), 0)
                : NaN,
          end: Number(s?.endMs) / 1000,
          text:
            el.querySelector(".segment-text,.ytwTranscriptSegmentViewModelText")
              ?.textContent || text(s?.snippet),
        });
      }
      const rendered = clean(dom);
      // A search/virtualized native list can be partial; prefer the full native
      // response when present, but DOM alone is sufficient after a late opening.
      if (!cues.length) cues = rendered;
    }
    if (trackId && trackId !== "native" && trackId !== selected) {
      const choice = tracks.find((t) => t.id === trackId);
      if (choice && panel) {
        const footer = panel.querySelector(
          "ytd-transcript-footer-renderer,yt-sort-filter-sub-menu-renderer",
        );
        const trigger = footer?.querySelector<HTMLElement>(
          "button,.dropdown-trigger,tp-yt-paper-menu-button",
        );
        trigger?.click();
        const option = Array.from(
          document.querySelectorAll<HTMLElement>(
            'tp-yt-paper-listbox tp-yt-paper-item,tp-yt-paper-listbox a,[role="listbox"] [role="option"]',
          ),
        ).find((e) => e.textContent?.trim() === choice.label);
        if (option) {
          option.click();
          throw Error("正在等待当前视频的字幕语言切换。");
        }
      }
      throw Error(
        "请在 YouTube 原生内容转文字面板中切换语言，插件会自动同步。",
      );
    }
    if (cues.length) {
      if (!tracks.length)
        tracks.push({
          id: "native",
          label:
            panel
              ?.querySelector("ytd-transcript-footer-renderer")
              ?.textContent?.trim() || "与原生内容转文字一致",
        });
      else if (selected === "native") selected = tracks[0].id;
      return {
        key,
        source: "YouTube · 原生内容转文字",
        tracks,
        selected,
        cues,
        details: `视频 ${id}；来源：YouTube 自身加载的文稿${raw.length ? "响应" : "面板"}，未使用独立字幕请求。`,
      };
    }
    // Ask the website's own button to load the transcript with its full session
    // context. Do not reconstruct youtubei credentials/params in the extension.
    const button = document.querySelector<HTMLElement>(
      "ytd-video-description-transcript-section-renderer button",
    );
    if (button && native && native.openedKey !== key) {
      native.openedKey = key;
      button.click();
      throw Error("正在等待当前视频的原生内容转文字。文稿出现后会自动同步。");
    }
    if (response && (response.status >= 400 || response.data?.error))
      throw Error(
        `YouTube 原生内容转文字返回 HTTP ${response.status}：${response.data?.error?.message || "加载失败"}。在网站打开文稿后，插件会自动同步。`,
      );
    throw Error(
      "请打开 YouTube 的“内容转文字”。文稿出现后插件会自动同步，无需重新请求字幕服务。",
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function transcriptRequest(
  message: { key: string; trackId?: string; refresh?: boolean },
  sender: chrome.runtime.MessageSender,
) {
  if (/^gdcvault:/.test(message.key))
    return gdcTranscriptRequest(message, sender);
  // Chrome can retain the document's original URL in MessageSender after
  // pushState. Validate its origin here, then its current video key in MAIN.
  const origin = sender.url ? new URL(sender.url) : null;
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    !origin ||
    !/^https?:$/.test(origin.protocol) ||
    !/^(www\.)?(youtube\.com|bilibili\.com)$/.test(origin.hostname) ||
    typeof message.key !== "string" ||
    (message.trackId !== undefined && typeof message.trackId !== "string")
  )
    throw Error("只能读取当前 Bilibili 或 YouTube 视频的字幕。");
  const results = await transcriptDeadline(
    chrome.scripting.executeScript({
      target: {
        tabId: sender.tab.id,
        ...(sender.documentId
          ? { documentIds: [sender.documentId] }
          : { frameIds: [0] }),
      },
      world: "MAIN",
      injectImmediately: true,
      func: readVideoTranscript,
      args: [message.key, message.trackId ?? "", message.refresh === true],
    }),
    15000,
    "读取网页字幕超时（15 秒）：网页脚本未返回结果，请重试。",
  );
  const result = results[0]?.result;
  if (!result) throw Error("无法读取网页字幕，请刷新网页后重试。");
  if ("error" in result) throw Error(result.error);
  return result;
}
