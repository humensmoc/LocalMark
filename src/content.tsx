import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  COLORS,
  canonicalUrl,
  emptyLibrary,
  textLink,
  type Anchor,
  type Color,
  type Library,
  type Mark,
  type Page,
} from "./model";
import { capture, HOST, Painter } from "./anchors";
import { request } from "./protocol";
import { Icon } from "./Icon";
import { Floating } from "./Floating";
import style from "./ui.css?inline";
import type { PageInfo, PageAction } from "./page-bridge";
// Embed this content script's build version, even if the extension is later reloaded.
declare const __LOCALMARK_VERSION__: string;
type Draft = {
  anchor: Anchor;
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
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [geometry, setGeometry] = useState(0);
  const current = Object.values(lib.entries).find(
    (e) => e.page.url === url,
  )?.page;
  const snapshot = useRef({ lib, current, draft, rebind, url });
  snapshot.current = { lib, current, draft, rebind, url };
  const refreshGeneration = useRef(0),
    quickRef = useRef<HTMLDivElement>(null),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    expandTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tell = (text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  };
  async function load(refresh = false) {
    const g = ++refreshGeneration.current;
    try {
      const next = await request({ type: "snapshot", refresh });
      if (g === refreshGeneration.current) setLib(next);
    } catch (e) {
      tell(String(e));
    }
  }
  const pageInfo = (): PageInfo => ({ ready: true, url: canonicalUrl(location.href), title: document.title,
    favicon: document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href ?? "",
    version: __LOCALMARK_VERSION__, located: [...painter.ranges.keys()] });
  const publish = () => { void chrome.runtime.sendMessage({ type: "page-updated", page: pageInfo() }).catch(() => {}); };
  useEffect(() => {
    // A selection can arrive before the SPA URL poll. Keep a draft captured on
    // the new URL while discarding only drafts belonging to the previous page.
    setDraft((active) => active?.url === url ? active : null);
    setRebind(null);
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
        const mark = snapshot.current.current?.annotations.find(a => a.id === m.id);
        if (!mark) { reply({ ok: false, error: "标注已改变，请刷新侧栏后重试。" }); return; }
        if (m.action === "jump" && !painter.jump(mark.id)) { reply({ ok: false, error: "暂未找到原文，请使用重新绑定。" }); return; }
        if (m.action === "edit") edit(mark);
        if (m.action === "rebind") { setRebind(mark); setDraft(null); }
        reply({ ok: true });
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    let paintTimer: ReturnType<typeof setTimeout>;
    let lastUrl = canonicalUrl(location.href);
    const repaint = () => {
      clearTimeout(paintTimer);
      paintTimer = setTimeout(() => {
        painter.paint(snapshot.current.current?.annotations ?? []);
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
      )
        repaint();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
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
    const layout = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          setGeometry((v) => v + 1);
          setHover(null);
        });
    };
    document.addEventListener("scroll", layout, true);
    window.addEventListener("resize", layout);
    document.addEventListener("load", layout, true);
    const up = (e: MouseEvent) => {
      if (
        e.button !== 0 ||
        e.composedPath().some((n) => n instanceof Element && n.id === HOST)
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
      const a = capture(r);
      if (!a) return;
      const selectionUrl = canonicalUrl(location.href);
      const binding = snapshot.current.url === selectionUrl ? snapshot.current.rebind : null;
      setUrl(selectionUrl);
      setError("");
      setHover(null);
      setOverlaps(null);
      setDraft({
        anchor: a,
        text: binding && binding.text !== binding.anchor.exact ? binding.text : undefined,
        note: binding?.note ?? "",
        color: binding?.color ?? snapshot.current.lib.lastColor,
        id: binding?.id,
        expectedUpdatedAt: binding?.updatedAt,
        expectedMark: binding ? JSON.stringify(binding) : undefined,
        x: e.clientX + 8,
        y: e.clientY + 8,
        expanded: !!binding,
        url: selectionUrl,
      });
    };
    const move = (e: MouseEvent) => {
      if (
        snapshot.current.draft ||
        e.composedPath().some((n) => n instanceof Element && n.id === HOST)
      )
        return;
      clearTimeout(hoverTimer.current);
      const ids = painter.hit(e.clientX, e.clientY);
      if (!ids.length) {
        hoverTimer.current = setTimeout(() => setHover(null), 180);
        return;
      }
      hoverTimer.current = setTimeout(
        () =>
          setHover({
            ids,
            x: Math.min(e.clientX + 14, innerWidth - 320),
            y: Math.max(10, Math.min(e.clientY + 20, innerHeight - 240)),
          }),
        220,
      );
    };
    const click = (e: MouseEvent) => {
      if (e.composedPath().some((n) => n instanceof Element && n.id === HOST))
        return;
      if (!getSelection()?.isCollapsed) return;
      const hits = painter.hit(e.clientX, e.clientY);
      if (!hits.length) {
        setHover(null);
        setDraft(null);
        setOverlaps(null);
        return;
      }
      e.preventDefault();
      setOverlaps({
        ids: hits,
        x: Math.max(10, Math.min(e.clientX, innerWidth - 350)),
        y: Math.max(10, Math.min(e.clientY, innerHeight - 440)),
      });
      setHover(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDraft(null);
        setHover(null);
        setOverlaps(null);
        setRebind(null);
      }
    };
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
      clearTimeout(expandTimer.current);
      clearTimeout(toastTimer.current);
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", layout, true);
      window.removeEventListener("resize", layout);
      document.removeEventListener("load", layout, true);
      document.removeEventListener("mouseup", up);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      painter.clear();
    };
  }, []);
  useEffect(() => {
    painter.paint(current?.annotations ?? []);
    publish();
    setGeometry((v) => v + 1);
  }, [current]);
  const edit = (m: Mark, x = innerWidth / 2 - 160, y = 100) => {
    setError("");
    setDraft({
      anchor: m.anchor,
      text: m.text,
      note: m.note,
      color: m.color,
      id: m.id,
      expectedUpdatedAt: m.updatedAt,
      expectedMark: JSON.stringify(m),
      x,
      y,
      expanded: true,
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
  async function save() {
    if (!draft || busy) return;
    const d = draft;
    if (d.url !== canonicalUrl(location.href)) {
      setError("页面已改变，请重新选择文字");
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
        mark: {
          id: d.id,
          expectedUpdatedAt: d.expectedUpdatedAt,
          expectedMark: d.expectedMark,
          text: d.text ?? d.anchor.exact,
          anchor: d.anchor,
          note: d.note,
          color: d.color,
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
      setDraft((current) => current === d ? { ...d, expanded: true } : current);
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
  }
  return (
    <>
      <div
        className="rail"
        style={{ left: "2px" }}
        data-geometry={geometry}
      >
        {current?.annotations.map((m) => {
          const range = painter.ranges.get(m.id);
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
              style={{ top: top + "%", background: COLORS[m.color].hex }}
              onMouseEnter={(e) => {
                if (draft) return;
                clearTimeout(hoverTimer.current);
                const rect = e.currentTarget.getBoundingClientRect();
                setHover({ ids: [m.id], x: rect.right + 10, y: rect.top });
              }}
              onMouseLeave={() => {
                hoverTimer.current = setTimeout(() => setHover(null), 180);
              }}
              onFocus={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setHover({ ids: [m.id], x: rect.right + 10, y: rect.top });
              }}
              onBlur={() => setHover(null)}
              onClick={() => jump(current, m)}
            />
          );
        })}
      </div>
      {rebind && !draft && (
        <div className="rebind row">
          请在原文重新选中这条标注对应的文字
          <button onClick={() => setRebind(null)}>取消</button>
        </div>
      )}
      {draft && !draft.id && (
        <Floating
          className="quick"
          elementRef={quickRef}
          x={draft.x}
          y={draft.y}
          onMouseDown={(e) => {
            e.preventDefault();
          }}
        >
          <button
            aria-label="高亮选中文字"
            disabled={busy}
            onMouseEnter={() => {
              if (draft.expanded) return;
              clearTimeout(expandTimer.current);
              expandTimer.current = setTimeout(
                () => setDraft((d) => (d ? { ...d, expanded: true } : d)),
                350,
              );
            }}
            onMouseLeave={() => clearTimeout(expandTimer.current)}
            onClick={() => {
              clearTimeout(expandTimer.current);
              void save();
            }}
          >
            <Icon name="pen" />
          </button>
        </Floating>
      )}
      {draft?.expanded && (
        <Floating
          className="editor"
          x={draft.x}
          y={draft.y}
          anchorRef={draft.id ? undefined : quickRef}
        >
          <div className="row spread">
            <b>{draft.id ? "编辑标注" : "新建标注"}</b>
            <button aria-label="关闭编辑窗" onClick={() => setDraft(null)}>
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="excerpt">{draft.anchor.exact}</div>
          <label>高亮颜色</label>
          <div className="row colors">
            {Object.entries(COLORS).map(([key, c]) => (
              <button
                key={key}
                title={c.name}
                aria-label={c.name}
                aria-pressed={draft.color === key}
                className={"swatch " + (draft.color === key ? "selected" : "")}
                style={{ "--mark": c.hex } as React.CSSProperties}
                onClick={() => setDraft({ ...draft, color: key as Color })}
              />
            ))}
          </div>
          <label htmlFor="wc-note">批注</label>
          <textarea
            id="wc-note"
            placeholder="写下你的想法…"
            value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <div className="hint">Enter 保存 · Shift+Enter 换行</div>
          {error && <p className="error">{error}</p>}
          <div className="row editor-foot">
            {draft.id && current && (
              <button
                className="danger"
                onClick={() => {
                  const m = current.annotations.find((m) => m.id === draft.id);
                  if (m) void remove(current, m);
                }}
              >
                删除
              </button>
            )}
            <button onClick={() => setDraft(null)}>取消</button>
            <button
              disabled={busy}
              className="primary"
              onClick={() => void save()}
            >
              {busy ? "保存中…" : "确认保存"}
            </button>
          </div>
        </Floating>
      )}
      {overlaps && overlaps.ids.length > 1 && (
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
                  <span style={{ color: COLORS[m.color].hex }}>
                    {COLORS[m.color].name} ·{" "}
                  </span>
                  {m.note || m.text}
                </button>
              )
            );
          })}
        </Floating>
      )}
      {hover && !draft && !overlaps && (
        <Floating
          className="tooltip"
          x={hover.x}
          y={hover.y}
          onMouseEnter={() => clearTimeout(hoverTimer.current)}
          onMouseLeave={() => setHover(null)}
        >
          {hover.ids.map((id) => {
            const m = current?.annotations.find((a) => a.id === id);
            return (
              m && (
                <div key={id}>
                  <b style={{ color: COLORS[m.color].hex }}>
                    {COLORS[m.color].name}
                  </b>
                  <p className="hover-quote">{m.text}</p>
                  {m.note && <p className="hover-note">{m.note}</p>}
                </div>
              )
            );
          })}
        </Floating>
      )}
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
  let disposed = false;
  instance.dispose = () => {
    if (disposed) return;
    disposed = true;
    root.unmount();
    host.remove();
  };
  scope.__localWebClipperDispose = instance.dispose;
  root.render(<App />);
}
