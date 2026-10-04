import { colorInfo } from "./model";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  highlightPalette,
  initialHighlightColor,
  canonicalUrl,
  emptyLibrary,
  pageToolEnabled,
  textLink,
  type MarkAnchor,
  type Color,
  type Library,
  type Mark,
  type Page,
} from "./model";
import { captureSelection, HOST, Painter } from "./anchors";
import { captureElement, locateElement } from "./element-anchors";
import { ElementOverlays, ElementPicker, ElementPickButton, AnnotationVisibilityButton, SidePanelButton } from "./ElementUI";
import { request } from "./protocol";
import { Icon } from "./Icon";
import { Floating, FloatingPresence } from "./Floating";
import style from "./ui.css?inline";
import { type PageInfo, type PageAction } from "./page-bridge";
import { useSidePanelToggle } from "./useSidePanelToggle";
import { mountVideoTranscript } from "./VideoTranscript";
// Embed this content script's build version, even if the extension is later reloaded.
declare const __LOCALMARK_VERSION__: string;
type Draft = {
  anchor: MarkAnchor;
  element?: HTMLElement;
  validateElement?: boolean;
  text?: string;
  note: string;
  color: Color;
  id?: string;
  expectedUpdatedAt?: string;
  expectedMark?: string;
  x: number;
  y: number;
  expanded: boolean;
  url: string;
  preserveSelection?: boolean;
};
const painter = new Painter();
const instance = {
  host: null as HTMLElement | null,
  shadow: null as ShadowRoot | null,
  dispose: () => {},
};
function App() {
  const [lib, setLib] = useState<Library>(emptyLibrary()),
    [url, setUrl] = useState(canonicalUrl(location.href)),
    [draft, setDraft] = useState<Draft | null>(null),
    [hover, setHover] = useState<{
      ids: string[];
      x: number;
      y: number;
    } | null>(null),
    [overlaps, setOverlaps] = useState<{
      ids: string[];
      x: number;
      y: number;
    } | null>(null),
    [rebind, setRebind] = useState<Mark | null>(null),
    [picking, setPicking] = useState(false),
    [libraryReady, setLibraryReady] = useState(false),
    [marksVisible, setMarksVisible] = useState(true),
    [focused, setFocused] = useState<string | undefined>(),
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [geometry, setGeometry] = useState(0);
  const current = Object.values(lib.entries).find(
    (e) => e.page.url === url,
  )?.page;
  // Notes and sync status do not change painted geometry. Snapshots deserialize
  // fresh objects, so object identity would unnecessarily restore every mark.
  const paintKey = useMemo(() => JSON.stringify(current?.annotations.map(
    ({ id, anchor, text, color }) => [id, anchor, text, color],
  )), [current]);
  const commentKey = useMemo(() => JSON.stringify(current?.annotations.map(
    ({ id, note }) => [id, !!note.trim()],
  )), [current]);
  const snapshot = useRef({ lib, current, draft, rebind, url, picking, marksVisible });
  snapshot.current = { lib, current, draft, rebind, url, picking, marksVisible };
  const refreshGeneration = useRef(0),
    elementButtonRef = useRef<HTMLButtonElement>(null),
    hoverPoint = useRef({ x: 0, y: 0 }),
    selectedRange = useRef<Range | null>(null),
    noteRef = useRef<HTMLTextAreaElement>(null),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keepHover = () => { clearTimeout(hoverTimer.current); hoverTimer.current = undefined; };
  const leaveHover = () => {
    if (hoverTimer.current) return;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined;
      setHover(null);
    }, 60);
  };
  const tell = (text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  };
  const sidebar = useSidePanelToggle(tell);
  useLayoutEffect(() => {
    const api = (CSS as unknown as { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } }).highlights;
    const H = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    const range = draft?.preserveSelection && !draft.note ? selectedRange.current : null;
    if (api && H && range?.commonAncestorContainer.isConnected)
      api.set("wc-draft-selection", new H(range));
    else api?.delete("wc-draft-selection");
    return () => api?.delete("wc-draft-selection");
  }, [draft?.anchor, draft?.preserveSelection, !!draft?.note]);
  const showElementButton = pageToolEnabled(lib, "element");
  const showVisibilityButton = pageToolEnabled(lib, "visibility");
  async function load(refresh = false) {
    const g = ++refreshGeneration.current;
    try {
      const next = await request({ type: "snapshot", refresh });
      if (g === refreshGeneration.current) { setLib(next); setLibraryReady(true); }
    } catch (e) {
      tell(String(e));
    }
  }
  const pageInfo = (): PageInfo => ({ ready: true, url: canonicalUrl(location.href), title: document.title,
    favicon: document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href ?? "",
    version: __LOCALMARK_VERSION__, located: painter.orderedIds(), approximate: [...painter.approximate], excerpts: Object.fromEntries(painter.excerpts), picking: snapshot.current.picking });
  const publish = () => { void chrome.runtime.sendMessage({ type: "page-updated", page: pageInfo() }).catch(() => {}); };
  useEffect(() => { publish(); }, [picking]);
  useEffect(() => {
    if (!focused) return;
    const timer = setTimeout(() => setFocused(undefined), 1600);
    return () => clearTimeout(timer);
  }, [focused]);
  function beginPick(mark: Mark | null = null) {
    if (snapshot.current.draft) throw Error("请先保存或取消当前批注，再选择元素。");
    clearTimeout(hoverTimer.current);
    setRebind(mark);
    setHover(null);
    setOverlaps(null);
    setError("");
    getSelection()?.removeAllRanges();
    setPicking(true);
  }
  function cancelPick() { setPicking(false); setRebind(null); }
  function changeMarkVisibility(visible: boolean) {
    clearTimeout(hoverTimer.current);
    setMarksVisible(visible);
    setHover(null);
    setOverlaps(null);
    setFocused(undefined);
  }
  useEffect(() => {
    if (!showElementButton) cancelPick();
    if (!showVisibilityButton) changeMarkVisibility(true);
  }, [showElementButton, showVisibilityButton]);
  function selectElement(element: HTMLElement) {
    try {
      const anchor = captureElement(element);
      const selectionUrl = canonicalUrl(location.href);
      const binding = snapshot.current.url === selectionUrl ? snapshot.current.rebind : null;
      const rect = element.getBoundingClientRect();
      setUrl(selectionUrl);
      setDraft({ anchor, element, validateElement: true, text: binding?.text ?? anchor.exact,
        note: binding?.note ?? "", color: binding?.color ?? initialHighlightColor(snapshot.current.lib),
        id: binding?.id, expectedUpdatedAt: binding?.updatedAt,
        expectedMark: binding ? JSON.stringify(binding) : undefined,
        x: Math.max(12, Math.min(rect.right + 12, innerWidth - 340)),
        y: Math.max(12, Math.min(rect.top, innerHeight - 350)), expanded: true, url: selectionUrl });
      setPicking(false);
      setRebind(null);
    } catch (error) { tell(error instanceof Error ? error.message : String(error)); }
  }
  useEffect(() => {
    // A selection can arrive before the SPA URL poll. Keep a draft captured on
    // the new URL while discarding only drafts belonging to the previous page.
    setDraft((active) => active?.url === url ? active : null);
    setRebind(null);
    setPicking(false);
    setFocused(undefined);
    setMarksVisible(true);
    setHover(null);
    setOverlaps(null);
    painter.clear();
    void load(true);
  }, [url]);
  useEffect(() => {
    const onMessage = (
      m: { type: string } | PageAction,
      sender: chrome.runtime.MessageSender,
      reply: (value: unknown) => void,
    ) => {
      if (sender.id !== chrome.runtime.id) return;
      if (m.type === "changed") void load();
      if (m.type === "ping") {
        setUrl(canonicalUrl(location.href));
        reply(pageInfo());
      }
      if (m.type === "page-action" && "action" in m) {
        if (m.url !== canonicalUrl(location.href)) { reply({ ok: false, error: "页面已切换，请稍后重试。" }); return; }
        if (m.action === "pick-element" || m.action === "cancel-pick") {
          try { m.action === "cancel-pick" ? cancelPick() : beginPick(); reply({ ok: true }); }
          catch (error) { reply({ ok: false, error: String(error) }); }
          return;
        }
        const mark = snapshot.current.current?.annotations.find(a => a.id === m.id);
        if (!mark) { reply({ ok: false, error: "标注已改变，请刷新侧栏后重试。" }); return; }
        if (m.action === "jump" && !painter.jump(mark.id)) { reply({ ok: false, error: "暂未找到原文，请使用重新绑定。" }); return; }
        if (m.action === "jump") setFocused(mark.id);
        if (m.action === "edit") edit(mark);
        if (m.action === "rebind") {
          if (snapshot.current.draft) { reply({ ok: false, error: "请先保存或取消当前批注。" }); return; }
          if (mark.anchor.kind === "element") beginPick(mark);
          else { setRebind(mark); setPicking(false); }
        }
        reply({ ok: true });
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    let paintTimer: ReturnType<typeof setTimeout> | undefined;
    let lastUrl = canonicalUrl(location.href);
    const repaint = () => {
      if (paintTimer) return;
      paintTimer = setTimeout(() => {
        paintTimer = undefined;
        painter.paint(snapshot.current.current?.annotations ?? [], true);
        setGeometry((v) => v + 1);
        publish();
      }, 250);
    };
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (r) =>
            !(
              r.target instanceof Element ? r.target : r.target.parentElement
            )?.closest("#" + HOST),
        )
      ) {
        painter.invalidate();
        repaint();
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    const interval = setInterval(() => {
      if (!chrome.runtime.id || !instance.host?.isConnected) {
        instance.dispose();
        return;
      }
      const next = canonicalUrl(location.href);
      if (next !== lastUrl) {
        lastUrl = next;
        setUrl(next);
        publish();
      }
    }, 500);
    let frame = 0;
    let lastPointer: { x: number; y: number } | null = null;
    const layout = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          setGeometry((v) => v + 1);
          // A scroll can arrive after mousemove (including browser auto-scroll).
          // Recheck the stationary pointer instead of erasing its freshly opened note.
          if (lastPointer) move(new MouseEvent("mousemove", { clientX: lastPointer.x, clientY: lastPointer.y }));
        });
    };
    document.addEventListener("scroll", layout, true);
    window.addEventListener("resize", layout);
    document.addEventListener("load", layout, true);
    let selectionClickPending = false;
    let videoSelectionPending = false;
    const down = (e: MouseEvent) => {
      selectionClickPending = false;
      videoSelectionPending = e.composedPath().some(n => n instanceof Element && n.id === "localmark-video-transcript");
    };
    const up = (e: MouseEvent) => {
      const fromVideoTranscript = videoSelectionPending;
      videoSelectionPending = false;
      if (
        fromVideoTranscript || snapshot.current.picking || snapshot.current.rebind?.anchor.kind === "element" || snapshot.current.draft?.anchor.kind === "element" ||
        e.button !== 0 ||
        e.composedPath().some((n) => n instanceof Element && (n.id === HOST || n.id === "localmark-video-transcript"))
      )
        return;
      const target = e.target as Element;
      if (
        target.closest?.(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
        )
      )
        return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const r = selection.getRangeAt(0).cloneRange();
      if (r.commonAncestorContainer.parentElement?.closest("#" + HOST)) return;
      const captured = captureSelection(r);
      if (!captured) return;
      selectedRange.current = r;
      selectionClickPending = true;
      const a = captured.anchor;
      if (captured.warning) tell(captured.warning);
      const selectionUrl = canonicalUrl(location.href);
      const binding = snapshot.current.url === selectionUrl ? snapshot.current.rebind : null;
      setUrl(selectionUrl);
      setError("");
      setHover(null);
      setOverlaps(null);
      setDraft({
        anchor: a,
        text: binding && binding.text !== binding.anchor.exact ? binding.text : captured.text,
        note: binding?.note ?? "",
        color: binding?.color ?? initialHighlightColor(snapshot.current.lib),
        id: binding?.id,
        expectedUpdatedAt: binding?.updatedAt,
        expectedMark: binding ? JSON.stringify(binding) : undefined,
        x: e.clientX + 8,
        y: e.clientY + 8,
        expanded: !!binding,
        url: selectionUrl,
        preserveSelection: true,
      });
    };
    const move = (e: MouseEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY };
      const pointPath = (skipOverlay = false): EventTarget[] => {
        const path: EventTarget[] = [];
        let element: Element | null = document.elementsFromPoint(e.clientX, e.clientY)
          .find(element => !skipOverlay || element !== instance.host) ?? null;
        while (element) { path.push(element); element = element.parentElement; }
        return path;
      };
      let path = e.composedPath();
      if (!path.length) path = pointPath();
      if (
        !snapshot.current.marksVisible ||
        snapshot.current.picking ||
        snapshot.current.draft
      )
        return;
      let overTooltip = false;
      if (path.some((n) => n instanceof Element && n.id === HOST)) {
        const target = instance.shadow?.elementFromPoint(e.clientX, e.clientY);
        if (target?.closest(".tooltip")) {
          // Fast diagonal motion can catch the previous popup. Keep tracking if
          // the mark is still underneath; otherwise allow reading/scrolling it.
          overTooltip = true;
          path = pointPath(true);
        } else {
          if (target?.closest(".element-note-button, .rail")) keepHover();
          else leaveHover();
          return;
        }
      }
      // Use the actual event path so covered elements do not claim hover.
      // Keep nested marks separate, with the innermost element first.
      const elements = [...painter.elements].filter(([, element]) => path.includes(element))
        .sort((a, b) => path.indexOf(a[1]) - path.indexOf(b[1])).map(([id]) => id);
      const ids = [...painter.hit(e.clientX, e.clientY), ...elements];
      if (!ids.length) {
        if (overTooltip) keepHover();
        else leaveHover();
        return;
      }
      keepHover();
      hoverPoint.current = { x: e.clientX, y: e.clientY };
      // Coordinates go directly to the floating layer; only target changes rerender marks.
      setHover(previous => previous && previous.ids.join(",") === ids.join(",")
        ? previous : { ids, x: e.clientX, y: e.clientY });
    };
    const click = (e: MouseEvent) => {
      // Focusing the note may collapse the page selection before its trailing click.
      if (selectionClickPending) { selectionClickPending = false; return; }
      if (snapshot.current.picking) return;
      if (e.composedPath().some((n) => n instanceof Element && n.id === HOST))
        return;
      if (!getSelection()?.isCollapsed) return;
      const hits = painter.hit(e.clientX, e.clientY);
      if (!hits.length) {
        setHover(null);
        if (snapshot.current.draft?.anchor.kind !== "element") setDraft(null);
        setOverlaps(null);
        return;
      }
      e.preventDefault();
      setOverlaps({
        ids: hits,
        x: e.clientX + 8,
        y: e.clientY + 8,
      });
      setHover(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
        clearTimeout(hoverTimer.current);
        setDraft(null);
        setHover(null);
        setOverlaps(null);
        setRebind(null);
        setPicking(false);
      }
    };
    const leavePage = () => { lastPointer = null; keepHover(); setHover(null); };
    document.addEventListener("mouseleave", leavePage);
    window.addEventListener("blur", leavePage);
    document.addEventListener("mousedown", down, true);
    document.addEventListener("mouseup", up);
    document.addEventListener("mousemove", move);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    return () => {
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {}
      observer.disconnect();
      clearInterval(interval);
      clearTimeout(paintTimer);
      clearTimeout(hoverTimer.current);
      clearTimeout(toastTimer.current);
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", layout, true);
      window.removeEventListener("resize", layout);
      document.removeEventListener("load", layout, true);
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("mouseup", up);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("mouseleave", leavePage);
      window.removeEventListener("blur", leavePage);
      painter.clear();
    };
  }, []);
  useEffect(() => {
    painter.setVisible(marksVisible);
    painter.paint(current?.annotations ?? [], true);
    publish();
    setGeometry((v) => v + 1);
  }, [url, paintKey, marksVisible]);
  useEffect(() => {
    painter.updateCommentIndicators(current?.annotations ?? []);
  }, [url, commentKey]);
  const edit = (m: Mark, x = innerWidth / 2 - 160, y = 100) => {
    clearTimeout(hoverTimer.current);
    setError("");
    setPicking(false);
    setRebind(null);
    setDraft({
      anchor: m.anchor,
      element: painter.elements.get(m.id),
      text: m.text,
      note: m.note,
      color: m.color,
      id: m.id,
      expectedUpdatedAt: m.updatedAt,
      expectedMark: JSON.stringify(m),
      x,
      y,
      expanded: !!m.note,
      url: snapshot.current.url,
    });
    setOverlaps(null);
    setHover(null);
  };
  useEffect(() => {
    if (overlaps?.ids.length === 1) {
      const m = current?.annotations.find((a) => a.id === overlaps.ids[0]);
      if (m) edit(m, overlaps.x, overlaps.y);
    }
  }, [overlaps]);
  async function save(color?: Color) {
    if (!draft || busy) return;
    const d = draft;
    if (d.url !== canonicalUrl(location.href)) {
      setError("页面已改变，请重新选择文字");
      return;
    }
    if (d.anchor.kind === "element" && d.validateElement && locateElement(d.anchor) !== d.element) {
      setError("所选元素已改变，请取消后重新选择。批注内容尚未保存。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await request({
        type: "save",
        url: location.href,
        title: document.title,
        favicon:
          document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href ??
          "",
        imageSource: d.validateElement && d.element instanceof HTMLImageElement
          ? d.element.currentSrc || d.element.src : undefined,
        mark: {
          id: d.id,
          expectedUpdatedAt: d.expectedUpdatedAt,
          expectedMark: d.expectedMark,
          text: d.text ?? d.anchor.exact,
          anchor: d.anchor,
          note: d.note,
          color: color ?? d.color,
        },
      });
      setLib(next);
      setDraft((active) => active === d ? null : active);
      setRebind(null);
      getSelection()?.removeAllRanges();
      tell(next.status);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      if (!d.expanded) tell(message);
      setDraft((current) => current === d ? { ...d, color: color ?? d.color, expanded: true } : current);
    } finally {
      setBusy(false);
    }
  }
  async function remove(p: Page, m: Mark) {
    try {
      const next = await request({
        type: "delete",
        pageId: p.id,
        id: m.id,
        expectedUpdatedAt: m.updatedAt,
        expectedMark: JSON.stringify(m),
      });
      setLib(next);
      setDraft(null);
      tell("已删除标注；" + next.status);
    } catch (e) {
      tell(String(e));
    }
  }
  function jump(p: Page, m: Mark) {
    if (p.url !== url) {
      void request({ type: "open", url: textLink(p, m.anchor) }).catch((e) =>
        tell(String(e)),
      );
      return;
    }
    if (!painter.jump(m.id))
      tell("暂未找到原文。可点击“重新绑定”后选择对应文字。");
    else setFocused(m.id);
  }
  const hoverComments = (hover?.ids ?? []).flatMap(id => {
    const mark = current?.annotations.find(annotation => annotation.id === id);
    return mark ? [mark] : [];
  });
  return (
    <>
      {libraryReady && <div className="page-tools" role="group" aria-label="网页工具">
      {showVisibilityButton && <AnnotationVisibilityButton visible={marksVisible} toggle={() => changeMarkVisibility(!marksVisible)} />}
      {showElementButton && <ElementPickButton picking={picking} toggle={() => {
        try { picking ? cancelPick() : beginPick(); }
        catch (error) { tell(error instanceof Error ? error.message : String(error)); }
      }} />}
      {pageToolEnabled(lib, "sidebar") && <SidePanelButton {...sidebar} />}
      </div>}
      {marksVisible && !picking && <ElementOverlays focused={focused}
        hovered={!draft && !overlaps ? hover?.ids : []} buttonRef={elementButtonRef}
        keepHover={keepHover} leaveHover={leaveHover}
        items={(current?.annotations ?? []).flatMap(m => {
          const element = painter.elements.get(m.id);
          return element && draft?.id !== m.id ? [{ id: m.id, element, color: m.color, label: m.text }] : [];
        })}
        edit={(id, x, y) => { const mark = current?.annotations.find(m => m.id === id); if (mark) edit(mark, x, y); }} />}
      {draft?.anchor.kind === "element" && draft.element && <ElementOverlays preview items={[
        { id: "draft", element: draft.element, color: draft.color },
      ]} />}
      {picking && <ElementPicker color={rebind?.color ?? initialHighlightColor(lib)} select={selectElement} cancel={cancelPick} />}
      {marksVisible && <div
        className="rail"
        style={{ left: "2px" }}
        data-geometry={geometry}
      >
        {current?.annotations.map((m) => {
          const range = painter.target(m.id);
          if (!range) return null;
          const top = Math.max(
            0,
            Math.min(
              100,
              ((range.getBoundingClientRect().top + scrollY) /
                Math.max(document.documentElement.scrollHeight, 1)) *
                100,
            ),
          );
          return (
            <button
              key={m.id}
              aria-label={"定位：" + m.text.slice(0, 25)}
              style={{ top: top + "%", background: colorInfo(m.color).hex }}
              onMouseEnter={(e) => {
                if (draft || picking) return;
                keepHover();
                hoverPoint.current = { x: e.clientX, y: e.clientY };
                setHover({ ids: [m.id], x: e.clientX, y: e.clientY });
              }}
              onMouseMove={e => { hoverPoint.current = { x: e.clientX, y: e.clientY }; }}
              onMouseLeave={leaveHover}
              onFocus={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                keepHover();
                hoverPoint.current = { x: rect.right, y: rect.top };
                setHover({ ids: [m.id], x: rect.right, y: rect.top });
              }}
              onBlur={() => setHover(null)}
              onClick={() => jump(current, m)}
            />
          );
        })}
      </div>}
      {rebind && !draft && !picking && (
        <div className="rebind row">
          请在原文重新选中这条标注对应的文字
          <button onClick={() => setRebind(null)}>取消</button>
        </div>
      )}
      <FloatingPresence>{draft && (
        <Floating className="editor" x={draft.x} y={draft.y}
          focusRef={noteRef} draggable positionKey={draft.anchor}>
          <div className={"annotation-composer" + (draft.expanded ? " composer-expanded" : "")}
            role="dialog" aria-label={draft.id ? "编辑标注" : "新建标注"}
            onKeyDown={event => event.stopPropagation()}>
            <div className="editor-header" data-floating-drag-handle title="按住空白处拖动浮窗">
              <div className="colors" role="group" aria-label="高亮颜色">
                {(draft.id && !highlightPalette(lib).includes(draft.color)
                  ? [...highlightPalette(lib), draft.color] : highlightPalette(lib)).map(color => (
                  <button key={color} type="button" disabled={busy}
                    title={colorInfo(color).name + " · 点击保存高亮和批注"}
                    aria-label={colorInfo(color).name} aria-pressed={draft.color === color}
                    className={"swatch " + (draft.color === color ? "selected" : "")}
                    style={{ "--mark": colorInfo(color).hex } as React.CSSProperties}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => void save(color)} />
                ))}
              </div>
              <span className="composer-grip" aria-hidden="true" />
              {draft.id && current && <button className="danger composer-delete" disabled={busy} onClick={() => {
                const mark = current.annotations.find(mark => mark.id === draft.id);
                if (mark) void remove(current, mark);
              }}>删除</button>}
              <button aria-label="关闭编辑窗" disabled={busy} onClick={() => setDraft(null)}>
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className="composer-input">
            <textarea ref={noteRef} id="wc-note" aria-label="批注" rows={1} maxLength={100000}
              placeholder="写下你的想法…" value={draft.note} disabled={busy}
              onClick={() => setDraft({ ...draft, expanded: true })}
              onChange={event => setDraft({ ...draft, note: event.target.value, expanded: true, preserveSelection: false })}
              onCopy={event => {
                const input = event.currentTarget;
                if (!draft.preserveSelection || draft.note || input.selectionStart !== input.selectionEnd) return;
                event.preventDefault();
                event.clipboardData.setData("text/plain", draft.text ?? draft.anchor.exact);
              }}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault(); void save();
                }
              }} />
            {draft.expanded && <button disabled={busy} className="primary composer-save" aria-busy={busy}
              onClick={() => void save()}>保存</button>}
            </div>
            {error && <p className="error" role="alert">{error}</p>}
          </div>
        </Floating>
      )}</FloatingPresence>
      <FloatingPresence>{overlaps && overlaps.ids.length > 1 && (
        <Floating className="overlaps" x={overlaps.x} y={overlaps.y}>
          <b>此处有 {overlaps.ids.length} 条重叠标注</b>
          {overlaps.ids.map((id) => {
            const m = current?.annotations.find((m) => m.id === id);
            return (
              m && (
                <button
                  key={id}
                  onClick={() => edit(m, overlaps.x, overlaps.y)}
                >
                  <span style={{ color: colorInfo(m.color).hex }}>
                    {colorInfo(m.color).name} ·{" "}
                  </span>
                  {m.note || m.text}
                </button>
              )
            );
          })}
        </Floating>
      )}</FloatingPresence>
      <FloatingPresence>{hover && hoverComments.length > 0 && !draft && !overlaps && (
        <Floating
          className="tooltip"
          x={hover.x}
          y={hover.y}
          pointerPosition={hoverPoint}
          positionKey={hover.ids.join(",")}
          onMouseEnter={keepHover}
          onMouseLeave={leaveHover}
        >
          {hoverComments.map(mark => (
            <p key={mark.id} data-hover-mark={mark.id} data-has-comment={!!mark.note.trim()} className="hover-note">
              {mark.note.trim() ? mark.note : "无评论"}
            </p>
          ))}
        </Floating>
      )}</FloatingPresence>
      {toast && (
        <div className="toast" role="status" onClick={() => setToast("")}>
          {toast}
        </div>
      )}
    </>
  );
}
{
  const scope = globalThis as typeof globalThis & {
    __localWebClipperDispose?: () => void;
  };
  scope.__localWebClipperDispose?.();
  // A host surviving an extension reload is not proof of a live content script.
  document.getElementById(HOST)?.remove();
  const host = document.createElement("div");
  instance.host = host;
  host.id = HOST;
  host.style.cssText =
    'all:initial!important;color:#e2e8f0!important;font:14px/1.55 system-ui,"Microsoft YaHei",sans-serif!important;color-scheme:dark!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;';
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: "closed" }),
    sheet = document.createElement("style");
  instance.shadow = shadow;
  sheet.textContent = style;
  shadow.append(sheet);
  const mount = document.createElement("div");
  shadow.append(mount);
  const root = createRoot(mount);
  const disposeTranscript = mountVideoTranscript();
  let disposed = false;
  instance.dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeTranscript();
    root.unmount();
    host.remove();
  };
  scope.__localWebClipperDispose = instance.dispose;
  root.render(<App />);
}
