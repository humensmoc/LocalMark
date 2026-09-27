import { colorInfo } from "./model";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  COLORS,
  DEFAULT_CATEGORIES,
  emptyLibrary,
  compareMarks,
  type Color,
  type Library,
  type Mark,
  type Page,
} from "./model";
import { request, type Request } from "./protocol";
import { TagBrowser, type TagFilter } from "./TagBrowser";
import { TagFilters, matchesTagFilter } from "./TagFilters";
import { PageTags } from "./PageTags";
import { PageCategory } from "./PageCategory";
import { PageComment, type CommentDraft } from "./PageComment";
import { PageRating } from "./PageRating";
import { PageTitle, type TitleDraft } from "./PageTitle";
import { SiteIcon } from "./SiteIcon";
import { Icon } from "./Icon";
import { MetadataImport } from "./MetadataImport";
import { useDashboardLayout } from "./DashboardLayout";
import { TaxonomyManager } from "./TaxonomyManager";
import { BulkToolbar } from "./BulkToolbar";
import { taxonomyToken } from "./taxonomy";
import { LIBRARY_VIEWS, LibraryNavigation, CatalogGrid, CatalogDetail, ContentCollection, catalogItems, changedDescription, matchesContent, type LibraryView, type CatalogKind, type DescriptionDraft } from "./LibraryViews";
import "./ui.css";
import "./dashboard.css";

declare const __LOCALMARK_VERSION__: string;

