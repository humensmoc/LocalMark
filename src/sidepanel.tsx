import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  COLORS,
  DEFAULT_CATEGORY,
  DEFAULT_CATEGORIES,
  canonicalUrl,
  emptyLibrary,
  textLink,
  type Library,
  type Mark,
  type Page,
} from "./model";
import { request } from "./protocol";
import { Icon } from "./Icon";
import { TagBrowser, type TagFilter } from "./TagBrowser";
import { taxonomyToken } from "./taxonomy";
import { PageTags } from "./PageTags";
import { PageCategory } from "./PageCategory";
import { PageComment, type CommentDraft } from "./PageComment";
import { PageTitle, type TitleDraft } from "./PageTitle";
import { PageMetadataLocation } from "./PageMetadataLocation";
import { MetadataImport } from "./MetadataImport";
import { SiteIcon } from "./SiteIcon";
import { PageRating, RatingDots } from "./PageRating";
import { ensurePageBridge } from "./toolbar";
import type { PageInfo } from "./page-bridge";
import "./ui.css";
import "./sidepanel.css";
declare const __LOCALMARK_VERSION__: string;
type Drafts = {
  comments: Record<string, CommentDraft>;
  titles: Record<string, TitleDraft>;
};
function App({ windowId, initial }: { windowId: number; initial: Drafts }) {
  const [lib, setLib] = useState<Library>(emptyLibrary()),
    [page, setPage] = useState<PageInfo | null>(null),
    [pageError, setPageError] = useState(""),
    [tab, setTab] = useState<"recent" | "tags" | "current">("current"),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState<TagFilter>({ category: "", tags: [] }),
    [commentDrafts, setCommentDrafts] = useState(initial.comments),
    [titleDrafts, setTitleDrafts] = useState(initial.titles),
    [toast, setToast] = useState("");
  const url = page?.url ?? "";
  useEffect(() => {
    if (!lib.taxonomy) return;
    setFilter(old => {
      const next = { category: lib.taxonomy!.categories.some(x => x.id === old.category) ? old.category : "",
        tags: old.tags.filter(id => lib.taxonomy!.tags.some(x => x.id === id)) };
      return JSON.stringify(next) === JSON.stringify(old) ? old : next;
    });
  }, [taxonomyToken(lib)]);
  const current = Object.values(lib.entries).find(
    (e) => e.page.url === url,
  )?.page;
  const activeTab = useRef<number | undefined>(undefined),
    generation = useRef(0),
    loadGeneration = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const tell = (text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  };
  async function load(refresh = false) {
    const g = ++loadGeneration.current;
    try {
      const next = await request({ type: "snapshot", refresh });
      if (g === loadGeneration.current) setLib(next);
    } catch (e) {
      tell(String(e));
    }
  }
  useEffect(() => {
    void chrome.storage.session
      .set({
        ["sidepanel-drafts:" + windowId]: {
          comments: commentDrafts,
          titles: titleDrafts,
        },
      })
      .catch((e) => tell("草稿暂存失败：" + String(e)));
  }, [commentDrafts, titleDrafts]);
  useEffect(() => {
    let disposed = false;
    async function connect() {
      const g = ++generation.current;
      activeTab.current = undefined;
      setPage(null);
      setPageError("");
      try {
        const [target] = await chrome.tabs.query({ active: true, windowId });
        if (disposed || g !== generation.current) return;
        activeTab.current = target?.id;
        if (!target?.id || !/^https?:\/\//.test(target.url ?? ""))
          throw Error(
            "此页面无法摘录。请切换到普通 HTTP/HTTPS 网页；最近网页和标签仍可使用。",
          );
        const info = await ensurePageBridge(target.id);
        if (!disposed && g === generation.current) {
          setPage(info);
          void load(true);
        }
      } catch (e) {
        if (!disposed && g === generation.current) setPageError(String(e));
      }
    }
    const activated = (info: chrome.tabs.TabActiveInfo) => {
      if (info.windowId === windowId) void connect();
    };
    const updated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (
        id === activeTab.current &&
        (info.url || info.title !== undefined || info.status === "complete")
      )
        void connect();
    };
    const message = (
      m: { type: string; page?: PageInfo },
      sender: chrome.runtime.MessageSender,
    ) => {
      if (sender.id !== chrome.runtime.id) return;
      if (m.type === "changed") void load();
      if (
        m.type === "page-updated" &&
        sender.tab?.id === activeTab.current &&
        m.page
      )
        setPage(m.page);
    };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.runtime.onMessage.addListener(message);
    void load();
    void connect();
    return () => {
      disposed = true;
      generation.current++;
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.runtime.onMessage.removeListener(message);
      clearTimeout(toastTimer.current);
    };
  }, []);
  async function openSettings() {
    try {
      await request({ type: "settings" });
    } catch (e) {
      tell(String(e));
    }
  }
  async function pageAction(action: "jump" | "edit" | "rebind", m: Mark) {
    const id = activeTab.current;
    if (!id || !page) return;
    try {
      const [target] = await chrome.tabs.query({ active: true, windowId });
      if (target?.id !== id || canonicalUrl(target.url ?? "") !== url)
        throw Error("页面已切换，请稍后重试。");
      const reply = await chrome.tabs.sendMessage(
        id,
        { type: "page-action", action, id: m.id, url },
        { frameId: 0 },
      );
      if (!reply?.ok) throw Error(reply?.error ?? "网页未连接，请刷新网页。");
    } catch (e) {
      tell(String(e));
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
    if (p.url === url) void pageAction("jump", m);
    else
      void request({ type: "open", url: textLink(p, m.anchor) }).catch((e) =>
        tell(String(e)),
      );
  }
  const pages = Object.values(lib.entries)
    .map((e) => e.page)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const query = tab === "current" ? "" : search.trim().toLocaleLowerCase();
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
            <button onClick={() => void pageAction("edit", m)}>
              <Icon name="pen" size={14} />
              编辑
            </button>
            {!page?.located.includes(m.id) && (
              <button
                className="danger"
                onClick={() => {
                  void pageAction("rebind", m);
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
  const allTags = [...new Set([...(lib.taxonomy?.tags.map(x => x.name) ?? []), ...tagUsage.keys()])].sort(
    (a, b) => tagUsage.get(b)! - tagUsage.get(a)! || a.localeCompare(b, "zh"),
  );
  const categoryUsage = new Map<string, number>();
  for (const page of pages)
    categoryUsage.set(
      page.category,
      (categoryUsage.get(page.category) ?? 0) + 1,
    );
  const allCategories = [
    ...new Set([...(lib.taxonomy?.categories.map(x => x.name) ?? DEFAULT_CATEGORIES), ...categoryUsage.keys()]),
  ];

  return (
    <>
      <aside className="panel" aria-label="本地摘录侧栏">
        <MetadataImport onImported={result => {
          setLib(result.library);
          if (result.items.some(item => item.status === "saved" || item.status === "pending")) { setSearch(""); setTab("recent"); }
        }} />
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
        </nav>
        {tab !== "current" && <div className="search">
          <input
            aria-label="搜索摘录"
            placeholder="搜索网页、摘录、评论、批注或标签…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>}
        <div className={tab === "tags" ? "scroll tag-scroll" : "scroll"}>
          {tab === "recent" && (
            <>
              <div className="section-title">
                最近修改 · {pages.length} 个网页
              </div>
              {pages
                .filter((p) => matches(p))
                .map((p) => (
                  <article className="card page-surface" key={p.id}>
                    <SiteIcon site={p} backdrop />
                    <div className="row">
                      <SiteIcon site={p} />
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
                        <div className="rated-url"><div className="url">{p.url}</div><RatingDots rating={p.rating} /></div>
                      </div>
                    </div>
                    {p.comment?.trim() && (
                      <div className="note page-comment-preview">
                        {p.comment}
                      </div>
                    )}
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
              taxonomy={lib.taxonomy}
              pages={pages}
              categories={allCategories}
              tags={allTags}
              filter={filter}
              change={setFilter}
              query={query}
              matches={matches}
              open={(p) =>
                void request({ type: "open", url: p.url }).catch((e) =>
                  tell(String(e)),
                )
              }
              annotation={card}
            />
          )}
          {tab === "current" && !page && (
            <div className="page-unavailable" role="status">
              {pageError || "正在连接当前网页…"}
            </div>
          )}
          {tab === "current" && page && (
            <>
              <div className="page-head page-surface">
                <SiteIcon site={{ url, favicon: page.favicon || current?.favicon }} backdrop />
                <PageTitle
                  site={{ url, favicon: page.favicon || current?.favicon }}
                  key={`title:${url}`}
                  title={current?.title ?? page?.title ?? ""}
                  savedTitle={current?.title ?? null}
                  draft={titleDrafts[url]}
                  change={(value) =>
                    setTitleDrafts((all) => ({ ...all, [url]: value }))
                  }
                  cancel={() => {
                    setTitleDrafts((all) => {
                      const next = { ...all };
                      delete next[url];
                      return next;
                    });
                    void load(true);
                  }}
                  save={async (draft) => {
                    const next = await request({
                      type: "page-title",
                      url,
                      title: draft.value,
                      expectedTitle: draft.base,
                      favicon: page?.favicon ?? "",
                    });
                    setLib(next);
                    setTitleDrafts((all) => {
                      if (all[url] !== draft) return all;
                      const remaining = { ...all };
                      delete remaining[url];
                      return remaining;
                    });
                    tell(next.status);
                  }}
                />
                <div className="url">{url}</div>
                <PageMetadataLocation key={`metadata:${url}`} pageId={current?.id} library={lib} tell={tell} />
                <PageRating
                  key={`rating:${url}`}
                  rating={current?.rating}
                  refresh={() => load(true)}
                  change={async (rating) => {
                    const next = await request({ type: "page-rating", url, title: page?.title ?? "", favicon: page?.favicon ?? "",
                      rating, expectedRating: current?.rating ?? null });
                    setLib(next);
                    tell(next.status);
                  }}
                />
                <PageCategory
                  key={`category:${url}`}
                  category={current?.category ?? DEFAULT_CATEGORY}
                  categories={allCategories}
                  counts={categoryUsage}
                  browse={(name) => {
                    setSearch("");
                    setFilter({ category: lib.taxonomy?.categories.find(x => x.name === name)?.id ?? name, tags: [] });
                    setTab("tags");
                  }}
                  change={async (category) => {
                    const next = await request({
                      type: "page-category",
                      url,
                      title: page?.title ?? "",
                      favicon: page?.favicon ?? "",
                      category,
                      categoryId: lib.taxonomy?.categories.find(x => x.name === category)?.id,
                      expectedTaxonomy: taxonomyToken(lib),
                      expectedCategory: current?.category ?? DEFAULT_CATEGORY,
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
                    setFilter({ category: "", tags: [lib.taxonomy?.tags.find(x => x.name === t)?.id ?? t] });
                    setTab("tags");
                  }}
                  change={async (tag, action) => {
                    const next = await request({
                      type: "page-tag",
                      url,
                      title: page?.title ?? "",
                      favicon: page?.favicon ?? "",
                      tag,
                      tagId: lib.taxonomy?.tags.find(x => x.name === tag)?.id,
                      expectedTaxonomy: taxonomyToken(lib),
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
                  change={(value) =>
                    setCommentDrafts((all) => ({ ...all, [url]: value }))
                  }
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
                      title: page?.title ?? "",
                      favicon: page?.favicon ?? "",
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
                  <p>可以只给网页评分、添加标签或评论。</p>
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
              已有 JSON？连接目录后拖入此侧栏即可导入。
            </div>
          )}
        </div>
        <footer className="footer">
          <small
            className="footer-directory"
            title={
              lib.directoryName
                ? "目录：" + lib.directoryName
                : "本地文件夹未连接"
            }
          >
            {lib.directoryName ? "目录：" + lib.directoryName : "目录未连接"}
          </small>
          <p className="status" role="status" title={lib.status}>
            {lib.status}
          </p>
          <button
            aria-label="打开文章管理"
            title="打开仪表盘"
            onClick={() =>
              void request({ type: "dashboard" }).catch((e) => tell(String(e)))
            }
          >
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
          <small
            className="footer-version"
            title="侧栏与当前网页脚本版本相同时合并显示，不同时分别显示；更新扩展后请刷新网页核对"
          >
            {page?.version === __LOCALMARK_VERSION__
              ? `版本 ${__LOCALMARK_VERSION__}`
              : `侧栏 ${__LOCALMARK_VERSION__} · 网页 ${page?.version ?? "未连接"}`}
          </small>
        </footer>
      </aside>
      {toast && (
        <div className="toast" role="status" onClick={() => setToast("")}>
          {toast}
        </div>
      )}
    </>
  );
}
async function main() {
  const window = await chrome.windows.getCurrent();
  if (window.id === undefined) throw Error("无法定位侧栏所属窗口");
  const key = "sidepanel-drafts:" + window.id;
  const stored = await chrome.storage.session.get(key);
  createRoot(document.getElementById("root")!).render(
    <App
      windowId={window.id}
      initial={stored[key] ?? { comments: {}, titles: {} }}
    />,
  );
}
void main().catch((e) => {
  document.getElementById("root")!.textContent = "侧栏加载失败：" + String(e);
});
