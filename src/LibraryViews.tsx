import { colorInfo } from "./model";
import { useState, type CSSProperties } from "react";
import { COLORS, type Color, type Library, type Page, type Mark, type VideoMark } from "./model";
import { SavedImage, ScreenshotGallery } from "./ScreenshotImage";
import { Icon } from "./Icon";
import { SiteIcon } from "./SiteIcon";
import { RatingDots } from "./PageRating";
import { taxonomyToken, UNCATEGORIZED } from "./taxonomy";
import type { Request } from "./protocol";
import { CatalogTreemap } from "./CatalogTreemap";
import { CardFlow } from "./CardFlow";
import { GroupedContent } from "./GroupedContent";
import { PageCard } from "./PageCard";

export const LIBRARY_VIEWS = [
  { id: "pages", label: "网页", icon: "page", hint: "按主分类、评分与子标签筛选收藏，在右侧阅读和编辑。" },
  { id: "categories", label: "主分类", icon: "folder", hint: "梳理收藏的大方向，记录每个分类的含义与收录边界。" },
  { id: "tags", label: "子标签", icon: "tag", hint: "用可跨主分类复用的标签，连接相似的主题与想法。" },
  { id: "highlights", label: "高亮内容", icon: "pen", hint: "按网页分组阅读高亮摘录与对应批注。" },
  { id: "colors", label: "颜色", icon: "palette", hint: "为高亮颜色赋予含义，形成自己的阅读与思考习惯。" },
] as const;
export type LibraryView = typeof LIBRARY_VIEWS[number]["id"];
export type CatalogKind = "categories" | "tags" | "colors";
export type CatalogItem = { id: string; name: string; description: string; count: number; color?: Color };
export type DescriptionDraft = { value: string; base: string; expected: string; name?: string; baseName?: string };
export const changedDescription = (d: DescriptionDraft) => d.value !== d.base || d.name !== d.baseName;

export function catalogItems(lib: Library, kind: CatalogKind): CatalogItem[] {
  const pages = Object.values(lib.entries).map(e => e.page);
  if (kind === "colors") return ([...new Set<Color>([...Object.keys(COLORS) as Color[], ...pages.flatMap(page => [...page.annotations, ...(page.videoMarks ?? [])].map(mark => mark.color)), ...Object.keys(lib.taxonomy?.colorDescriptions ?? {}) as Color[]])]).map(color => ({
    id: color, name: colorInfo(color).name, color,
    description: lib.taxonomy?.colorDescriptions?.[color] ?? "",
    count: pages.reduce((n, p) => n + [...p.annotations, ...(p.videoMarks ?? [])].filter(m => m.color === color).length, 0),
  }));
  return (lib.taxonomy?.[kind] ?? []).map(item => ({ ...item, description: item.description ?? "",
    count: pages.filter(p => kind === "categories" ? p.categoryId === item.id : p.tagIds?.includes(item.id)).length,
  }));
}

export function LibraryNavigation({ view, lib, change }: { view: LibraryView; lib: Library; change: (view: LibraryView) => void }) {
  const pages = Object.values(lib.entries).map(e => e.page);
  const counts = { pages: pages.length, categories: lib.taxonomy?.categories.length ?? 0, tags: lib.taxonomy?.tags.length ?? 0,
    highlights: pages.reduce((n, p) => n + p.annotations.length + (p.videoMarks?.length ?? 0), 0), colors: catalogItems(lib, "colors").length };
  return <nav className="library-navigation" aria-label="资料库视图">
    <small className="rail-label">资料库</small>
    {LIBRARY_VIEWS.map(item => <button key={item.id} aria-current={view === item.id ? "page" : undefined}
      className={view === item.id ? "active" : ""} onClick={() => change(item.id)}>
      <Icon name={item.icon} size={17} /><span>{item.label}</span><small>{counts[item.id]}</small>
    </button>)}
  </nav>;
}