type MarkDraft = { base: Mark; text: string; note: string; color: Color };
const changedMark = (d: MarkDraft) =>
  d.text !== d.base.text || d.note !== d.base.note || d.color !== d.base.color;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Dashboard() {
  const layout = useDashboardLayout();
  const [lib, setLib] = useState<Library>(emptyLibrary());
  const [selectedId, setSelectedId] = useState("");
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [multiSelect, setMultiSelect] = useState(false);
  const [managing, setManaging] = useState<false | "manage" | "create">(false);
  const [view, setView] = useState<LibraryView>("pages");
  const [catalogId, setCatalogId] = useState("");
  const [descriptions, setDescriptions] = useState<Record<string, DescriptionDraft>>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TagFilter>({ category: "", tags: [] });
  const [contentFilter, setContentFilter] = useState<TagFilter>({ category: "", tags: [] });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [comments, setComments] = useState<Record<string, CommentDraft>>({});
  const [titles, setTitles] = useState<Record<string, TitleDraft>>({});
  const [marks, setMarks] = useState<Record<string, MarkDraft>>({});
  const detail = useRef<HTMLElement>(null);
  const pending = useRef(0);
  const [saving, setSaving] = useState(false);
  const unsaved =
    Object.values(descriptions).some(changedDescription) ||
    Object.values(titles).some((d) => d.value !== d.base) ||
    Object.values(comments).some((d) => d.value !== d.base) ||
    Object.values(marks).some(changedMark);
  async function mutate(m: Request) {
    pending.current++;
    setSaving(true);
    try {
      setLib(await request(m));
    } finally {
      pending.current--;
      setSaving(pending.current > 0);
    }
  }
  async function refresh() {
    setLoading(true);
    try {
      setLib(await request({ type: "snapshot", refresh: true }));
      setError("");
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let alive = true;
    const load = (refresh = false) =>
      request({ type: "snapshot", refresh })
        .then((next) => {
          if (alive) setLib(next);
        })
        .catch((e) => {
          if (alive) setError(message(e));
        });
    void load(true);
    const listener = (m: { type: string }) => {
      if (m.type === "changed") void load();
    };
    const focus = () => {
      void load(true);
    };
    chrome.runtime.onMessage.addListener(listener);
    window.addEventListener("focus", focus);
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, 15000);
    return () => {
      alive = false;
      chrome.runtime.onMessage.removeListener(listener);
      window.removeEventListener("focus", focus);
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (unsaved || saving) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [unsaved, saving]);
  useEffect(() => {
    detail.current?.scrollTo(0, 0);
  }, [selectedId]);
  useEffect(() => { setCheckedIds([]); }, [query, filter.category, JSON.stringify(filter.tags)]);
  useEffect(() => {
    if (!lib.taxonomy) return;
    setContentFilter(old => {
      const next = { category: lib.taxonomy!.categories.some(item => item.id === old.category) ? old.category : "",
        tags: old.tags.filter(id => lib.taxonomy!.tags.some(item => item.id === id)) };
      return JSON.stringify(old) === JSON.stringify(next) ? old : next;
    });
    setFilter(old => {
      const next = { category: lib.taxonomy!.categories.some(x => x.id === old.category) ? old.category : "",
        tags: old.tags.filter(id => lib.taxonomy!.tags.some(x => x.id === id)) };
      return JSON.stringify(next) === JSON.stringify(old) ? old : next;
    });
  }, [taxonomyToken(lib)]);
  const pages = Object.values(lib.entries)
    .map((e) => e.page)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const tagCounts = new Map<string, number>(),
    categoryCounts = new Map<string, number>();
  for (const p of pages) {
    categoryCounts.set(p.category, (categoryCounts.get(p.category) ?? 0) + 1);
    for (const tag of new Set(p.tags))
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const categories = [
    ...new Set([...(lib.taxonomy?.categories.map(x => x.name) ?? DEFAULT_CATEGORIES), ...categoryCounts.keys()]),
  ];
  const tags = [...new Set([...(lib.taxonomy?.tags.map(x => x.name) ?? []), ...tagCounts.keys()])].sort(
    (a, b) => tagCounts.get(b)! - tagCounts.get(a)! || a.localeCompare(b),
  );
  const needle = query.trim().toLocaleLowerCase();
  const matches = (p: Page) =>
    [
      p.title,
      p.url,
      p.category,
      p.comment ?? "",
      ...p.tags,
      ...p.annotations.flatMap((m) => [m.text, m.note]),
    ]
      .join("\n")
      .toLocaleLowerCase()
      .includes(needle);
  const selected = lib.entries[selectedId];
  const page = selected?.page;
  const common = page
    ? { url: page.url, title: page.title, favicon: page.favicon }
    : null;
  const catalogKind = (["categories", "tags", "colors"].includes(view) ? view : null) as CatalogKind | null;
  const catalogItem = catalogKind ? catalogItems(lib, catalogKind).find(x => x.id === catalogId) : undefined;
  const aggregate = view === "highlights";
  const contentPages = pages.filter(p => p.annotations.length > 0);
  const viewInfo = LIBRARY_VIEWS.find(x => x.id === view)!;
  function changeView(next: LibraryView) { setView(next); setQuery(""); setCatalogId(""); setCheckedIds([]); setMultiSelect(false); }
  function openSource(p: Page) { setView("pages"); setQuery(""); setFilter({ category: "", tags: [] }); setSelectedId(p.id); }
  const navigation = <LibraryNavigation view={view} lib={lib} change={changeView} />;
  const sidebarFooter = <div className="library-sidebar-footer">本地摘录 <span>v{__LOCALMARK_VERSION__}</span></div>;
  function resetComment(id: string, expected?: CommentDraft) {
    setComments((all) => {
      if (expected && all[id] !== expected) return all;
      const next = { ...all };
      delete next[id];
      return next;
    });
  }
  function resetMark(key: string, expected?: MarkDraft) {
    setMarks((all) => {
      if (expected && all[key] !== expected) return all;
      const next = { ...all };
      delete next[key];
      return next;
    });
  }
  function resetTitle(id: string, expected?: TitleDraft) {
    setTitles((all) => {
      if (expected && all[id] !== expected) return all;
      const next = { ...all };
      delete next[id];
      return next;
    });
  }
  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div className="dashboard-brand">
          <Icon name="dashboard" size={22} />
          <h1>本地摘录</h1>
        </div>
        <span className="dashboard-section-name">资料库仪表盘</span>
        <input className="dashboard-search"
          aria-label={view === "pages" ? "搜索文章" : `搜索${viewInfo.label}`}
          placeholder={catalogKind ? "搜索名称或说明…" : "搜索标题、标签、评论或摘录…"}
          value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="dashboard-actions">
          <MetadataImport onImported={result => {
            setLib(result.library);
            const first = result.items.find(item => item.status === "saved" || item.status === "pending");
            if (first?.pageId) { setView("pages"); setQuery(""); setFilter({ category: "", tags: [] }); setSelectedId(first.pageId); }
          }} />
          <button onClick={() => setManaging("manage")}>分类与标签管理</button>
          <button disabled={loading} onClick={() => void refresh()}>
            <Icon name="refresh" size={16} />
            {loading ? "读取中…" : "刷新本地数据"}
          </button>
          <button
            onClick={() =>
              void request({ type: "settings" }).catch((e) =>
                setError(message(e)),
              )
            }
          >
            <Icon name="settings" size={16} />
            设置
          </button>
        </div>
      </header>
      {error && (
        <p className="dashboard-error error" role="alert">
          {error}
        </p>
      )}
      {lib.taxonomyIssue && <p className="error" role="alert">{lib.taxonomyIssue} <button onClick={() => setManaging("manage")}>处理分类数据冲突</button></p>}
      {managing && <TaxonomyManager lib={lib} mutate={mutate} close={() => setManaging(false)} initialKind={view === "tags" ? "tags" : "categories"} initialId={catalogId} createOnly={managing === "create"} />}
      <div
        id="articles-panel"
        className={`dashboard-workspace ${aggregate ? "aggregate-workspace" : ""}`}
        ref={layout.workspace}
        style={layout.style}
      >
        {view === "pages" ? <section className="dashboard-browser" aria-label="筛选与文章列表">
          <TagBrowser
            navigation={navigation}
            sidebarFooter={sidebarFooter}
            taxonomy={lib.taxonomy}
            selection={multiSelect ? { ids: checkedIds, toggle: id => setCheckedIds(old => old.includes(id) ? old.filter(x => x !== id) : [...old, id]) } : undefined}
            selectionControls={summary => <BulkToolbar key={JSON.stringify([query, filter])} summary={summary} lib={lib} selected={checkedIds}
              active={multiSelect} toggleMode={() => { setMultiSelect(old => !old); setCheckedIds([]); }}
              visible={pages.filter(p => matches(p) && (!filter.category || p.categoryId === filter.category) && filter.tags.every(id => p.tagIds?.includes(id)))}
              select={setCheckedIds} mutate={mutate} />}
            pages={pages}
            categories={categories}
            tags={tags}
            filter={filter}
            change={setFilter}
            query={query}
            matches={matches}
            selectedId={selectedId}
            compactCards
            filterDivider={layout.filterDivider}
            open={(p) => setSelectedId(p.id)}
          />
        </section> : <section className="dashboard-browser library-browser" aria-label={`${viewInfo.label}列表`}>
          <aside className="library-rail">{navigation}{sidebarFooter}</aside>
          {layout.filterDivider}
          {catalogKind ? <CatalogGrid lib={lib} kind={catalogKind} query={query} selected={catalogId} choose={setCatalogId} manage={() => setManaging("create")} />
            : <div className="aggregate-content">
              <TagFilters pages={contentPages} categories={categories} tags={tags} filter={contentFilter}
                change={setContentFilter} taxonomy={lib.taxonomy}
                matches={p => p.annotations.some(mark => matchesContent(p, mark, query))}
                title="筛选高亮" storageKey="localmark.filters.dashboard.highlights" />
              <ContentCollection key={`${query}:${JSON.stringify(contentFilter)}`}
                pages={contentPages.filter(p => matchesTagFilter(p, contentFilter, lib.taxonomy))} query={query} open={openSource}
                filtered={!!contentFilter.category || contentFilter.tags.length > 0} />
            </div>}
        </section>}
        {!aggregate && layout.detailDivider}
        {!aggregate && (catalogKind ? <section className="dashboard-detail" aria-label="内容详情">
          {catalogItem ? <CatalogDetail key={`${catalogKind}:${catalogId}`} lib={lib} kind={catalogKind} item={catalogItem}
            draft={descriptions[`${catalogKind}:${catalogId}`]} change={draft => setDescriptions(all => ({ ...all, [`${catalogKind}:${catalogId}`]: draft }))}
            reset={expected => setDescriptions(all => {
              const key = `${catalogKind}:${catalogId}`;
              if (expected && all[key] !== expected) return all;
              const next = { ...all }; delete next[key]; return next;
            })} mutate={mutate} open={openSource} manage={() => setManaging("manage")} browse={() => {
              setView("pages"); setQuery(""); setSelectedId("");
              setFilter(catalogKind === "categories" ? { category: catalogId, tags: [] } : { category: "", tags: [catalogId] });
            }} /> : <div className="dashboard-empty"><Icon name={viewInfo.icon} size={36} /><h2>选择一个{viewInfo.label === "颜色" ? "颜色" : viewInfo.label}</h2><p>查看关联内容，写下你的理解与说明。</p></div>}
        </section> :
        <section
          className="dashboard-detail"
          aria-label="文章详情"
          ref={detail}
        >
          {!page || !common ? (
            <div className="dashboard-empty">
              <Icon name="page" size={36} />
              <h2>{selectedId ? "文章已不在当前数据中" : "选择一篇文章"}</h2>
              <p>
                在中间筛选并选择文章。
                <br />
                这里可以修改评分、标签、评论和高亮批注。
              </p>
            </div>
          ) : (
            <>
              <header className="detail-header page-surface">
                <SiteIcon site={page} backdrop />
                <fieldset className="detail-title" disabled={!!selected.issue}>
                  <PageTitle
                    site={page}
                    key={`title:${page.id}`}
                    title={page.title}
                    savedTitle={page.title}
                    draft={titles[page.id]}
                    change={(draft) =>
                      setTitles((all) => ({ ...all, [page.id]: draft }))
                    }
                    cancel={() => resetTitle(page.id)}
                    save={async (draft) => {
                      await mutate({
                        type: "page-title",
                        ...common,
                        title: draft.value,
                        expectedTitle: draft.base,
                      });
                      resetTitle(page.id, draft);
                    }}
                  />
                </fieldset>
                <div className="detail-source">
                  <span title={page.url}>{page.url}</span>
                  <button
                    onClick={() =>
                      void request({ type: "open", url: page.url }).catch((e) =>
                        setError(message(e)),
                      )
                    }
                  >
                    打开原网页
                    <Icon name="link" size={14} />
                  </button>
                </div>
              </header>
              {selected.issue && (
                <p className="error detail-issue" role="alert">
                  {selected.issue.message}{" "}
                  <button
                    onClick={() =>
                      void request({ type: "settings" }).catch((e) =>
                        setError(message(e)),
                      )
                    }
                  >
                    前往设置处理
                  </button>
                </p>
              )}
              <fieldset className="detail-fields" disabled={!!selected.issue}>
                <PageRating
                  key={`rating:${page.id}`}
                  rating={page.rating}
                  refresh={refresh}
                  change={(rating) => mutate({ type: "page-rating", ...common, rating, expectedRating: page.rating ?? null })}
                />
                <PageCategory
                  key={`category:${page.id}`}
                  category={page.category}
                  categories={categories}
                  counts={categoryCounts}
                  browse={(category) => {
                    setQuery("");
                    setFilter({ category: lib.taxonomy?.categories.find(x => x.name === category)?.id ?? category, tags: [] });
                  }}
                  change={(category) =>
                    mutate({
                      type: "page-category",
                      ...common,
                      category,
                      categoryId: lib.taxonomy?.categories.find(x => x.name === category)?.id,
                      expectedTaxonomy: taxonomyToken(lib),
                      expectedCategory: page.category,
                    })
                  }
                />
                <PageTags
                  key={`tags:${page.id}`}
                  tags={page.tags}
                  allTags={tags}
                  counts={tagCounts}
                  browse={(tag) => {
                    setQuery("");
                    setFilter({ category: "", tags: [lib.taxonomy?.tags.find(x => x.name === tag)?.id ?? tag] });
                  }}
                  change={(tag, action) =>
                    mutate({ type: "page-tag", ...common, tag, action, tagId: lib.taxonomy?.tags.find(x => x.name === tag)?.id, expectedTaxonomy: taxonomyToken(lib) })
                  }
                />
                <PageComment
                  key={`comment:${page.id}`}
                  comment={page.comment ?? ""}
                  draft={comments[page.id]}
                  change={(d) =>
                    setComments((all) => ({ ...all, [page.id]: d }))
                  }
                  reset={() => {
                    resetComment(page.id);
                    void refresh();
                  }}
                  save={async (draft) => {
                    await mutate({
                      type: "page-comment",
                      ...common,
                      comment: draft.value,
                      expectedComment: draft.base,
                    });
                    resetComment(page.id, draft);
                  }}
                />
                <div className="detail-section-heading">
                  <h3>高亮与批注</h3>
                  <small>{page.annotations.length} 条摘录</small>
                </div>
                {!page.annotations.length && (
                  <p className="detail-no-marks">
                    暂无高亮。需要新增摘录时，打开原网页选择文字。
                  </p>
                )}
                {page.annotations
                  .slice()
                  .sort(compareMarks)
                  .map((mark) => {
                    const key = `${page.id}:${mark.id}`;
                    return (
                      <MarkEditor
                        key={key}
                        mark={mark}
                        draft={marks[key]}
                        change={(d) =>
                          setMarks((all) => ({ ...all, [key]: d }))
                        }
                        reset={() => resetMark(key)}
                        save={async (d) => {
                          const anchor = d.base.anchor;
                          await mutate({
                            type: "save",
                            ...common,
                            mark: {
                              id: mark.id,
                              text: d.text,
                              note: d.note,
                              color: d.color,
                              anchor,
                              expectedUpdatedAt: d.base.updatedAt,
                              expectedMark: JSON.stringify(d.base),
                            },
                          });
                          resetMark(key, d);
                        }}
                        remove={async (base) => {
                          await mutate({
                            type: "delete",
                            pageId: page.id,
                            id: base.id,
                            expectedUpdatedAt: base.updatedAt,
                            expectedMark: JSON.stringify(base),
                          });
                          resetMark(key);
                        }}
                      />
                    );
                  })}
              </fieldset>
            </>
          )}
        </section>)}
      </div>
      <footer className="dashboard-footer">
        <span className="dashboard-version">v{__LOCALMARK_VERSION__}</span>
        {unsaved && <span className="draft-status">有未保存草稿</span>}
        <span title={lib.directoryName}>
          目录：{lib.directoryName ?? "未连接"}
        </span>
        <span role="status">{saving ? "正在保存…" : lib.status}</span>
      </footer>
    </main>
  );
}

function MarkEditor({
  mark,
  draft,
  change,
  reset,
  save,
  remove,
}: {
  mark: Mark;
  draft?: MarkDraft;
  change: (d: MarkDraft) => void;
  reset: () => void;
  save: (d: MarkDraft) => Promise<void>;
  remove: (base: Mark) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const d = draft ?? {
    base: mark,
    text: mark.text,
    note: mark.note,
    color: mark.color,
  };
  const changed = changedMark(d),
    stale = JSON.stringify(d.base) !== JSON.stringify(mark);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (!draft)
    return (
      <article
        className="mark-editor mark-preview"
        aria-label={mark.anchor.kind === "element" ? "元素标注" : "高亮摘录"}
        style={{ "--mark": colorInfo(mark.color).hex } as React.CSSProperties}
      >
        <div className="mark-preview-heading">
          {mark.anchor.kind === "element" && <small className="element-kind">元素 · {mark.anchor.tag}</small>}
          <blockquote>{mark.text}</blockquote>
          <button
            aria-label={mark.anchor.kind === "element" ? "编辑元素标注" : "编辑高亮"}
            onClick={() => {
              setError("");
              change(d);
            }}
          >
            编辑
          </button>
        </div>
        {mark.note.trim() && <p className="mark-preview-note">{mark.note}</p>}
      </article>
    );
  return (
    <article
      className="mark-editor"
      style={{ "--mark": colorInfo(d.color).hex } as React.CSSProperties}
      aria-label="编辑高亮"
    >
      <fieldset disabled={busy}>
        <label>
          高亮原文
          <textarea
            aria-label="高亮原文"
            autoFocus
            rows={2}
            maxLength={100000}
            value={d.text}
            onChange={(e) => change({ ...d, text: e.target.value })}
          />
        </label>
        {d.text !== d.base.text && (
          <small className="excerpt-hint">
            仅修改摘录展示文字，原文定位保持不变。
          </small>
        )}
        <div className="row colors" role="group" aria-label="高亮颜色">
          {[...new Set<Color>([d.color, ...Object.keys(COLORS) as Color[]])].map(color => [color, colorInfo(color)] as const).map(([color, value]) => (
            <button
              key={color}
              className={`swatch${d.color === color ? " selected" : ""}`}
              aria-label={value.name}
              aria-pressed={d.color === color}
              style={{ background: value.hex }}
              onClick={() => change({ ...d, color: color as Color })}
            />
          ))}
        </div>
        <label>
          批注
          <textarea
            aria-label="批注"
            rows={2}
            maxLength={100000}
            placeholder="写下对这段原文的想法…"
            value={d.note}
            onChange={(e) => change({ ...d, note: e.target.value })}
          />
        </label>
        <div className="row spread wrap">
          <button
            className="danger"
            onClick={() => {
              if (window.confirm("删除这条高亮及批注？"))
                void run(() => remove(d.base));
            }}
          >
            删除高亮
          </button>
          <div className="row">
            {draft && (
              <button
                onClick={() => {
                  reset();
                  setError("");
                }}
              >
                取消编辑
              </button>
            )}
            <button
              className="primary"
              disabled={!changed || !d.text.trim()}
              onClick={() => void run(() => save(d))}
            >
              {busy ? "保存中…" : "保存高亮"}
            </button>
          </div>
        </div>
        {(stale || error) && (
          <p className="error" role="alert">
            {error ||
              "这条高亮已有更新，当前草稿仍保留。请复制需要的内容，再取消编辑以读取最新版本。"}
          </p>
        )}
      </fieldset>
    </article>
  );
}

createRoot(document.getElementById("root")!).render(<Dashboard />);
