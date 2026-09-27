import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  videoTarget,
  type Transcript,
  type VideoTarget,
  type SubtitleCue,
} from "./video-transcript";
import style from "./video-transcript.css?inline";
import { transcriptMessage } from "./transcript-async";
import { Icon } from "./Icon";
import { TranscriptParagraphs } from "./TranscriptParagraphs";
import {
  DEFAULT_TRANSCRIPT_INTERVAL,
  watchTranscriptInterval,
} from "./transcript-layout";
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
    [loadingStage, setLoadingStage] = useState("正在连接字幕扩展后台…"),
    [query, setQuery] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [sourceOpen, setSourceOpen] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [current, setCurrent] = useState(-1),
    [paragraphSeconds, setParagraphSeconds] = useState(
      DEFAULT_TRANSCRIPT_INTERVAL,
    ),
    [seekError, setSeekError] = useState("");
  const generation = useRef(0),
    alive = useRef(true),
    inFlight = useRef(false),
    nativePending = useRef(false),
    userPending = useRef<{ trackId?: string; refresh: boolean } | null>(null),
    queuedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    nativeLanguage = useRef<string | undefined>(undefined),
    searchInput = useRef<HTMLInputElement>(null),
    searchButton = useRef<HTMLButtonElement>(null),
    sourceButton = useRef<HTMLButtonElement>(null),
    sourcePopup = useRef<HTMLDivElement>(null),
    pauseCleanup = useRef<(() => void) | null>(null);
  useEffect(() => watchTranscriptInterval(setParagraphSeconds), []);
  function closeSearch() {
    setSearchOpen(false);
    setQuery("");
    searchButton.current?.focus();
  }
  function positionSource() {
    const popup = sourcePopup.current,
      button = sourceButton.current;
    if (!popup || !button) return;
    const anchor = button.getBoundingClientRect();
    const bounds = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - bounds.width - 12))}px`;
    popup.style.top = `${Math.max(
      12,
      anchor.top >= bounds.height + 20
        ? anchor.top - bounds.height - 8
        : Math.min(anchor.bottom + 8, innerHeight - bounds.height - 12),
    )}px`;
  }
  useEffect(() => {
    if (searchOpen && !collapsed) searchInput.current?.focus();
  }, [searchOpen, collapsed]);
  useEffect(() => {
    if (!sourceOpen) return;
    positionSource();
    window.addEventListener("resize", positionSource);
    document.addEventListener("scroll", positionSource, true);
    return () => {
      window.removeEventListener("resize", positionSource);
      document.removeEventListener("scroll", positionSource, true);
    };
  }, [sourceOpen, data, error]);
  async function load(trackId?: string, refresh = false, fromNative = false) {
    // Native observers can notify while a slow read is still running. Queue one
    // follow-up without invalidating the current result or hiding loaded rows.
    if (inFlight.current) {
      if (fromNative) nativePending.current = true;
      else {
        userPending.current = { trackId, refresh };
        setBusy(true);
        setLoadingStage("正在等待当前读取结束，随后加载所选字幕…");
      }
      return;
    }
    inFlight.current = true;
    let replied = false;
    const g = ++generation.current;
    if (!fromNative) {
      setBusy(true);
      setError("");
    }
    setSeekError("");
    setLoadingStage("正在连接字幕扩展后台…");
    try {
      const ping = await transcriptMessage(
        { type: "video-transcript-ping" },
        6000,
        "字幕扩展后台未响应（6 秒）。请重新加载 LocalMark 扩展并刷新网页。",
      );
      if (!alive.current || g !== generation.current) return;
      if (!ping?.ok || ping.version !== __LOCALMARK_VERSION__)
        throw Error(
          `网页脚本 v${__LOCALMARK_VERSION__} 与扩展后台${ping?.version ? ` v${ping.version}` : "连接"}不一致，请重新加载扩展并刷新网页。`,
        );
      setLoadingStage(
        target.site === "gdcvault"
          ? "正在读取 GDC Vault 字幕文件…"
          : target.site === "youtube"
            ? "正在读取 YouTube 原生文稿…"
            : "正在读取 Bilibili 播放器字幕…",
      );
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        replied = false;
        response = await transcriptMessage(
          {
            type: "video-transcript",
            key: target.key,
            trackId,
            refresh: refresh && attempt === 0,
          },
          target.site === "gdcvault" ? 90000 : 20000,
          "扩展后台已连接，但字幕读取没有返回结果，请重试；仍失败时重新加载扩展并刷新网页。",
        );
        replied = true;
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
      setError("");
      setCurrent(-1);
    } catch (e) {
      if (alive.current && g === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current && g === generation.current) {
        inFlight.current = false;
        const userRequest = userPending.current;
        userPending.current = null;
        setBusy(!!userRequest);
        const followUp = nativePending.current;
        nativePending.current = false;
        // Do not automatically loop when the extension channel itself is stuck.
        if (userRequest)
          queuedTimer.current = setTimeout(() => {
            if (alive.current)
              void load(userRequest.trackId, userRequest.refresh);
          }, 0);
        else if (followUp && replied)
          queuedTimer.current = setTimeout(() => {
            if (alive.current) void load(undefined, false, true);
          }, 200);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    let timer: ReturnType<typeof setTimeout>;
    const nativeChanged = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (alive.current) void load(undefined, false, true);
      }, 200);
    };
    document.addEventListener("localmark-native-subtitles", nativeChanged);
    return () => {
      document.removeEventListener("localmark-native-subtitles", nativeChanged);
      clearTimeout(timer);
      clearTimeout(queuedTimer.current);
      alive.current = false;
      generation.current++;
      pauseCleanup.current?.();
    };
  }, []);
  useEffect(() => {
    let pending = false,
      disposed = false;
    if (target.site === "gdcvault") {
      const update = async () => {
        if (pending || !data) return;
        pending = true;
        try {
          const response = await transcriptMessage(
            {
              type: "video-playback",
              key: target.key,
              action: "state",
            },
            12000,
            "GDC Vault 播放器状态读取超时。",
          );
          if (disposed || !response?.ok) return;
          const { currentTime: t, language } = response.data;
          setCurrent(data.cues.findIndex((c) => c.start <= t && c.end > t));
          const previous = nativeLanguage.current;
          nativeLanguage.current = language;
          if (previous !== undefined && language && previous !== language)
            void load(undefined, false, true);
        } catch {
          /* A reloaded extension or replaced frame will be checked on retry. */
        } finally {
          pending = false;
        }
      };
      void update();
      const timer = setInterval(() => void update(), 1000);
      return () => {
        disposed = true;
        clearInterval(timer);
      };
    }
    const timer = setInterval(() => {
      const t = video(target.site)?.currentTime ?? -1;
      setCurrent(data?.cues.findIndex((c) => c.start <= t && c.end > t) ?? -1);
    }, 350);
    return () => clearInterval(timer);
  }, [data, target.site]);
  async function seek(cue: SubtitleCue) {
    setSeekError("");
    if (videoTarget(location.href)?.key !== target.key) {
      setSeekError("视频已切换，请等待新字幕加载。");
      return;
    }
    if (target.site === "gdcvault") {
      try {
        const response = await transcriptMessage(
          {
            type: "video-playback",
            key: target.key,
            action: "seek",
            seconds: cue.start,
          },
          12000,
          "GDC Vault 播放器跳转未返回结果，请重新加载字幕后再试。",
        );
        if (!response?.ok)
          throw Error(response?.error || "播放器未接受跳转，请重试。");
      } catch (e) {
        if (alive.current)
          setSeekError(e instanceof Error ? e.message : String(e));
      }
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
  const filtered = useMemo(
    () =>
      data?.cues
        .map((cue, index) => ({ cue, index }))
        .filter(({ cue }) =>
          cue.text
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
        ) ?? [],
    [data, query],
  );
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
          <div className="body" aria-busy={busy}>
            {busy ? (
              <p className="message" role="status">
                {loadingStage}
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
                <TranscriptParagraphs
                  items={filtered}
                  seconds={paragraphSeconds}
                  current={current}
                  onSeek={(cue) => void seek(cue)}
                />
              </>
            )}
          </div>
          {seekError && (
            <p className="seek-error" role="alert">
              {seekError}
            </p>
          )}
        </>
      )}
      <footer>
        <button
          ref={sourceButton}
          className="icon-button source-toggle"
          aria-label="字幕来源"
          title="字幕来源"
          popoverTarget="lm-transcript-source"
          aria-expanded={sourceOpen}
        >
          <Icon name="help" size={16} />
        </button>
        {!collapsed && (
          <div className={`tools${searchOpen ? " search-open" : ""}`}>
            <label className="sr-only" htmlFor="lm-transcript-language">
              字幕语言
            </label>
            {data && (
              <select
                id="lm-transcript-language"
                aria-label="字幕语言"
                title={data.tracks.find((t) => t.id === data.selected)?.label}
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
            <div className="search-control">
              {searchOpen && (
                <input
                  ref={searchInput}
                  id="lm-transcript-search"
                  type="search"
                  aria-label="在字幕中搜索"
                  placeholder="在字幕中搜索"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      closeSearch();
                    }
                  }}
                />
              )}
              <button
                ref={searchButton}
                className="icon-button search-toggle"
                aria-label={searchOpen ? "收起搜索" : "搜索字幕"}
                title={searchOpen ? "收起搜索" : "搜索字幕"}
                aria-expanded={searchOpen}
                aria-controls="lm-transcript-search"
                onClick={() =>
                  searchOpen ? closeSearch() : setSearchOpen(true)
                }
              >
                <Icon name={searchOpen ? "close" : "search"} size={18} />
              </button>
            </div>
          </div>
        )}
        <span className="build-version">v{__LOCALMARK_VERSION__}</span>
      </footer>
      <div
        ref={sourcePopup}
        id="lm-transcript-source"
        className="source-popup"
        popover="auto"
        role="dialog"
        aria-label="字幕来源详情"
        onToggle={(e) => {
          const open = e.currentTarget.matches(":popover-open");
          setSourceOpen(open);
          if (open) positionSource();
        }}
      >
        <div className="source-heading">
          <strong>字幕来源</strong>
          <button
            className="icon-button"
            aria-label="关闭字幕来源"
            popoverTarget="lm-transcript-source"
            popoverTargetAction="hide"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        {data && !error ? (
          <>
            <p>{data.source}</p>
            {data.details && <p>{data.details}</p>}
          </>
        ) : (
          <p>字幕来源尚未加载。</p>
        )}
      </div>
    </section>
  );
}

export function mountVideoTranscript() {
  // Only video-site tabs need the placement/navigation poll (including SPA entry).
  if (
    !/^(www\.)?(youtube\.com|bilibili\.com|gdcvault\.com)$/.test(
      location.hostname,
    )
  )
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
    } else if (target.site === "gdcvault") {
      before = document.querySelector("#player .right_column .player-info");
      parent =
        before?.parentElement ||
        document.querySelector("#player .right_column");
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