export function CatalogGrid({ lib, kind, query, selected, choose, manage }: {
  lib: Library; kind: CatalogKind; query: string; selected: string; choose: (id: string) => void; manage: () => void;
}) {
  const [views, setViews] = useState<Record<string, string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("localmark.catalog.views") ?? "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    } catch { return {}; }
  });
  const mode = kind !== "colors" && views[kind] === "treemap" ? "treemap" : "cards";
  function changeView(value: string) {
    const next = { ...views, [kind]: value };
    setViews(next);
    try { localStorage.setItem("localmark.catalog.views", JSON.stringify(next)); } catch { /* Keep this window usable without storage. */ }
  }
  const allItems = catalogItems(lib, kind);
  const items = allItems.filter(x => `${x.name}\n${x.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="library-collection">
    <div className="collection-heading"><span>{items.length} 项</span>{kind !== "colors" && <div className="catalog-controls">
      <div className="catalog-view-toggle" role="group" aria-label="展示方式"><button aria-pressed={mode === "cards"} onClick={() => changeView("cards")}>卡片</button><button aria-pressed={mode === "treemap"} onClick={() => changeView("treemap")}>占比图</button></div>
      <button onClick={manage}>新建{kind === "categories" ? "主分类" : "子标签"}</button></div>}</div>
    {mode === "treemap" && kind !== "colors" && !!items.length ? <CatalogTreemap items={items} allItems={allItems} kind={kind} filtered={!!query.trim()} selected={selected} choose={choose} /> : <div className={`catalog-grid${kind === "colors" ? "" : " taxonomy-grid"}`}>
      {items.map(item => <button key={item.id} className={`catalog-card ${selected === item.id ? "selected" : ""}`} aria-pressed={selected === item.id} onClick={() => choose(item.id)}>
        <span className="catalog-card-title">{item.color ? <i className="catalog-color" style={{ background: colorInfo(item.color).hex }} /> : <Icon name={kind === "categories" ? "folder" : "tag"} />}<strong>{item.name}</strong></span>
        <span className={`catalog-description ${item.description ? "" : "muted"}`}>{item.description || "暂无说明"}</span>
        <small>{item.count} {kind === "colors" ? "条高亮" : "个网页"}</small>
      </button>)}
      {!items.length && <div className="collection-empty"><Icon name="tag" size={30} /><h3>{query ? "没有匹配的内容" : "还没有子标签"}</h3><p>{query ? "试试搜索其他名称或说明。" : "创建标签，为不同网页建立共同的主题。"}</p></div>}
    </div>}
  </div>;
}

function Source({ page, open, date }: { page: Page; open: (p: Page) => void; date?: string }) {
  return <button className={`content-source${date ? " dated-source" : ""}`} onClick={() => open(page)} title={`查看网页：${page.title}`}>
    <SiteIcon site={page} /><span>{page.title}<small className="rated-source-meta"><span className="source-host">{new URL(page.url).hostname}</span>{date && <time dateTime={date}>{new Date(date).toLocaleDateString("zh-CN")}</time>}<RatingDots rating={page.rating} /></small></span>{!date && <Icon name="arrow" size={14} />}
  </button>;
}
function ContentTags({ page }: { page: Page }) {
  return <div className="content-page-tags result-taxonomy" aria-label="所属网页标签">
    <span className="result-category">{page.category}</span>
    {page.tags.map(tag => <span className="result-tag" key={tag}>{tag}</span>)}
  </div>;
}
export function HighlightCard({ page, mark, open, showSource = true }: { page: Page; mark: Mark | VideoMark; open: (p: Page) => void; showSource?: boolean }) {
  return <article className="content-card" data-mark-id={mark.id} style={{ "--mark": colorInfo(mark.color).hex } as CSSProperties}>
    {"kind" in mark && mark.kind === "screenshot" && <ScreenshotGallery marks={[mark]} />}
    {!("kind" in mark) && mark.imagePath && <div className="screenshot-gallery" aria-label="已保存的网页图片"><SavedImage mark={mark} /></div>}
    <div className="content-card-body" tabIndex={0} role="region" aria-label="高亮和批注内容">
      {"kind" in mark ? <small className="element-kind">{mark.kind === "subtitle" ? "字幕" : mark.kind === "screenshot" ? "截图" : mark.kind === "comment" ? "视频评论" : "关键帧"} · {Math.floor(mark.time / 60)}:{String(Math.floor(mark.time) % 60).padStart(2, "0")}</small>
        : mark.anchor.kind === "element" && <small className="element-kind">元素 · {mark.anchor.tag}</small>}
      {mark.text && (!("kind" in mark) || mark.kind !== "screenshot") && <blockquote>{mark.text}</blockquote>}
      {mark.note.trim() && <div className="content-note"><p>{mark.note}</p></div>}
    </div>
    {showSource && <><ContentTags page={page} /><Source page={page} open={open} date={mark.updatedAt} /></>}
  </article>;
}

export function matchesContent(page: Page, mark: Mark | VideoMark, query: string) {
  return [page.title, page.url, mark.text, mark.note, page.category, ...page.tags].join("\n").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

export function ContentCollection({ pages, query, open, filtered = false }: { pages: Page[]; query: string; open: (p: Page) => void; filtered?: boolean }) {
  const [grouped, setGrouped] = useState(() => {
    try { return localStorage.getItem("localmark.content.grouped") !== "false"; } catch { return true; }
  });
  const groups = pages.map(page => ({ page, marks: [...page.annotations, ...(page.videoMarks ?? [])]
    .filter(mark => matchesContent(page, mark, query))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }))
    .filter(group => group.marks.length)
    .sort((a, b) => b.marks[0].updatedAt.localeCompare(a.marks[0].updatedAt));
  const count = groups.reduce((sum, group) => sum + group.marks.length, 0);
  return <div className="library-collection content-collection">
    <div className="collection-heading"><span>{count} 条{pages.some(page => page.videoMarks?.length) ? "标注" : "高亮"} · {groups.length} 个网页</span><div className="content-view-controls">
      <button type="button" className="group-mode-switch" role="switch" aria-checked={grouped} aria-label="按网页分组" onClick={() => {
        const next = !grouped; setGrouped(next);
        try { localStorage.setItem("localmark.content.grouped", String(next)); } catch {}
      }}><span aria-hidden="true" />按网页分组</button><small>最近修改优先</small>
    </div></div>
    {count > 0 ? grouped ? <GroupedContent groups={groups} open={open} renderMark={(page, mark) => <HighlightCard key={mark.id} page={page} mark={mark} open={open} showSource={false} />} /> :
      <CardFlow className="content-grid" minWidth={310} gap={18} singleColumnBelow={720}>
        {groups.flatMap(({ page, marks }) => marks.map(mark => ({ page, mark })))
          .sort((a, b) => b.mark.updatedAt.localeCompare(a.mark.updatedAt))
          .map(({ page, mark }) => <HighlightCard key={mark.id} page={page} mark={mark} open={open} />)}
      </CardFlow> : <div className="collection-empty"><Icon name="pen" size={30} /><h3>{query || filtered ? "没有匹配的内容" : "还没有高亮内容"}</h3><p>{query || filtered ? "调整搜索词或取消部分标签，查看其他内容。" : "在网页中选择文字并高亮，摘录和批注会汇集在这里。"}</p></div>}
  </div>;
}

export function CatalogDetail({ lib, kind, item, draft, change, reset, mutate, open, browse, manage }: {
  lib: Library; kind: CatalogKind; item: CatalogItem; draft?: DescriptionDraft;
  change: (draft: DescriptionDraft) => void; reset: (expected?: DescriptionDraft) => void;
  mutate: (m: Request) => Promise<unknown>; open: (p: Page) => void; browse: () => void; manage: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const d = draft ?? { value: item.description, base: item.description, expected: taxonomyToken(lib) };
  const changed = changedDescription(d);
  const nameChanged = d.name !== undefined && d.name !== item.name;
  const stale = !!draft && draft.expected !== taxonomyToken(lib);
  const pages = Object.values(lib.entries).map(e => e.page).filter(p => kind === "colors" ? [...p.annotations, ...(p.videoMarks ?? [])].some(m => m.color === item.id)
    : kind === "categories" ? p.categoryId === item.id : p.tagIds?.includes(item.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <div className="catalog-detail">
    <small className="rail-label">{kind === "categories" ? "主分类" : kind === "tags" ? "子标签" : "颜色"}详情</small>
    <h2>{item.color && <i className="catalog-color" style={{ background: colorInfo(item.color).hex }} />}{item.name}</h2>
    <p className="muted">{item.count} {kind === "colors" ? "条高亮" : "个关联网页"}</p>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError("");
      try { await mutate({ type: "taxonomy", expected: d.expected, action: nameChanged && kind !== "colors"
        ? { operation: "rename", kind, id: item.id, name: d.name!, description: d.value }
        : { operation: "describe", kind, id: item.id, description: d.value } }); reset(d); }
      catch (e) { setError(String(e)); } finally { setBusy(false); }
    }}>
      {kind !== "colors" && <div className="catalog-name-field"><label htmlFor="catalog-name">名称</label>
        <input id="catalog-name" aria-label="分类或标签名称" maxLength={100} required value={d.name ?? item.name}
          disabled={busy || !!lib.taxonomyIssue || item.id === UNCATEGORIZED}
          onChange={e => change({ ...d, name: e.target.value, baseName: d.baseName ?? item.name })} />
        {item.id === UNCATEGORIZED && <small>未分类是固定兜底名称。</small>}
      </div>}
      <label htmlFor="catalog-description">说明</label>
      <p className="description-hint">{kind === "colors" ? "这支颜色代表什么？可以记录重点、疑问或待实践的想法。" : "它指代什么？适合收录哪些内容？写下定义、边界或思考。"}</p>
      <textarea id="catalog-description" aria-label="内容说明" maxLength={100000} placeholder="写下你的理解…" value={d.value}
        disabled={busy || !!lib.taxonomyIssue || !lib.taxonomy} onChange={e => change({ ...d, value: e.target.value })} />
      <div className="row wrap"><button type="submit" disabled={busy || !changed || stale || !!lib.taxonomyIssue || (d.name !== undefined && !d.name.trim())}>{nameChanged ? "保存名称" : "保存说明"}</button>
        {draft && <button type="button" disabled={busy} onClick={() => { reset(); setError(""); }}>取消修改</button>}</div>
      {stale && <p className="error" role="alert">分类资料已更新，草稿已保留。请复制草稿后取消修改，读取最新内容再编辑。</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </form>
    {kind !== "colors" && item.id !== UNCATEGORIZED && <button className="catalog-manage" onClick={manage}>合并或删除</button>}
    <div className="collection-heading"><h3>{kind === "colors" ? "关联高亮" : "关联网页"}</h3>{kind !== "colors" && <button onClick={browse}>筛选网页</button>}</div>
    <div className="catalog-related">{kind === "colors" ? pages.flatMap(page => [...page.annotations, ...(page.videoMarks ?? [])].filter(m => m.color === item.id).map(mark => <HighlightCard key={`${page.id}:${mark.id}`} page={page} mark={mark} open={open} />))
      : pages.map(page => <PageCard key={page.id} page={page} open={open} />)}
      {!pages.length && <p className="muted">暂时没有关联内容，可以先记录说明。</p>}</div>
  </div>;
}
