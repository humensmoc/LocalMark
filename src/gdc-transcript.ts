import type { SubtitleCue, Transcript } from "./video-transcript";
import { transcriptDeadline } from "./transcript-async";

type Track = { id: string; label: string; language: string; default?: boolean };
type PlayerInfo = {
  source: string;
  tracks: Track[];
  language: string;
  currentTime: number;
};
type Binding = {
  key: string;
  topDocumentId?: string;
  documentId: string;
  frameUrl: string;
  source: string;
};
const bindings = new Map<number, Binding>();
const files = new Map<string, Promise<string>>();

export function gdcSubtitleUrl(value: string, base?: string) {
  const u = new URL(value, base);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    !/^(?:[\w-]+\.)*(?:blazestreaming\.com|gdcvault\.com)$/.test(u.hostname)
  )
    throw Error("GDC Vault 提供了不支持的字幕文件地址。");
  return u.href;
}
export function gdcSubtitleTracks(master: string, base: string): Track[] {
  if (!master.trimStart().startsWith("#EXTM3U"))
    throw Error("播放器清单不是有效的 HLS 格式。");
  return master
    .split(/\r?\n/)
    .filter((l) => l.startsWith("#EXT-X-MEDIA:"))
    .flatMap((line) => {
      const attrs: Record<string, string> = {};
      for (const m of line.matchAll(/([\w-]+)=(?:"([^"]*)"|([^,\s]+))/g))
        attrs[m[1]] = m[2] ?? m[3];
      if (attrs.TYPE !== "SUBTITLES" || !attrs.URI) return [];
      return [
        {
          id: gdcSubtitleUrl(attrs.URI, base),
          label:
            attrs.NAME === "Chinese"
              ? "Chinese (Simplified)"
              : attrs.NAME || attrs.LANGUAGE || "字幕",
          language: attrs.LANGUAGE || "",
          default: attrs.DEFAULT === "YES",
        },
      ];
    });
}
export function gdcSubtitleSegments(playlist: string, base: string) {
  if (!playlist.trimStart().startsWith("#EXTM3U"))
    throw Error("字幕清单不是有效的 HLS 格式。");
  if (!playlist.includes("#EXT-X-ENDLIST"))
    throw Error("当前字幕为直播或未完成的清单，暂时无法读取完整字幕。");
  if (
    /#EXT-X-(?:BYTERANGE|DISCONTINUITY)(?::|\s|$)/m.test(playlist) ||
    /#EXT-X-KEY:(?!METHOD=NONE(?:,|\s|$))/m.test(playlist)
  )
    throw Error("当前字幕清单包含暂不支持的加密、分段范围或时间轴切换。");
  const urls = playlist
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!urls.length || urls.length > 2500)
    throw Error("字幕清单为空或分片数量超过支持范围。");
  return urls.map((l) => gdcSubtitleUrl(l, base));
}
function timestamp(value: string) {
  if (!/^(?:\d+:)?\d{2}:\d{2}\.\d{3}$/.test(value)) return NaN;
  return value.split(":").reduce((n, p) => n * 60 + Number(p), 0);
}
export function parseGdcVtt(input: string) {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^WEBVTT(?:\s|$)/.test(text))
    throw Error("字幕分片不是有效的 WebVTT 文件。");
  const map = text.match(/X-TIMESTAMP-MAP=([^\n]+)/)?.[1];
  const local = map?.match(/LOCAL:([\d:.]+)/)?.[1],
    mpeg = map?.match(/MPEGTS:(\d+)/)?.[1];
  const offset =
    local && mpeg ? Number(mpeg) / 90000 - timestamp(local) : undefined;
  if (map && (offset === undefined || !Number.isFinite(offset)))
    throw Error("字幕时间映射无效。");
  const cues: SubtitleCue[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    if (/^(WEBVTT|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block))
      continue;
    const lines = block.split("\n"),
      i = lines.findIndex((l) => l.includes(" --> "));
    if (i < 0) continue;
    const time = lines[i].match(/^(\S+)\s+-->\s+(\S+)/);
    if (!time) continue;
    const start = timestamp(time[1]),
      end = timestamp(time[2]);
    // VTT styling, voice labels and inline timestamps are not transcript text.
    const content = lines
      .slice(i + 1)
      .join("\n")
      .replace(/<[^>]*>/g, "")
      .replace(
        /&(amp|lt|gt|nbsp|lrm|rlm);/g,
        (_, entity: string) =>
          ({ amp: "&", lt: "<", gt: ">", nbsp: " ", lrm: "", rlm: "" })[
            entity
          ] || "",
      )
      .trim();
    if (Number.isFinite(start) && start >= 0 && end > start && content)
      cues.push({ start, end, text: content });
  }
  return { offset, cues };
}
export function mergeGdcVtt(parts: string[]) {
  const parsed = parts.map(parseGdcVtt),
    firstOffset = parsed.find((p) => p.offset !== undefined)?.offset ?? 0;
  const cues: SubtitleCue[] = [],
    seen = new Set<string>();
  for (const part of parsed) {
    let shift = part.offset === undefined ? 0 : part.offset - firstOffset;
    // MPEGTS is a 33-bit clock. Normalize a wrap without shifting VOD time zero.
    const wrap = 2 ** 33 / 90000;
    if (shift < -wrap / 2) shift += wrap;
    if (shift > wrap / 2) shift -= wrap;
    for (const cue of part.cues) {
      const c = { ...cue, start: cue.start + shift, end: cue.end + shift };
      const id = `${c.start.toFixed(3)}:${c.end.toFixed(3)}:${c.text}`;
      if (c.start >= 0 && !seen.has(id)) {
        seen.add(id);
        cues.push(c);
      }
    }
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}
async function fetchText(url: string, signal: AbortSignal, refresh = false) {
  url = gdcSubtitleUrl(url);
  if (refresh) files.delete(url);
  if (!files.has(url)) {
    const promise = (async () => {
      const response = await fetch(url, {
        credentials: "omit",
        signal,
        redirect: "error",
      });
      if (!response.ok)
        throw Error(
          `GDC Vault 字幕文件返回 HTTP ${response.status}${response.status === 401 || response.status === 403 ? "，请确认视频访问权限或重新加载播放器" : ""}。`,
        );
      const result = await response.text();
      if (result.length > 4_000_000) throw Error("字幕文件超过支持的大小。");
      return result;
    })();
    files.set(url, promise);
    void promise.catch(() => {
      if (files.get(url) === promise) files.delete(url);
    });
    // Session-only, bounded cache; never persist the user's transcripts.
    while (files.size > 3000) files.delete(files.keys().next().value!);
  }
  return files.get(url)!;
}

// Both functions below are serialized into the page. Keep their helpers local.
export function gdcPageContext(key: string) {
  if (
    !/^(www\.)?gdcvault\.com$/.test(location.hostname) ||
    `gdcvault:${location.pathname.match(/^\/play\/(\d+)(?:\/|$)/)?.[1]}` !== key
  )
    return { error: "视频已切换，请等待当前视频字幕。" };
  const frame = document.querySelector<HTMLIFrameElement>(
    "#player #container iframe, #player .left_column iframe",
  );
  if (frame) {
    const u = new URL(frame.src);
    if (u.protocol !== "https:" || u.hostname !== "gdcvault.blazestreaming.com")
      return { error: "此 GDC Vault 视频使用暂未支持的嵌入播放器。" };
    return { frameUrl: u.href };
  }
  if (document.querySelector("#player video"))
    return { frameUrl: location.href };
  return {
    error:
      "GDC Vault 播放器尚未就绪；若页面要求登录或订阅，请先在网站取得视频访问权限。",
  };
}
export function gdcPlayerAction(
  frameUrl: string,
  action: "describe" | "state" | "seek" | "freeze" | "resume",
  source = "",
  seconds = 0,
) {
  if (location.href !== frameUrl) return null;
  try {
    const w = window as any,
      video = document.querySelector<HTMLVideoElement>(
        "#my-video video, video.video-js, #player video, video",
      );
    const player = w.player?.textTracks
      ? w.player
      : w.videojs?.getPlayer?.("my-video");
    const currentSource = String(
      player?.currentSource?.()?.src ||
        player?.currentSrc?.() ||
        video?.currentSrc ||
        "",
    );
    const nativeTracks = Array.from(
      player?.textTracks?.() || video?.textTracks || [],
    ) as any[];
    const language =
      nativeTracks.find(
        (t) => t.mode === "showing" && /^(subtitles|captions)$/.test(t.kind),
      )?.language || "";
    if (action !== "describe") {
      if (source !== currentSource)
        return { error: "播放器的视频源已变化，请重新加载字幕。" };
      if (!video || !video.readyState)
        return { error: "播放器尚未准备好，请等待视频加载后重试。" };
      const wasPlaying = !video.paused;
      if (action === "freeze") video.pause();
      if (action === "resume") void video.play().catch(() => {});
      if (action === "seek") {
        if (
          !Number.isFinite(seconds) ||
          seconds < 0 ||
          (Number.isFinite(video.duration) && seconds > video.duration)
        )
          return { error: "目标时间超出当前视频范围。" };
        w.__localmarkGdcPauseCleanup?.();
        const pause = () => {
          video.pause();
          cleanup();
        };
        const timer = setTimeout(() => cleanup(), 5000);
        const cleanup = () => {
          clearTimeout(timer);
          video.removeEventListener("seeked", pause);
          w.__localmarkGdcPauseCleanup = null;
        };
        w.__localmarkGdcPauseCleanup = cleanup;
        video.addEventListener("seeked", pause, { once: true });
        video.pause();
        video.currentTime = seconds;
        video.pause();
      }
      const rect = video.getBoundingClientRect();
      return { currentTime: video.currentTime, language, wasPlaying,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        videoRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
    }
    const remote = Array.from(
      player?.remoteTextTrackEls?.() ||
        document.querySelectorAll("video track"),
    ) as any[];
    const tracks = remote
      .filter((t) => /^(subtitles|captions)$/.test(t.kind || t.track?.kind))
      .filter((t) => t.src)
      .map((t) => ({
        id: new URL(t.src, location.href).href,
        label: t.label || t.track?.label || t.srclang || "字幕",
        language: t.srclang || t.track?.language || "",
        default: !!t.default,
      }));
    if (!currentSource && !tracks.length)
      return { error: "GDC Vault 播放器尚未就绪，请等待播放器加载后重试。" };
    return {
      source: currentSource,
      tracks,
      language,
      currentTime: video?.currentTime || 0,
    };
  } catch {
    return { error: "无法读取 GDC Vault 播放器，请刷新视频页面后重试。" };
  }
}
function validateSender(sender: chrome.runtime.MessageSender, key: string) {
  const u = new URL(sender.url || "https://invalid.local");
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    !/^https?:$/.test(u.protocol) ||
    !/^(www\.)?gdcvault\.com$/.test(u.hostname) ||
    !/^gdcvault:\d+$/.test(key)
  )
    throw Error("只能操作当前 GDC Vault 视频的字幕和播放器。");
  return sender.tab.id;
}
async function context(sender: chrome.runtime.MessageSender, key: string) {
  const tabId = validateSender(sender, key);
  const results = await transcriptDeadline(
    chrome.scripting.executeScript({
      target: {
        tabId,
        ...(sender.documentId
          ? { documentIds: [sender.documentId] }
          : { frameIds: [0] }),
      },
      world: "MAIN",
      injectImmediately: true,
      func: gdcPageContext,
      args: [key],
    }),
    5000,
    "读取 GDC Vault 页面超时（5 秒）：页面脚本未返回播放器地址。",
  );
  const ctx = results[0]?.result;
  if (!ctx || ctx.error || !ctx.frameUrl)
    throw Error(ctx?.error || "GDC Vault 页面已关闭或播放器未加载。");
  return { tabId, frameUrl: ctx.frameUrl };
}
export async function gdcTranscriptRequest(
  message: { key: string; refresh?: boolean },
  sender: chrome.runtime.MessageSender,
): Promise<Transcript> {
  const { tabId, frameUrl } = await context(sender, message.key);
  const results = await transcriptDeadline(
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      injectImmediately: true,
      func: gdcPlayerAction,
      args: [frameUrl, "describe"],
    }),
    5000,
    "读取 GDC Vault 内嵌播放器超时（5 秒）：播放器页面脚本未返回字幕信息。",
  );
  const frame = results.find((r) => r.result);
  const raw = frame?.result;
  if (!raw || "error" in raw)
    throw Error(
      raw?.error ||
        "等待播放器内嵌页面加载；若被浏览器拦截，请允许该视频播放器加载后重试。",
    );
  const info = raw as PlayerInfo;
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 60000);
  try {
    let tracks = info.tracks;
    if (!tracks.length) {
      if (!/\.m3u8(?:[?#]|$)/i.test(info.source))
        throw Error("此 GDC Vault 视频未提供可读取的字幕轨道。");
      tracks = gdcSubtitleTracks(
        await fetchText(info.source, controller.signal, true),
        info.source,
      );
    }
    if (!tracks.length) throw Error("此 GDC Vault 视频未提供字幕文件。");
    const selected =
      tracks.find((t) => info.language && t.language === info.language) ||
      tracks.find((t) => t.default) ||
      tracks[0];
    const body = await fetchText(
      selected.id,
      controller.signal,
      message.refresh,
    );
    let parts: string[];
    if (body.trimStart().startsWith("#EXTM3U")) {
      const segments = gdcSubtitleSegments(body, selected.id);
      parts = new Array(segments.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(8, segments.length) }, async () => {
          while (next < segments.length) {
            const i = next++;
            parts[i] = await fetchText(
              segments[i],
              controller.signal,
              message.refresh,
            );
          }
        }),
      );
    } else parts = [body];
    const cues = mergeGdcVtt(parts);
    if (!cues.length) throw Error("字幕文件已加载，但没有可显示的字幕内容。");
    // Reject results from a frame replaced while its subtitle files were loading.
    const now = await context(sender, message.key);
    if (now.frameUrl !== frameUrl)
      throw Error("播放器已切换，请重新加载字幕。");
    const verified = await transcriptDeadline(
      chrome.scripting.executeScript({
        target: { tabId, documentIds: [frame!.documentId] },
        world: "MAIN",
        injectImmediately: true,
        func: gdcPlayerAction,
        args: [frameUrl, "describe"],
      }),
      5000,
      "核对 GDC Vault 播放器超时（5 秒），请重新加载字幕。",
    );
    const current = verified[0]?.result;
    if (!current || !("source" in current) || current.source !== info.source)
      throw Error("播放器的视频源已变化，请重新加载字幕。");
    bindings.set(tabId, {
      key: message.key,
      topDocumentId: sender.documentId,
      documentId: frame!.documentId,
      frameUrl,
      source: info.source,
    });
    while (bindings.size > 30) bindings.delete(bindings.keys().next().value!);
    return {
      key: message.key,
      source: "GDC Vault · 播放器字幕文件",
      selected: selected.id,
      tracks,
      cues,
      details: `视频 ${message.key.split(":")[1]}；${selected.label}；${parts.length} 个 WebVTT 文件；${new URL(selected.id).hostname}${new URL(selected.id).pathname}`,
    };
  } catch (e) {
    controller.abort();
    if (e instanceof Error && /Abort|Timeout/.test(e.name))
      throw Error("GDC Vault 字幕加载超时，请重试。");
    if (e instanceof TypeError)
      throw Error("GDC Vault 字幕文件无法连接：网络或浏览器拦截，请重试。");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
export async function gdcPlaybackRequest(
  message: { key: string; action: "state" | "seek" | "freeze" | "resume"; seconds?: number },
  sender: chrome.runtime.MessageSender,
) {
  const tabId = validateSender(sender, message.key);
  if (!["state", "seek", "freeze", "resume"].includes(message.action))
    throw Error("无效的播放器操作。");
  let binding = bindings.get(tabId);
  if (!binding || binding.key !== message.key || binding.topDocumentId !== sender.documentId) {
    if (message.action === "resume") throw Error("播放器绑定已失效，请重试截图。");
    const { frameUrl } = await context(sender, message.key);
    const described = await transcriptDeadline(chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: "MAIN", injectImmediately: true,
      func: gdcPlayerAction, args: [frameUrl, "describe"],
    }), 5000, "读取 GDC Vault 播放器超时，请重试。");
    const frame = described.find(result => result.result);
    const info = frame?.result;
    if (!frame?.documentId || !info || "error" in info || !info.source)
      throw Error(info && "error" in info ? info.error : "播放器尚未准备好，请等待视频加载后重试。");
    binding = { key: message.key, topDocumentId: sender.documentId,
      documentId: frame.documentId, frameUrl, source: info.source };
    bindings.set(tabId, binding);
    while (bindings.size > 30) bindings.delete(bindings.keys().next().value!);
  }
  if (message.action === "seek") {
    const ctx = await context(sender, message.key);
    if (ctx.frameUrl !== binding.frameUrl)
      throw Error("播放器已切换，请重新加载字幕。");
    if (
      typeof message.seconds !== "number" ||
      !Number.isFinite(message.seconds)
    )
      throw Error("无效的视频时间。");
  }
  const results = await transcriptDeadline(
    chrome.scripting
      .executeScript({
        target: { tabId, documentIds: [binding.documentId] },
        world: "MAIN",
        injectImmediately: true,
        func: gdcPlayerAction,
        args: [
          binding.frameUrl,
          message.action,
          binding.source,
          message.seconds ?? 0,
        ],
      })
      .catch(() => {
        throw Error(
          "无法访问播放器页面，它可能已重新加载。请刷新网页后重试。",
        );
      }),
    5000,
    "GDC Vault 播放器没有响应，请重新加载字幕后再试。",
  );
  const result = results[0]?.result;
  if (!result || "error" in result)
    throw Error(result?.error || "播放器已关闭或切换，请刷新网页后重试。");
  return result;
}
