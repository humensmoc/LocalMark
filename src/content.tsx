import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  COLORS,
  DEFAULT_CATEGORY,
  DEFAULT_CATEGORIES,
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
import { TagBrowser, type TagFilter } from "./TagBrowser";
import { PageTags } from "./PageTags";
import { PageCategory } from "./PageCategory";
import { PageComment, type CommentDraft } from "./PageComment";
import style from "./ui.css?inline";
type Draft = {
  anchor: Anchor;
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
    [open, setOpen] = useState(false),
    [tab, setTab] = useState<"recent" | "tags" | "current">("current"),
    [search, setSearch] = useState(""),
    [commentDrafts, setCommentDrafts] = useState<Record<string, CommentDraft>>({}),
    [filter, setFilter] = useState<TagFilter>({ category: "", tags: [] }),
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
  async function openSettings() {
    try {
      await request({ type: "settings" });
    } catch (e) {
      tell(
        `无法打开设置：${e instanceof Error ? e.message : String(e)}。请右键浏览器工具栏中的插件图标，选择“选项”；更新插件后请刷新当前网页。`,
      );
    }
  }
  useEffect(() => {
    setDraft(null);
    setRebind(null);
    setHover(null);
    setOverlaps(null);
    painter.clear();
    void load(true);
  }, [url]);
  useEffect(() => {
    const onMessage = (
      m: { type: string },
      _sender: chrome.runtime.MessageSender,
      reply: (value: unknown) => void,
    ) => {
      if (m.type === "changed") void load();
      if (m.type === "toggle" || m.type === "show") {
        setOpen((v) => m.type === "show" || !v);
        void load(true);
      }
      if (["ping", "toggle", "show", "changed"].includes(m.type))
        reply({ ready: true });
    };
    chrome.runtime.onMessage.addListener(onMessage);
    let paintTimer: ReturnType<typeof setTimeout>;
    let lastUrl = canonicalUrl(location.href);
    const repaint = () => {
      clearTimeout(paintTimer);
      paintTimer = setTimeout(() => {
        painter.paint(snapshot.current.current?.annotations ?? []);
        setGeometry((v) => v + 1);
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
      const binding = snapshot.current.rebind;
      setError("");
      setHover(null);
      setOverlaps(null);
      setDraft({
        anchor: a,
        note: binding?.note ?? "",
        color: binding?.color ?? snapshot.current.lib.lastColor,
        id: binding?.id,
        expectedUpdatedAt: binding?.updatedAt,
        expectedMark: binding ? JSON.stringify(binding) : undefined,
        x: e.clientX + 8,
        y: e.clientY + 8,
        expanded: !!binding,
        url: snapshot.current.url,
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
      if (
        e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "b" &&
        !e.isComposing
      ) {
        const focus = instance.shadow?.activeElement ?? document.activeElement;
        if (
          focus instanceof HTMLElement &&
          (focus.matches("input,textarea,select") || focus.isContentEditable)
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) {
          setOpen((v) => !v);
          void load(true);
        }
        return;
      }
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
    setGeometry((v) => v + 1);
  }, [current]);
  const edit = (m: Mark, x = innerWidth / 2 - 160, y = 100) => {
    setError("");
    setDraft({
      anchor: m.anchor,
      note: m.note,
      color: m.color,
      id: m.id,
      expectedUpdatedAt: m.updatedAt,
      expectedMark: JSON.stringify(m),
      x,
      y,
      expanded: true,
      url,
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
          text: d.anchor.exact,
          anchor: d.anchor,
          note: d.note,
          color: d.color,
        },
      });
      setLib(next);
      setDraft(null);
      setRebind(null);
      getSelection()?.removeAllRanges();
      tell(next.status);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      if (!d.expanded) tell(message);
      setDraft((current) =>
        current ? { ...current, expanded: true } : current,
      );
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
  async function copy(p: Page, m: Mark) {
    const text = textLink(p, m.anchor);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        const input = document.createElement("textarea");
        input.value = text;
        input.style.cssText = "position:fixed;left:-10000px;top:0";
        document.body.append(input);
        input.select();
        const ok = document.execCommand("copy");
        input.remove();
        if (!ok) throw Error("copy failed");
      }
      tell("已复制原文高亮链接（不包含批注）");
    } catch {
      tell("无法访问剪贴板，请允许此网页的剪贴板权限。");
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
  const pages = Object.values(lib.entries)
    .map((e) => e.page)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const query = search.trim().toLocaleLowerCase();
  const matches = (p: Page, m?: Mark) =>
    [
      p.title,
      p.url,
      p.comment ?? "",
      p.category,
      ...p.tags,
      ...(m
        ? [m.text, m.note]
        : p.annotations.flatMap((a) => [a.text, a.note])),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query);
  const card = (p: Page, m: Mark) => (
    <article
      key={m.id}
      className="card current"
      style={{ "--mark": COLORS[m.color].hex } as React.CSSProperties}
    >
      {p.url !== url && (
        <button className="title muted" onClick={() => jump(p, m)}>
          {p.title}
        </button>
      )}
      <div
        className="quote"
        tabIndex={0}
        role="button"
        onClick={() => jump(p, m)}
        onKeyDown={(e) => {
          if (e.key === "Enter") jump(p, m);
        }}
      >
        {m.text}
      </div>
      {m.note && <div className="note">{m.note}</div>}
      <div className="row tools wrap">
        <button title="复制定位链接" onClick={() => void copy(p, m)}>
          <Icon name="link" size={14} />
          链接
        </button>
        {p.url === url && (
          <>
            <button onClick={() => edit(m)}>
              <Icon name="pen" size={14} />
              编辑
            </button>
            {!painter.ranges.has(m.id) && (
              <button
                className="danger"
                onClick={() => {
                  setRebind(m);
                  setDraft(null);
                }}
              >
                未定位 · 重新绑定
              </button>
            )}
          </>
        )}
        <button title="删除标注" onClick={() => void remove(p, m)}>
          <Icon name="trash" size={14} />
        </button>
      </div>
    </article>
  );
  const tagUsage = new Map<string, number>();
  for (const page of pages)
    for (const tag of new Set(page.tags))
      tagUsage.set(tag, (tagUsage.get(tag) ?? 0) + 1);
  const allTags = [...tagUsage.keys()].sort(
    (a, b) => tagUsage.get(b)! - tagUsage.get(a)! || a.localeCompare(b, "zh"),
  );
  const categoryUsage = new Map<string, number>();
  for (const page of pages)
    categoryUsage.set(page.category, (categoryUsage.get(page.category) ?? 0) + 1);
  const allCategories = [...new Set([...DEFAULT_CATEGORIES, ...categoryUsage.keys()])];
  return (
    <>
      {open && (
        <aside className="panel" aria-label="本地摘录侧栏">
          <nav className="tabs">
            {(
              [
                ["recent", "clock", "最近网页"],
                ["tags", "tag", "标签"],
                ["current", "pen", "当前页面"],
              ] as const
            ).map(([key, icon, label]) => (
              <button
                key={key}
                className={tab === key ? "active" : ""}
                onClick={() => setTab(key)}
              >
                <Icon name={icon} size={15} />
                {label}
              </button>
            ))}
            <button className="sidebar-close" aria-label="收起侧栏" title="收起侧栏" onClick={() => setOpen(false)}>
              <Icon name="close" size={14} />
            </button>
          </nav>
          <div className="search">
            <input
              aria-label="搜索摘录"
              placeholder="搜索网页、摘录、评论、批注或标签…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className={tab === "tags" ? "scroll tag-scroll" : "scroll"}>
            {tab === "recent" && (
              <>
                <div className="section-title">
                  最近修改 · {pages.length} 个网页
                </div>
                {pages
                  .filter((p) => matches(p))
                  .map((p) => (
                    <article className="card" key={p.id}>
                      <div className="row">
                        {p.favicon ? (
                          <img
                            className="favicon"
                            src={p.favicon}
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                          />
                        ) : (
                          <Icon name="page" />
                        )}
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <button
                            className="title"
                            onClick={() =>
                              void request({ type: "open", url: p.url }).catch(
                                (e) => tell(String(e)),
                              )
                            }
                          >
                            {p.title}
                          </button>
                          <div className="url">{p.url}</div>
                        </div>
                      </div>
                      {p.comment?.trim() && <div className="note page-comment-preview">{p.comment}</div>}
                      <div className="row wrap" style={{ marginTop: 12 }}>
                        <span className="badge">主分类：{p.category}</span>
                        <span className="badge">
                          {p.annotations.length} 条高亮
                        </span>
                        <span className="badge">
                          {p.annotations.filter((a) => a.note.trim()).length}{" "}
                          条批注
                        </span>
                        <small>
                          {new Date(p.updatedAt).toLocaleDateString()}
                        </small>
                      </div>
                    </article>
                  ))}
              </>
            )}
            {tab === "tags" && (
              <TagBrowser
                pages={pages} categories={allCategories} tags={allTags}
                filter={filter} change={setFilter} query={query} matches={matches}
                open={(p) => void request({ type: "open", url: p.url }).catch(e => tell(String(e)))}
                annotation={card}
              />
            )}
            {tab === "current" && (
              <>
                <div className="page-head">
                  <h3>{current?.title ?? document.title}</h3>
                  <div className="url">{url}</div>
                  <PageCategory
                    key={`category:${url}`}
                    category={current?.category ?? DEFAULT_CATEGORY}
                    categories={allCategories}
                    counts={categoryUsage}
                    browse={(name) => { setSearch(""); setFilter({ category: name, tags: [] }); setTab("tags"); }}
                    change={async (category) => {
                      const next = await request({
                        type: "page-category", url, title: document.title,
                        favicon: document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href ?? "",
                        category, expectedCategory: current?.category ?? DEFAULT_CATEGORY,
                      });
                      setLib(next);
                      tell(next.status);
                    }}
                  />
                  <PageTags
                    key={url}
                    tags={current?.tags ?? []}
                    allTags={allTags}
                    counts={tagUsage}
                    browse={(t) => {
                      setSearch("");
                      setFilter({ category: "", tags: [t] });
                      setTab("tags");
                    }}
                    change={async (tag, action) => {
                      const next = await request({
                        type: "page-tag",
                        url,
                        title: document.title,
                        favicon:
                          document.querySelector<HTMLLinkElement>(
                            'link[rel~="icon"]',
                          )?.href ?? "",
                        tag,
                        action,
                      });
                      setLib(next);
                      tell(next.status);
                    }}
                  />
                  <PageComment
                    key={`comment:${url}`}
                    comment={current?.comment ?? ""}
                    draft={commentDrafts[url]}
                    change={(value) => setCommentDrafts((all) => ({ ...all, [url]: value }))}
                    reset={() => {
                      setCommentDrafts((all) => {
                        const next = { ...all };
                        delete next[url];
                        return next;
                      });
                      void load(true);
                    }}
                    save={async (draft) => {
                      const next = await request({
                        type: "page-comment",
                        url,
                        title: document.title,
                        favicon: document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href ?? "",
                        comment: draft.value,
                        expectedComment: draft.base,
                      });
                      setLib(next);
                      setCommentDrafts((all) => {
                        if (all[url] !== draft) return all;
                        const remaining = { ...all };
                        delete remaining[url];
                        return remaining;
                      });
                      tell(next.status);
                    }}
                  />
                </div>
                {current?.annotations
                  .slice()
                  .sort((a, b) => a.anchor.start - b.anchor.start)
                  .filter((m) => matches(current, m))
                  .map((m) => card(current, m))}
                {!current?.annotations.length && (
                  <div className="empty">
                    <Icon name="pen" size={30} />
                    <p>可以只添加网页标签或评论。</p>
                    <small>需要摘录时，选中网页文字即可高亮。</small>
                    <small>悬停高亮按钮可以添加批注。</small>
                  </div>
                )}
              </>
            )}
            {!pages.length && tab === "recent" && (
              <div className="empty">
                尚未保存网页。
                <br />
                已有 JSON？在设置中连接原文件夹。
              </div>
            )}
          </div>
          <footer className="footer">
            <small className="footer-directory" title={lib.directoryName ? "目录：" + lib.directoryName : "本地文件夹未连接"}>
              {lib.directoryName ? "目录：" + lib.directoryName : "目录未连接"}
            </small>
            <p className="status" role="status" title={lib.status}>{lib.status}</p>
            <button aria-label="打开文章管理" title="打开仪表盘" onClick={() => void request({ type: "dashboard" }).catch(e => tell(String(e)))}>
              <Icon name="dashboard" size={14} />
              仪表盘
            </button>
            <button
              title="目录与同步设置"
              aria-label="目录与同步设置"
              onClick={() => void openSettings()}
            >
              <Icon name="settings" size={14} />
              设置
            </button>
          </footer>
        </aside>
      )}
      <div
        className="rail"
        style={{ left: open ? "min(362px,calc(100vw - 34px))" : "2px" }}
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
      {draft && (
        <Floating
          className={draft.expanded ? "editor" : "quick"}
          x={draft.x}
          y={draft.y}
          onMouseDown={(e) => {
            if (!draft.expanded) e.preventDefault();
          }}
        >
          {!draft.expanded ? (
            <button
              aria-label="高亮选中文字"
              disabled={busy}
              onMouseEnter={() => {
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
          ) : (
            <>
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
                    className={
                      "swatch " + (draft.color === key ? "selected" : "")
                    }
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
                      const m = current.annotations.find(
                        (m) => m.id === draft.id,
                      );
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
            </>
          )}
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
