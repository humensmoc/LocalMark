import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  videoTarget,
  subtitleTime,
  type Transcript,
  type VideoTarget,
  type SubtitleCue,
} from "./video-transcript";
import style from "./video-transcript.css?inline";
import { transcriptMessage } from "./transcript-async";
import { Icon } from "./Icon";
import { TranscriptParagraphs } from "./TranscriptParagraphs";
import { request } from "./protocol";
import { colorInfo, highlightPalette, initialHighlightColor, type Color, type Library, type VideoCueRef, type VideoMark } from "./model";
import { cueForTime, markCueRange, videoCueRef, videoMarkLabel, videoMarksForPage, videoPageUrl } from "./video-marks";
import { ScreenshotImage } from "./ScreenshotImage";
import { downloadTranscript } from "./transcript-download";
import type { CaptureRect } from "./video-capture";
import {
  DEFAULT_TRANSCRIPT_INTERVAL,
  watchTranscriptInterval,
} from "./transcript-layout";
declare const __LOCALMARK_VERSION__: string;
const HOST = "localmark-video-transcript";
const THEME_STORAGE_KEY = "localmark.videoTranscriptTheme";
type VideoTheme = "dark" | "light";
type VideoDraft = {
  id?: string;
  old?: VideoMark;
  kind: VideoMark["kind"];
  time: number;
  trackId?: string;
  from?: VideoCueRef;
  to?: VideoCueRef;
  text: string;
  note: string;
  color: Color;
  x: number;
  y: number;
  expanded: boolean;
  preserveSelection?: boolean;
};
function video(site: VideoTarget["site"]) {
  return document.querySelector<HTMLVideoElement>(
    site === "youtube"
      ? "#movie_player video.html5-main-video, #movie_player video"
      : ".bpx-player-video-wrap video, .bilibili-player-video video, .bpx-player-video-wrap bwp-video",
  );
}
function Panel({ target, theme, onToggleTheme }: { target: VideoTarget; theme: VideoTheme; onToggleTheme: () => void }) {
  const [data, setData] = useState<Transcript | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [loadingStage, setLoadingStage] = useState("正在连接字幕扩展后台…"),
    [query, setQuery] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [sourceOpen, setSourceOpen] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [following, setFollowing] = useState(false),
    [holdingLocate, setHoldingLocate] = useState(false),
    [current, setCurrent] = useState(-1),
    [playbackTime, setPlaybackTime] = useState(0),
    [playerReady, setPlayerReady] = useState(false),
    [library, setLibrary] = useState<Library | null>(null),
    [draft, setDraft] = useState<VideoDraft | null>(null),
    [quickNote, setQuickNote] = useState(""),
    [quickExpanded, setQuickExpanded] = useState(false),
    [markBusy, setMarkBusy] = useState(false),
    [downloadBusy, setDownloadBusy] = useState(false),
    [markError, setMarkError] = useState(""),
    [paragraphSeconds, setParagraphSeconds] = useState(
      DEFAULT_TRANSCRIPT_INTERVAL,
    ),
    [seekError, setSeekError] = useState("");
  const generation = useRef(0),
    alive = useRef(true),
    inFlight = useRef(false),
    nativePending = useRef(false),
    userPending = useRef<{ refresh: boolean } | null>(null),
    queuedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    nativeLanguage = useRef<string | undefined>(undefined),
    searchInput = useRef<HTMLInputElement>(null),
    searchButton = useRef<HTMLButtonElement>(null),
    quickInput = useRef<HTMLTextAreaElement>(null),
    shortcutFocus = useRef(false),
    sourceButton = useRef<HTMLButtonElement>(null),
    sourcePopup = useRef<HTMLDivElement>(null),
    pauseCleanup = useRef<(() => void) | null>(null),
    bodyRef = useRef<HTMLDivElement>(null),
    locateHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    locatePointer = useRef<number | null>(null),
    suppressLocateClick = useRef(false),
    draftInput = useRef<HTMLTextAreaElement>(null),
    composerRef = useRef<HTMLDivElement>(null),
    deepLinkDone = useRef(false);
  const pageUrl = videoPageUrl(target);
  const page = library ? Object.values(library.entries).find(entry => entry.page.url === pageUrl)?.page : undefined;
  const marks = videoMarksForPage(page, target.key);
  const hasTranscript = !!data?.cues.length && !error && !busy;
  function stopLocateHold() {
    if (locateHoldTimer.current !== null) clearTimeout(locateHoldTimer.current);
    locateHoldTimer.current = null;
    locatePointer.current = null;
    setHoldingLocate(false);
  }
  function startLocateHold() {
    if (locateHoldTimer.current !== null) return;
    suppressLocateClick.current = false;
    setHoldingLocate(true);
    locateHoldTimer.current = setTimeout(() => {
      locateHoldTimer.current = null;
      suppressLocateClick.current = true;
      setHoldingLocate(false);
      setFollowing(value => !value);
    }, 1000);
  }
  useEffect(() => () => {
    if (locateHoldTimer.current !== null) clearTimeout(locateHoldTimer.current);
  }, []);
  useEffect(() => {
    if (collapsed || !hasTranscript) stopLocateHold();
  }, [collapsed, hasTranscript]);
  async function loadMarks() {
    try { setLibrary(await request({ type: "snapshot" })); }
    catch (error) { setMarkError(String(error)); }
  }
  useEffect(() => {
    if (!chrome.runtime.onMessage) return;
    void loadMarks();
    const changed = (message: { type?: string }) => { if (message?.type === "changed") void loadMarks(); };
    chrome.runtime.onMessage?.addListener(changed);
    return () => chrome.runtime.onMessage?.removeListener(changed);
  }, [target.key]);
  useEffect(() => { if (draft && !draft.preserveSelection) draftInput.current?.focus(); }, [draft?.id, draft?.time, draft?.kind, draft?.preserveSelection]);
  useEffect(() => {
    const node = composerRef.current;
    if (!draft || !node) return;
    node.showPopover();
    return () => { if (node.isConnected && node.matches(":popover-open")) node.hidePopover(); };
  }, [draft?.id, draft?.kind, draft?.time]);
  useEffect(() => {
    if (!draft) return;
    const dismiss = (event: PointerEvent) => {
      const node = composerRef.current;
      if (!markBusy && node && !event.composedPath().includes(node)) setDraft(null);
    };
    const dismissOnFrameFocus = () => {
      if (!markBusy && document.activeElement instanceof HTMLIFrameElement) setDraft(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", dismissOnFrameFocus);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", dismissOnFrameFocus);
    };
  }, [!!draft, markBusy]);
  useEffect(() => {
    if (!draft?.preserveSelection) return;
    const focusOnTyping = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey && !event.altKey &&
        (event.key.length === 1 || event.key === "Process") &&
        !event.composedPath().includes(composerRef.current as EventTarget) &&
        !event.composedPath().some(node => node instanceof HTMLElement &&
          (node.isContentEditable || node.matches("input, textarea, select")))) {
        draftInput.current?.focus({ preventScroll: true });
        // The first key still targets the page even after focus moves to the note.
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("keydown", focusOnTyping, true);
    return () => document.removeEventListener("keydown", focusOnTyping, true);
  }, [draft?.preserveSelection]);
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
    if (!collapsed && shortcutFocus.current) {
      quickInput.current?.focus();
      shortcutFocus.current = false;
    }
  }, [collapsed]);
  useEffect(() => {
    const focusQuickInput = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
        event.isComposing || event.keyCode === 229 || event.repeat || draft ||
        event.composedPath().some(node => node instanceof HTMLElement &&
          (node.isContentEditable || node.matches("input, textarea, select")))) return;
      event.preventDefault();
      event.stopPropagation();
      setQuickExpanded(true);
      if (collapsed) {
        shortcutFocus.current = true;
        setCollapsed(false);
      } else quickInput.current?.focus();
    };
    document.addEventListener("keydown", focusQuickInput, true);
    return () => document.removeEventListener("keydown", focusQuickInput, true);
  }, [collapsed, draft]);
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
  async function load(refresh = false, fromNative = false) {
    // Native observers can notify while a slow read is still running. Queue one
    // follow-up without invalidating the current result or hiding loaded rows.
    if (inFlight.current) {
      if (fromNative) nativePending.current = true;
      else {
        userPending.current = { refresh };
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
      setError(response.data.error || "");
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
              void load(userRequest.refresh);
          }, 0);
        else if (followUp && replied)
          queuedTimer.current = setTimeout(() => {
            if (alive.current) void load(false, true);
          }, 200);
      }
    }
  }
  async function downloadCaptions() {
    if (!data?.cues.length || downloadBusy || videoTarget(location.href)?.key !== target.key) return;
    setDownloadBusy(true);
    setMarkError("");
    try {
      let player: Transcript | undefined;
      if (target.site === "youtube") {
        const response = await transcriptMessage(
          { type: "video-transcript", key: target.key, source: "player" },
          20000,
          "读取 YouTube 播放器字幕超时，请稍后重试。",
        );
        if (!response?.ok) throw Error(response?.error || "播放器字幕读取失败。");
        player = response.data;
        if (player?.key !== target.key || videoTarget(location.href)?.key !== target.key)
          throw Error("视频已切换，请在当前视频重新下载字幕。");
      }
      downloadTranscript(data, target, document.title, pageUrl, player);
    } catch (cause) {
      setMarkError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloadBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    let timer: ReturnType<typeof setTimeout>;
    const nativeChanged = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (alive.current) void load(false, true);
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
        if (pending) return;
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
          if (disposed) return;
          if (!response?.ok) { setPlayerReady(false); return; }
          const { currentTime: t, language } = response.data;
          setPlayerReady(true);
          setPlaybackTime(t);
          setCurrent(data?.cues.findIndex((c) => c.start <= t && c.end > t) ?? -1);
          const previous = nativeLanguage.current;
          nativeLanguage.current = language;
          if (previous !== undefined && language && previous !== language)
            void load(false, true);
        } catch {
          if (!disposed) setPlayerReady(false);
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
      if (t >= 0) setPlaybackTime(t);
      setCurrent(data?.cues.findIndex((c) => c.start <= t && c.end > t) ?? -1);
    }, 350);
    return () => clearInterval(timer);
  }, [data, target.site]);
  async function seek(cue: SubtitleCue) {
    setSeekError("");
    if (videoTarget(location.href)?.key !== target.key) {
      setSeekError("视频已切换，请等待新视频加载。");
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
          "GDC Vault 播放器跳转未返回结果，请刷新网页后再试。",
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
  function scrollCue(index: number, center = false) {
    const body = bodyRef.current, cue = body?.querySelector<HTMLElement>(`.cue[data-index="${index}"]`);
    if (!body || !cue) return;
    const cueRect = cue.getBoundingClientRect(), bodyRect = body.getBoundingClientRect();
    const offset = center
      ? (cueRect.top + cueRect.bottom - bodyRect.top - bodyRect.bottom) / 2
      : cueRect.top - bodyRect.top - body.clientHeight / 3;
    body.scrollTo({ top: body.scrollTop + offset, behavior: "smooth" });
  }
  async function locatePlaybackCue() {
    if (!data?.cues.length || busy) return;
    let time = playbackTime;
    if (target.site === "gdcvault") {
      try { time = (await playerState("state")).currentTime; } catch { /* Use the last polled time. */ }
    } else {
      const liveTime = video(target.site)?.currentTime;
      if (liveTime !== undefined && Number.isFinite(liveTime) && liveTime >= 0) time = liveTime;
    }
    const index = cueForTime(data.cues, time);
    if (index < 0) return;
    if (query && !filtered.some(item => item.index === index)) {
      setQuery("");
      requestAnimationFrame(() => requestAnimationFrame(() => scrollCue(index)));
    } else scrollCue(index);
  }
  async function jumpRail(mark: VideoMark) {
    if (!data) return;
    const range = markCueRange(mark, data.cues, data.selected);
    if (range) scrollCue(range[0]);
    else setMarkError("原字幕已变化或来自其他字幕来源，无法定位这条文字标注。");
  }
  useEffect(() => {
    const listener = (message: { type?: string; action?: string; id?: string; key?: string }, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => {
      if (message?.type !== "video-mark-action") return false;
      if (sender.id !== chrome.runtime.id || message.key !== target.key) { reply({ ok: false, error: "视频已切换。" }); return false; }
      const mark = marks.find(item => item.id === message.id);
      if (!mark) { reply({ ok: false, error: "标注已改变，请刷新侧栏。" }); return false; }
      if (message.action === "edit") editMark(mark, innerWidth / 2, innerHeight / 3);
      else if (message.action === "jump") {
        void jumpRail(mark);
        void seek({ start: mark.time, end: mark.time + 0.001, text: "" });
      } else { reply({ ok: false, error: "操作无效。" }); return false; }
      reply({ ok: true });
      return false;
    };
    chrome.runtime.onMessage?.addListener(listener);
    return () => chrome.runtime.onMessage?.removeListener(listener);
  }, [marks, data, target.key]);
  useEffect(() => {
    if (deepLinkDone.current || target.site !== "gdcvault" || !playerReady) return;
    const time = Number(location.hash.match(/^#localmark-time=([\d.]+)$/)?.[1]);
    deepLinkDone.current = true;
    if (Number.isFinite(time) && time >= 0) void seek({ start: time, end: time + 0.001, text: "" });
  }, [target.key, playerReady]);
  function editMark(mark: VideoMark, x: number, y: number) {
    setMarkError("");
    setDraft({ id: mark.id, old: mark, kind: mark.kind, time: mark.time, trackId: mark.trackId,
      from: mark.from, to: mark.to, text: mark.text, note: mark.note, color: mark.color, x, y, expanded: true });
  }
  async function saveDraft(color?: Color) {
    if (!draft || markBusy) return;
    setMarkBusy(true); setMarkError("");
    try {
      const next = await request({ type: "video-save", videoKey: target.key, url: pageUrl,
        title: document.title, favicon: "", mark: { id: draft.id, expectedUpdatedAt: draft.old?.updatedAt,
          expectedMark: draft.old ? JSON.stringify(draft.old) : undefined, kind: draft.kind, time: draft.time,
          trackId: draft.trackId, from: draft.from, to: draft.to, text: draft.text,
          note: draft.note, color: color ?? draft.color } });
      setLibrary(next); setDraft(null); window.getSelection()?.removeAllRanges();
    } catch (error) { setMarkError(String(error)); }
    finally { setMarkBusy(false); }
  }
  async function deleteMark(mark: VideoMark) {
    if (!page || markBusy) return;
    setMarkBusy(true); setMarkError("");
    try {
      const next = await request({ type: "video-delete", pageId: page.id, id: mark.id,
        expectedUpdatedAt: mark.updatedAt, expectedMark: JSON.stringify(mark) });
      setLibrary(next); if (draft?.old?.id === mark.id) setDraft(null);
    } catch (error) { setMarkError(String(error)); }
    finally { setMarkBusy(false); }
  }
  async function playerState(action: "state" | "freeze" | "resume") {
    const response = await transcriptMessage({ type: "video-playback", key: target.key, action }, 12000, "播放器未响应。");
    if (!response?.ok) throw Error(response?.error || "播放器未响应。");
    return response.data as { currentTime: number; wasPlaying: boolean; viewportWidth: number; viewportHeight: number;
      videoRect: { left: number; top: number; width: number; height: number } };
  }
  async function quickSave(kind: VideoMark["kind"]) {
    if (markBusy || ((kind === "subtitle" || kind === "comment") && !quickNote.trim())) return;
    if (kind === "subtitle" && !hasTranscript) return;
    setMarkBusy(true); setMarkError("");
    let resume = false, savedScroll: [number, number] | null = null;
    try {
      let time: number, captureRect: CaptureRect | undefined;
      if (target.site === "gdcvault") {
        const iframe = document.querySelector<HTMLIFrameElement>("#player #container iframe, #player .left_column iframe");
        const state = await playerState(kind === "screenshot" ? "freeze" : "state");
        resume = kind === "screenshot" && state.wasPlaying;
        time = state.currentTime;
        if (kind === "screenshot" && iframe) {
          savedScroll = [scrollX, scrollY]; iframe.scrollIntoView({ block: "center" });
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        if (kind === "screenshot") {
          const frame = iframe?.getBoundingClientRect();
          if (!frame) throw Error("无法找到 GDC Vault 视频画面。");
          const sx = frame.width / state.viewportWidth, sy = frame.height / state.viewportHeight;
          captureRect = { left: frame.left + state.videoRect.left * sx, top: frame.top + state.videoRect.top * sy,
            width: state.videoRect.width * sx, height: state.videoRect.height * sy,
            viewportWidth: innerWidth, viewportHeight: innerHeight };
        }
      } else {
        const player = video(target.site);
        if (!player || !player.readyState) throw Error("播放器尚未准备好。");
        time = player.currentTime;
        if (kind === "screenshot") {
          resume = !player.paused; player.pause();
          savedScroll = [scrollX, scrollY]; player.scrollIntoView({ block: "center" });
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        if (kind === "screenshot") {
          const rect = player.getBoundingClientRect();
          captureRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
            viewportWidth: innerWidth, viewportHeight: innerHeight };
        }
      }
      if (!Number.isFinite(time) || time < 0) throw Error("无法读取当前播放时间，请等待视频加载后重试。");
      const index = kind !== "comment" && hasTranscript ? cueForTime(data!.cues, time) : -1;
      if (kind === "subtitle" && index < 0) throw Error("当前字幕为空，无法添加字幕批注。");
      const cue = index >= 0 ? data!.cues[index] : undefined;
      const next = await request({ type: "video-save", videoKey: target.key, url: pageUrl, title: document.title, favicon: "",
        mark: { kind, time, trackId: cue ? data!.selected : undefined,
          from: cue ? videoCueRef(cue, index) : undefined,
          to: cue ? videoCueRef(cue, index) : undefined,
          text: cue?.text ?? "", note: quickNote, color: library ? initialHighlightColor(library) : "yellow" }, captureRect });
      setLibrary(next); setQuickNote(""); setQuickExpanded(false);
    } catch (error) { setMarkError(String(error)); }
    finally {
      if (resume) {
        if (target.site === "gdcvault") await playerState("resume").catch(() => {});
        else void video(target.site)?.play().catch(() => {});
      }
      if (savedScroll) scrollTo(savedScroll[0], savedScroll[1]);
      setMarkBusy(false);
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
  const followIndex = data?.cues.length ? cueForTime(data.cues, playbackTime) : -1;
  useEffect(() => {
    if (!following || !hasTranscript || collapsed || followIndex < 0) return;
    if (query && !filtered.some(item => item.index === followIndex)) {
      setQuery("");
      return;
    }
    const frame = requestAnimationFrame(() => scrollCue(followIndex, true));
    return () => cancelAnimationFrame(frame);
  }, [following, followIndex, filtered, query, hasTranscript, collapsed, paragraphSeconds]);
  return (
    <section className="transcript" aria-label="LocalMark 字幕列表">
      <header>
        <button
          className="heading"
          aria-expanded={!collapsed}
          onClick={() => {
            if (!collapsed && sourcePopup.current?.matches(":popover-open")) sourcePopup.current.hidePopover();
            setCollapsed(!collapsed);
          }}
        >
          <span>LocalMark</span>
          <span className="chevron">{collapsed ? "+" : "−"}</span>
        </button>
        <button
          className="retry"
          disabled={busy}
          onClick={() => void load(true)}
          title="重新加载字幕"
        >
          重试
        </button>
      </header>
      {!collapsed && (
        <>
          <div className="body-shell">
          {hasTranscript && !!marks.length && <div className="annotation-rail" aria-label="视频标注位置">
            {marks.map(mark => {
              const end = Math.max(data?.cues.at(-1)?.end ?? 1, ...marks.map(item => item.time + 0.01));
              return <button key={mark.id} type="button" style={{ top: `${Math.max(1, Math.min(98, mark.time / end * 100))}%`, background: colorInfo(mark.color).hex }}
                title={`${videoMarkLabel(mark.kind)} ${subtitleTime(mark.time)} ${mark.text.slice(0, 80)} ${mark.note.slice(0, 80)}`}
                aria-label={`滚动到${subtitleTime(mark.time)}的标注`}
                onClick={() => void jumpRail(mark)} />;
            })}
          </div>}
          <div ref={bodyRef} className={`body${following ? " following" : ""}`} aria-busy={busy}>
            {!hasTranscript ? (
              <>
                <div className={`message${error ? " error" : ""}`} role={error ? "alert" : "status"}>
                  <strong>{busy ? loadingStage : error ? "字幕暂不可用" : "当前没有可显示的字幕"}</strong>
                  {error && <><p>{error}</p><button type="button" onClick={() => void load(true)}>重新加载字幕</button></>}
                  <p>仍可按当前播放时间截图、添加关键帧和评论。</p>
                </div>
                <div className="video-point-list" aria-label="视频时间点标注">
                  {[...marks].sort((a, b) => a.time - b.time || a.createdAt.localeCompare(b.createdAt)).map(mark =>
                    <article className="video-point-card" key={mark.id} data-mark-id={mark.id} style={{ "--annotation": colorInfo(mark.color).hex } as React.CSSProperties}>
                      <button type="button" className="video-point-jump" title={`跳转到 ${subtitleTime(mark.time)} 并暂停`}
                        onClick={() => void seek({ start: mark.time, end: mark.time + 0.001, text: "" })}>
                        <span className="video-point-heading">
                          {mark.kind === "screenshot" ? <ScreenshotImage mark={mark} size="comment" /> : <Icon name={mark.kind === "keyframe" ? "bookmark" : "comment"} size={15} />}
                          <strong>{videoMarkLabel(mark.kind)} · {subtitleTime(mark.time)}</strong>
                        </span>
                        {mark.text && <span className="video-point-quote">{mark.text}</span>}
                        {mark.note && <span className="video-point-note">{mark.note}</span>}
                      </button>
                      <button type="button" className="video-point-edit" aria-label={`编辑${videoMarkLabel(mark.kind)}`} disabled={markBusy}
                        onClick={event => editMark(mark, event.clientX, event.clientY)}><Icon name="pen" size={14} /></button>
                      <button type="button" className="video-point-delete" aria-label={`删除${videoMarkLabel(mark.kind)}`} disabled={markBusy}
                        onClick={() => void deleteMark(mark)}><Icon name="trash" size={14} /></button>
                    </article>)}
                </div>
              </>
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
                  marks={marks}
                  trackId={data?.selected ?? ""}
                  onSeek={(cue) => void seek(cue)}
                  onMarkerSeek={(seconds) => void seek({ start: seconds, end: seconds + 0.001, text: "" })}
                  onSelection={(first, last, x, y) => {
                    if (!data) return;
                    setMarkError("");
                    setDraft({ kind: "subtitle", time: first.cue.start, trackId: data.selected,
                      from: videoCueRef(first.cue, first.index), to: videoCueRef(last.cue, last.index),
                      text: data.cues.slice(first.index, last.index + 1).map(cue => cue.text).join(" "),
                      note: "", color: library ? initialHighlightColor(library) : "yellow", x, y, expanded: false,
                      preserveSelection: true });
                  }}
                  onEdit={editMark}
                />
              </>
            )}
          </div>
          </div>
          {seekError && (
            <p className="seek-error" role="alert">
              {seekError}
            </p>
          )}
        </>
      )}
      {!collapsed && <div className="video-quick-tools">
        <button type="button" className={`icon-button locate-button${following ? " following" : ""}${holdingLocate ? " holding" : ""}`}
          aria-label="定位当前播放字幕" aria-pressed={following}
          title={following ? "正在跟随当前字幕；长按 1 秒退出，单击立即定位" : "单击定位当前字幕；长按 1 秒开启持续居中"}
          disabled={busy || !data?.cues.length}
          onPointerDown={event => {
            if (!event.isPrimary || event.button !== 0) return;
            locatePointer.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            startLocateHold();
          }}
          onPointerMove={event => {
            if (locatePointer.current !== event.pointerId) return;
            const rect = event.currentTarget.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
              suppressLocateClick.current = true;
              stopLocateHold();
            }
          }}
          onPointerUp={event => { if (locatePointer.current === event.pointerId) stopLocateHold(); }}
          onPointerCancel={event => {
            if (locatePointer.current === event.pointerId) {
              suppressLocateClick.current = true;
              stopLocateHold();
            }
          }}
          onContextMenu={event => event.preventDefault()}
          onKeyDown={event => {
            if (event.key !== " " && event.key !== "Enter") return;
            event.preventDefault();
            if (!event.repeat) startLocateHold();
          }}
          onKeyUp={event => {
            if (event.key !== " " && event.key !== "Enter") return;
            event.preventDefault();
            const held = suppressLocateClick.current;
            stopLocateHold();
            suppressLocateClick.current = false;
            if (!held) void locatePlaybackCue();
          }}
          onBlur={stopLocateHold}
          onClick={() => {
            if (suppressLocateClick.current) { suppressLocateClick.current = false; return; }
            void locatePlaybackCue();
          }}>
          {(holdingLocate || following) && <svg className="locate-progress" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="11" /></svg>}
          <Icon name="locate" size={17} />
        </button>
        <button type="button" className="icon-button" aria-label="截图并标注" title="截图" disabled={markBusy} onClick={() => void quickSave("screenshot")}><Icon name="image" size={17} /></button>
        <button type="button" className="icon-button" aria-label="添加关键帧" title="关键帧" disabled={markBusy} onClick={() => void quickSave("keyframe")}><Icon name="bookmark" size={17} /></button>
        <div className={`quick-input${quickExpanded ? " expanded" : ""}`}>
          <textarea ref={quickInput} aria-label={hasTranscript ? "当前字幕批注" : "当前视频时间点评论"} aria-keyshortcuts="Shift+Enter" title="在页面按 Shift+Enter 快速输入" placeholder={hasTranscript ? "给当前字幕写批注…" : "给当前视频时间点写评论…"} value={quickNote} rows={1} maxLength={100000}
            onFocus={() => setQuickExpanded(true)} onChange={event => setQuickNote(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void quickSave(hasTranscript ? "subtitle" : "comment"); } }} />
          {quickExpanded && <button type="button" disabled={markBusy || !quickNote.trim()} onClick={() => void quickSave(hasTranscript ? "subtitle" : "comment")}>保存</button>}
        </div>
      </div>}
      {!collapsed && markError && <p className="mark-error" role="alert">{markError}</p>}
      {!collapsed && <footer>
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
          <div className={`tools${searchOpen ? " search-open" : ""}`}>
            <button type="button" className="transcript-download" aria-label="下载视频字幕 Markdown"
              title={hasTranscript ? target.site === "youtube" ? "下载内容转文字与播放器字幕 Markdown" : "下载当前视频的完整字幕 Markdown" : "字幕加载成功后可下载"}
              disabled={!hasTranscript || downloadBusy}
              onClick={() => void downloadCaptions()}>
              <Icon name="download" size={16} />
              <span>{downloadBusy ? "下载中…" : "下载字幕"}</span>
            </button>
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
            <button type="button" className="icon-button theme-toggle"
              aria-label="深色背景" aria-pressed={theme === "dark"}
              title={theme === "dark" ? "切换为白色背景" : "切换为黑色背景"}
              onClick={onToggleTheme}>
              <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
            </button>
          </div>
        <span className="build-version">v{__LOCALMARK_VERSION__}</span>
      </footer>}
      {draft && <div ref={composerRef} popover="manual" className={`video-editor${draft.expanded ? " expanded" : ""}`}
        role="dialog" aria-label={draft.id ? "编辑视频标注" : "新建字幕标注"}
        style={{ left: Math.max(8, Math.min(innerWidth - (draft.expanded ? 350 : 250), draft.x + 8)), top: Math.max(8, Math.min(innerHeight - 190, draft.y + 8)) }}>
        <div className="video-editor-head">
          <div className="video-colors" role="group" aria-label="高亮颜色">
            {(library ? highlightPalette(library) : ["pink", "yellow", "green"] as Color[]).map(color => <button key={color}
              type="button" className={draft.color === color ? "selected" : ""} disabled={markBusy}
              aria-label={colorInfo(color).name} aria-pressed={draft.color === color} title={`${colorInfo(color).name} · 保存标注`}
              style={{ background: colorInfo(color).hex }} onMouseDown={event => event.preventDefault()} onClick={() => void saveDraft(color)} />)}
          </div>
          {draft.old && <button type="button" className="video-delete" disabled={markBusy} onClick={() => void deleteMark(draft.old!)}>删除</button>}
          <button type="button" aria-label="关闭标注窗" disabled={markBusy} onClick={() => setDraft(null)}><Icon name="close" size={15} /></button>
        </div>
        <div className="video-editor-input">
          <textarea ref={draftInput} aria-label="批注" rows={1} maxLength={100000} placeholder="写下你的想法…"
            value={draft.note} onFocus={() => setDraft(current => current ? { ...current, expanded: true } : current)}
            onChange={event => setDraft(current => current ? { ...current, note: event.target.value, expanded: true } : current)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void saveDraft(); } }} />
          {draft.expanded && <button type="button" disabled={markBusy} onClick={() => void saveDraft()}>保存</button>}
        </div>
      </div>}
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
    key = "",
    renderedTheme: VideoTheme | null = null,
    themeOverride: VideoTheme | null = null,
    manuallyChosen = false,
    disposed = false;
  const toggleTheme = () => {
    themeOverride = host?.getAttribute("data-theme") === "dark" ? "light" : "dark";
    manuallyChosen = true;
    update();
    void chrome.storage.local.set({ [THEME_STORAGE_KEY]: themeOverride });
  };
  function clear() {
    root?.unmount();
    host?.remove();
    root = null;
    host = null;
    key = "";
    renderedTheme = null;
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
      // A page sees the shadow host as the target of composed keyboard events.
      // Keep typing keys inside the editor so video-site shortcuts cannot use them.
      const keepTypingInside = (event: KeyboardEvent) => {
        if (event.composedPath().some(node => node instanceof HTMLElement &&
          (node.isContentEditable || node.matches("input, textarea, select"))))
          event.stopPropagation();
      };
      for (const type of ["keydown", "keyup", "keypress"])
        shadow.addEventListener(type, keepTypingInside as EventListener);
      root = createRoot(mount);
      key = target.key;
    }
    const dark =
      target.site === "youtube"
        ? document.documentElement.hasAttribute("dark")
        : document.documentElement.classList.contains("dark") ||
          document.documentElement.getAttribute("data-theme") === "dark";
    const theme: VideoTheme = themeOverride ?? (dark ? "dark" : "light");
    if (host.getAttribute("data-theme") !== theme)
      host.setAttribute("data-theme", theme);
    if (renderedTheme !== theme) {
      root?.render(<Panel key={key} target={target} theme={theme} onToggleTheme={toggleTheme} />);
      renderedTheme = theme;
    }
    if (host.parentElement !== parent || host.nextElementSibling !== before)
      parent.insertBefore(host, before);
  }
  const timer = setInterval(update, 600);
  update();
  void chrome.storage.local.get(THEME_STORAGE_KEY).then(values => {
    if (disposed || manuallyChosen) return;
    const saved = values[THEME_STORAGE_KEY];
    if (saved === "dark" || saved === "light") {
      themeOverride = saved;
      update();
    }
  });
  return () => {
    disposed = true;
    clearInterval(timer);
    clear();
  };
}
