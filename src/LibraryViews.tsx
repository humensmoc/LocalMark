import { useState, type CSSProperties } from "react";
import { COLORS, type Color, type Library, type Page, type Mark } from "./model";
import { Icon } from "./Icon";
import { SiteIcon } from "./SiteIcon";
import { RatingDots } from "./PageRating";
import { taxonomyToken, UNCATEGORIZED } from "./taxonomy";
import type { Request } from "./protocol";

export const LIBRARY_VIEWS = [
  { id: "pages", label: "网页", icon: "page", hint: "按主分类与子标签筛选收藏，在右侧阅读和编辑。" },
  { id: "categories", label: "主分类", icon: "folder", hint: "梳理收藏的大方向，记录每个分类的含义与收录边界。" },
  { id: "tags", label: "子标签", icon: "tag", hint: "用可跨主分类复用的标签，连接相似的主题与想法。" },
  { id: "highlights", label: "高亮内容", icon: "pen", hint: "所有网页的高亮摘录，以及与摘录对应的批注。" },
  { id: "comments", label: "独立批注", icon: "comment", hint: "集中阅读写在高亮里的评论，并查看对应摘录。" },
  { id: "colors", label: "颜色", icon: "palette", hint: "为高亮颜色赋予含义，形成自己的阅读与思考习惯。" },
] as const;
export type LibraryView = typeof LIBRARY_VIEWS[number]["id"];
export type CatalogKind = "categories" | "tags" | "colors";
export type CatalogItem = { id: string; name: string; description: string; count: number; color?: Color };
export type DescriptionDraft = { value: string; base: string; expected: string; name?: string; baseName?: string };
export const changedDescription = (d: DescriptionDraft) => d.value !== d.base || d.name !== d.baseName;

export function catalogItems(lib: Library, kind: CatalogKind): CatalogItem[] {
  const pages = Object.values(lib.entries).map(e => e.page);
  if (kind === "colors") return (Object.keys(COLORS) as Color[]).map(color => ({
    id: color, name: COLORS[color].name, color,
    description: lib.taxonomy?.colorDescriptions?.[color] ?? "",
    count: pages.reduce((n, p) => n + p.annotations.filter(m => m.color === color).length, 0),
  }));
  return (lib.taxonomy?.[kind] ?? []).map(item => ({ ...item, description: item.description ?? "",
    count: pages.filter(p => kind === "categories" ? p.categoryId === item.id : p.tagIds?.includes(item.id)).length,
  }));
}

