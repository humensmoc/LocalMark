import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  subtitleTime,
  videoTarget,
  type Transcript,
  type VideoTarget,
  type SubtitleCue,
} from "./video-transcript";
import style from "./video-transcript.css?inline";
declare const __LOCALMARK_VERSION__: string;
const HOST = "localmark-video-transcript";
function video(site: VideoTarget["site"]) {
  return document.querySelector<HTMLVideoElement>(
    site === "youtube"
      ? "#movie_player video.html5-main-video, #movie_player video"
      : ".bpx-player-video-wrap video, .bilibili-player-video video, .bpx-player-video-wrap bwp-video",
  );
}
function Panel({ target }: { target: VideoTarget }) {
  const [data, setData] = useState<Transcript | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [query, setQuery] = useState(""),
    [collapsed, setCollapsed] = useState(false),
    [current, setCurrent] = useState(-1),
    [seekError, setSeekError] = useState("");
  const generation = useRef(0),
    alive = useRef(true),
    pauseCleanup = useRef<(() => void) | null>(null);
  async function load(trackId?: string, refresh = false) {
    const g = ++generation.current;
    setBusy(true);
    setError("");
    setSeekError("");
    try {
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await chrome.runtime.sendMessage({
          type: "video-transcript",
          key: target.key,
          trackId,
          refresh: refresh && attempt === 0,
        });
        if (
          response?.ok ||
          !/尚未就绪|等待当前视频|等待播放器/.test(response?.error || "") ||
          attempt === 2
        )
          break;
        await new Promise((r) => setTimeout(r, 1200));
        if (!alive.current || g !== generation.current) return;
      }
      if (!alive.current || g !== generation.current) return;
      if (!response?.ok)
        throw Error(
          response?.error || "插件连接已断开，请重新加载扩展并刷新网页。",
        );
      if (
        response.data?.key !== target.key ||
        videoTarget(location.href)?.key !== target.key
      )
        return;
      setData(response.data);
      setCurrent(-1);
    } catch (e) {
      if (alive.current && g === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current && g === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    let timer: ReturnType<typeof setTimeout>;
    const nativeChanged = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (alive.current) void load();
      }, 200);
    };
    document.addEventListener("localmark-native-subtitles", nativeChanged);
    return () => {
      document.removeEventListener("localmark-native-subtitles", nativeChanged);
      clearTimeout(timer);
      alive.current = false;
      generation.current++;
      pauseCleanup.current?.();
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      const t = video(target.site)?.currentTime ?? -1;
      setCurrent(data?.cues.findIndex((c) => c.start <= t && c.end > t) ?? -1);
    }, 350);
    return () => clearInterval(timer);
  }, [data, target.site]);
  function seek(cue: SubtitleCue) {
    setSeekError("");
    if (videoTarget(location.href)?.key !== target.key) {
      setSeekError("视频已切换，请等待新字幕加载。");
      return;
    }
    const player = video(target.site);
    if (!player || player.readyState === 0) {
      setSeekError("播放器尚未准备好，请等待视频加载后再点击字幕。");
      return;
    }
    if (document.querySelector("#movie_player.ad-showing")) {
      setSeekError("正在播放广告，请在正片开始后点击字幕。");
      return;
    }
    try {
      pauseCleanup.current?.();
      const pause = () => {
        player.pause();
        cleanup();
      };
      const timer = setTimeout(() => cleanup(), 5000);
      const cleanup = () => {
        player.removeEventListener("seeked", pause);
        clearTimeout(timer);
        pauseCleanup.current = null;
      };
      pauseCleanup.current = cleanup;
      player.addEventListener("seeked", pause, { once: true });
      player.pause();
      player.currentTime = cue.start;
      player.pause();
    } catch {
      pauseCleanup.current?.();
      setSeekError("播放器未接受跳转，请等待视频加载后重试。");
    }
  }
  const filtered =
    data?.cues
      .map((cue, index) => ({ cue, index }))
      .filter(({ cue }) =>
        cue.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ) ?? [];
  return (
    <section className="transcript" aria-label="LocalMark 字幕列表">
      <header>
        <button
          className="heading"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span>字幕列表</span>
          <span className="chevron">{collapsed ? "+" : "−"}</span>
        </button>
        <button
          className="retry"
          disabled={busy}
          onClick={() => void load(undefined, true)}
          title="重新加载字幕"
        >
          重试
        </button>
      </header>
      {!collapsed && (
        <>
          <div className="tools">
            <label className="sr-only" htmlFor="lm-transcript-language">
              字幕语言
            </label>
            {data && (
              <select
                id="lm-transcript-language"
                aria-label="字幕语言"
                value={data.selected}
                disabled={busy}
                onChange={(e) => void load(e.target.value)}
              >
                {data.tracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            )}
            <input
              type="search"
              aria-label="在字幕中搜索"
              placeholder="在字幕中搜索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="body" aria-busy={busy}>
            {busy ? (
              <p className="message" role="status">
                正在加载字幕…
              </p>
            ) : error ? (
              <div className="message error" role="alert">
                <strong>字幕加载失败</strong>
                <p>{error}</p>
                <button onClick={() => void load(undefined, true)}>
                  重新加载
                </button>
              </div>
            ) : (
              <>
                {!filtered.length && (
                  <p className="message" role="status">
                    没有匹配的字幕。
                  </p>
                )}
                <div className="cues">
                  {filtered.map(({ cue, index }) => (
                    <button
                      key={`${index}:${cue.start}`}
                      className={`cue${current === index ? " active" : ""}`}
                      title={`跳转到 ${subtitleTime(cue.start)} 并暂停`}
                      onClick={() => seek(cue)}
                    >
                      <span className="stamp">{subtitleTime(cue.start)}</span>
                      <span className="text">{cue.text}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {seekError && (
            <p className="seek-error" role="alert">
              {seekError}
            </p>
          )}
          <div className="hint">点击字幕，跳转到对应时间并暂停</div>
          {data?.details && !error && (
            <details className="source-details">
              <summary>字幕来源</summary>
              <p>{data.details}</p>
            </details>
          )}
        </>
      )}
      <footer>
        <span>
          {data?.source ||
            (target.site === "youtube"
              ? "YouTube · 内容转文字"
              : "Bilibili · 播放器字幕")}
        </span>
        <span>LocalMark v{__LOCALMARK_VERSION__}</span>
      </footer>
    </section>
  );
}

export function mountVideoTranscript() {
  // Only video-site tabs need the placement/navigation poll (including SPA entry).
  if (!/^(www\.)?(youtube\.com|bilibili\.com)$/.test(location.hostname))
    return () => {};
  document.getElementById(HOST)?.remove();
  let host: HTMLElement | null = null,
    root: Root | null = null,
    key = "";
  function clear() {
    root?.unmount();
    host?.remove();
    root = null;
    host = null;
    key = "";
  }
  function update() {
    if (!chrome.runtime.id) {
      clear();
      clearInterval(timer);
      return;
    }
    const target = videoTarget(location.href);
    if (!target) {
      if (host) clear();
      return;
    }
    if (key && key !== target.key) clear();
    let parent: Element | null,
      before: Element | null = null;
    if (target.site === "youtube") {
      parent =
        document.querySelector("ytd-watch-flexy #secondary-inner") ||
        document.querySelector("ytd-watch-flexy #secondary");
      // YouTube moves the secondary column below the video in one-column mode.
      if (parent)
        before = Array.from(parent.children).find((e) => e !== host) || null;
    } else {
      const anchor = document.querySelector(
        ".right-container #danmukuBox, .right-container .danmaku-box, #danmukuBox",
      );
      parent =
        anchor?.parentElement ||
        document.querySelector(".right-container-inner, .right-container");
      before = anchor;
      if (!before && parent) {
        const up = parent.querySelector(
          ".up-panel-container, .up-info-container, .up-info",
        );
        let child = up;
        while (child && child.parentElement !== parent)
          child = child.parentElement;
        before =
          child?.nextElementSibling ||
          Array.from(parent.children).find((e) => e !== host) ||
          null;
        if (before === host) before = host?.nextElementSibling || null;
      }
    }
    // Bilibili sends a Vue SSR tree before its deferred app hydrates it. Extra
    // children during hydration shift Vue's DOM/component correspondence and
    // can abort the entire page mount. Vue removes this marker synchronously
    // when it takes ownership; document_idle/load alone does not mean ready.
    if (
      !parent ||
      (target.site === "bilibili" && parent.closest("[data-server-rendered]"))
    ) {
      // Avoid leaving the previous placement attached while the SPA rebuilds.
      if (host?.isConnected) host.remove();
      return;
    }
    if (!host) {
      host = document.createElement("div");
      host.id = HOST;
      host.style.cssText =
        "display:block;width:100%;min-width:0;margin:0 0 16px;box-sizing:border-box;";
      const shadow = host.attachShadow({ mode: "open" }),
        sheet = document.createElement("style"),
        mount = document.createElement("div");
      sheet.textContent = style;
      shadow.append(sheet, mount);
      root = createRoot(mount);
      key = target.key;
      root.render(<Panel key={key} target={target} />);
    }
    const dark =
      target.site === "youtube"
        ? document.documentElement.hasAttribute("dark")
        : document.documentElement.classList.contains("dark") ||
          document.documentElement.getAttribute("data-theme") === "dark";
    const theme = dark ? "dark" : "light";
    if (host.getAttribute("data-theme") !== theme)
      host.setAttribute("data-theme", theme);
    if (host.parentElement !== parent || host.nextElementSibling !== before)
      parent.insertBefore(host, before);
  }
  const timer = setInterval(update, 600);
  update();
  return () => {
    clearInterval(timer);
    clear();
  };
}