export function LibraryNavigation({ view, lib, change }: { view: LibraryView; lib: Library; change: (view: LibraryView) => void }) {
  const pages = Object.values(lib.entries).map(e => e.page);
  const counts = { pages: pages.length, categories: lib.taxonomy?.categories.length ?? 0, tags: lib.taxonomy?.tags.length ?? 0,
    highlights: pages.reduce((n, p) => n + p.annotations.length, 0), comments: pages.reduce((n, p) => n + p.annotations.filter(m => m.note.trim()).length, 0), colors: Object.keys(COLORS).length };
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
  const items = catalogItems(lib, kind).filter(x => `${x.name}\n${x.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="library-collection">
    <div className="collection-heading"><span>{items.length} 项</span>{kind !== "colors" && <button onClick={manage}>新建{kind === "categories" ? "主分类" : "子标签"}</button>}</div>
    <div className={`catalog-grid${kind === "colors" ? "" : " taxonomy-grid"}`}>
      {items.map(item => <button key={item.id} className={`catalog-card ${selected === item.id ? "selected" : ""}`} aria-pressed={selected === item.id} onClick={() => choose(item.id)}>
        <span className="catalog-card-title">{item.color ? <i className="catalog-color" style={{ background: COLORS[item.color].hex }} /> : <Icon name={kind === "categories" ? "folder" : "tag"} />}<strong>{item.name}</strong></span>
        <span className={`catalog-description ${item.description ? "" : "muted"}`}>{item.description || "暂无说明"}</span>
        <small>{item.count} {kind === "colors" ? "条高亮" : "个网页"}</small>
      </button>)}
      {!items.length && <div className="collection-empty"><Icon name="tag" size={30} /><h3>{query ? "没有匹配的内容" : "还没有子标签"}</h3><p>{query ? "试试搜索其他名称或说明。" : "创建标签，为不同网页建立共同的主题。"}</p></div>}
    </div>
  </div>;
}

function Source({ page, open }: { page: Page; open: (p: Page) => void }) {
  return <button className="content-source" onClick={() => open(page)} title={`查看网页：${page.title}`}>
    <SiteIcon site={page} /><span>{page.title}<small className="rated-source-meta"><span className="source-host">{new URL(page.url).hostname}</span><RatingDots rating={page.rating} /></small></span><Icon name="arrow" size={14} />
  </button>;
}
export function HighlightCard({ page, mark, open }: { page: Page; mark: Mark; open: (p: Page) => void }) {
  return <article className="content-card" style={{ "--mark": COLORS[mark.color].hex } as CSSProperties}>
    <div className="content-card-meta"><span><i style={{ background: COLORS[mark.color].hex }} />{COLORS[mark.color].name}高亮</span><time>{new Date(mark.updatedAt).toLocaleDateString("zh-CN")}</time></div>
    <blockquote>{mark.text}</blockquote>
    {mark.note.trim() && <div className="content-note"><small>批注</small><p>{mark.note}</p></div>}
    <Source page={page} open={open} />
  </article>;
}

export function ContentCollection({ pages, view, query, open }: { pages: Page[]; view: "highlights" | "comments"; query: string; open: (p: Page) => void }) {
  const needle = query.trim().toLocaleLowerCase();
  const includes = (...parts: string[]) => parts.join("\n").toLocaleLowerCase().includes(needle);
  const highlights = pages.flatMap(page => page.annotations.map(mark => ({ page, mark })))
    .filter(({ page, mark }) => includes(page.title, page.url, mark.text, mark.note, page.category, ...page.tags))
    .sort((a, b) => b.mark.updatedAt.localeCompare(a.mark.updatedAt));
  const comments = highlights.filter(({ mark }) => mark.note.trim());
  const count = view === "highlights" ? highlights.length : comments.length;
  return <div className="library-collection">
    <div className="collection-heading"><span>{count} 条{view === "highlights" ? "高亮" : "独立批注"}</span><small>最近修改优先</small></div>
    <div className="content-grid">
      {view === "highlights" ? highlights.map(({ page, mark }) => <HighlightCard key={`${page.id}:${mark.id}`} page={page} mark={mark} open={open} />)
        : comments.map(({ page, mark }) => <article className="content-card comment-card" key={`${page.id}:${mark.id}`} style={{ "--mark": COLORS[mark.color].hex } as CSSProperties}>
          <div className="content-card-meta"><span><Icon name="comment" size={14} />高亮批注</span><time>{new Date(mark.updatedAt).toLocaleDateString("zh-CN")}</time></div>
          <p className="standalone-comment">{mark.note}</p>
          <details className="comment-context"><summary>查看对应高亮</summary><blockquote>{mark.text}</blockquote></details>
          <Source page={page} open={open} />
        </article>)}
      {!count && <div className="collection-empty"><Icon name={view === "highlights" ? "pen" : "comment"} size={30} /><h3>{query ? "没有匹配的内容" : view === "highlights" ? "还没有高亮内容" : "还没有独立批注"}</h3><p>{query ? "调整搜索词，或清空搜索查看全部内容。" : view === "highlights" ? "在网页中选择文字并高亮，摘录和批注会汇集在这里。" : "给高亮写下评论后，批注会汇集在这里。"}</p></div>}
    </div>
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
  const pages = Object.values(lib.entries).map(e => e.page).filter(p => kind === "colors" ? p.annotations.some(m => m.color === item.id)
    : kind === "categories" ? p.categoryId === item.id : p.tagIds?.includes(item.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <div className="catalog-detail">
    <small className="rail-label">{kind === "categories" ? "主分类" : kind === "tags" ? "子标签" : "颜色"}详情</small>
    <h2>{item.color && <i className="catalog-color" style={{ background: COLORS[item.color].hex }} />}{item.name}</h2>
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
    <div className="catalog-related">{kind === "colors" ? pages.flatMap(page => page.annotations.filter(m => m.color === item.id).map(mark => <HighlightCard key={`${page.id}:${mark.id}`} page={page} mark={mark} open={open} />))
      : pages.map(page => <Source key={page.id} page={page} open={open} />)}
      {!pages.length && <p className="muted">暂时没有关联内容，可以先记录说明。</p>}</div>
  </div>;
}
