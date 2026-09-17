import { z } from "zod";
import { DEFAULT_CATEGORIES, type Library, type Page, type Taxonomy, type Taxon } from "./model";

export const UNCATEGORIZED = "category:uncategorized";
export const TAXONOMY_PATH = "分类标签.json";
export type TaxonKind = "categories" | "tags";
const item = z.object({ id: z.string().min(1).max(500), name: z.string().trim().min(1).max(100) });
export const TaxonomySchema = z.object({
  version: z.literal(1), revision: z.string().min(1),
  categories: z.array(item).max(10000), tags: z.array(item).max(10000),
}).superRefine((t, ctx) => {
  for (const kind of ["categories", "tags"] as const) {
    if (new Set(t[kind].map(x => x.id)).size !== t[kind].length ||
        new Set(t[kind].map(x => x.name)).size !== t[kind].length)
      ctx.addIssue({ code: "custom", message: "分类或标签存在重复 ID/名称" });
  }
  if (!t.categories.some(x => x.id === UNCATEGORIZED && x.name === "未分类"))
    ctx.addIssue({ code: "custom", message: "必须保留未分类及其固定 ID" });
});
export function initialTaxonomy(): Taxonomy {
  return { version: 1, revision: "initial", tags: [], categories: DEFAULT_CATEGORIES.map((name, i) => ({
    id: i === 0 ? UNCATEGORIZED : `category:default:${i}`, name,
  })) };
}
export function touchTaxonomy(lib: Library) {
  lib.taxonomy!.revision = crypto.randomUUID();
  lib.taxonomyDirty = true;
}
export function ensureTaxon(lib: Library, kind: TaxonKind, name: string): Taxon {
  const normalized = item.shape.name.parse(name);
  const found = lib.taxonomy![kind].find(x => x.name === normalized);
  if (found) return found;
  const created = { id: crypto.randomUUID(), name: normalized };
  lib.taxonomy![kind].push(created);
  touchTaxonomy(lib);
  return created;
}
/** Names are a readable export cache. Relationships are owned exclusively by IDs in v2. */
export function projectPage(lib: Library, p: Page) {
  const t = lib.taxonomy!;
  const category = t.categories.find(x => x.id === p.categoryId);
  const tags = (p.tagIds ?? []).map(id => t.tags.find(x => x.id === id));
  if (!category || tags.some(x => !x)) throw Error("分类或标签 ID 不存在，请恢复分类标签.json 或处理分类数据冲突。");
  p.category = category.name;
  p.tags = tags.map(x => x!.name);
}
export function migrateTaxonomy(lib: Library) {
  if (!lib.taxonomy) { lib.taxonomy = initialTaxonomy(); lib.taxonomyDirty = true; }
  for (const e of Object.values(lib.entries)) {
    // Invalid external pages remain visible for explicit conflict handling.
    if (e.issue && e.issue.kind !== "io" && e.issue.kind !== "markdown") continue;
    const before = JSON.stringify(e.page);
    const p = e.page;
    try {
      if (p.schemaVersion === 1) {
        p.categoryId = ensureTaxon(lib, "categories", p.category).id;
        p.tagIds = [...new Set(p.tags.map(name => ensureTaxon(lib, "tags", name).id))];
        p.schemaVersion = 2;
      }
      projectPage(lib, p);
      if (JSON.stringify(p) !== before) e.dirty = e.mdDirty = true;
    } catch (error) {
      e.issue = { kind: "invalid", message: String(error) };
    }
  }
}
export function taxonomyToken(lib: Library) { return JSON.stringify(lib.taxonomy); }
export function relationToken(p: Page) { return JSON.stringify([p.categoryId, p.tagIds]); }

export type TaxonomyAction =
  | { operation: "create"; kind: TaxonKind; name: string }
  | { operation: "rename"; kind: TaxonKind; id: string; name: string }
  | { operation: "merge" | "delete"; kind: TaxonKind; id: string; targetId?: string };

/** Validate the whole operation before the caller persists this isolated library. */
export function manageTaxonomy(lib: Library, action: TaxonomyAction, expected: string) {
  z.enum(["create", "rename", "merge", "delete"]).parse(action.operation);
  z.enum(["categories", "tags"]).parse(action.kind);
  if (taxonomyToken(lib) !== expected) throw Error("分类或标签已改变，请刷新后重试。");
  if (lib.taxonomyIssue) throw Error(lib.taxonomyIssue);
  if (lib.errors.length) throw Error("存在无法读取的网页数据，请处理后再执行全库管理。");
  const catalog = lib.taxonomy![action.kind];
  if (action.operation === "create") {
    if (catalog.some(x => x.name === action.name.trim())) throw Error("名称已存在。");
    ensureTaxon(lib, action.kind, action.name);
    return [];
  }
  const source = catalog.find(x => x.id === action.id);
  if (!source) throw Error("分类或标签已不存在。");
  if (source.id === UNCATEGORIZED) throw Error("未分类是固定兜底，不能重命名、合并或删除。");
  const affected = Object.values(lib.entries).filter(e => action.kind === "categories"
    ? e.page.categoryId === source.id : e.page.tagIds?.includes(source.id));
  if (affected.some(e => e.issue)) throw Error("相关网页存在同步冲突，请处理后重试。");
  if (action.operation === "rename") {
    const name = item.shape.name.parse(action.name);
    if (catalog.some(x => x.id !== source.id && x.name === name)) throw Error("名称已存在，请使用合并操作。");
    source.name = name;
  } else {
    const targetId = action.targetId ?? (action.kind === "categories" ? UNCATEGORIZED : undefined);
    if (action.operation === "merge" && !action.targetId) throw Error("请选择合并目标。");
    if (targetId === source.id || (targetId && !catalog.some(x => x.id === targetId))) throw Error("请选择有效的目标分类或标签。");
    for (const e of affected) {
      if (action.kind === "categories") e.page.categoryId = targetId!;
      else e.page.tagIds = [...new Set(e.page.tagIds!.flatMap(id => id !== source.id ? [id] : targetId ? [targetId] : []))];
    }
    lib.taxonomy![action.kind] = catalog.filter(x => x.id !== source.id);
  }
  touchTaxonomy(lib);
  for (const e of affected) {
    projectPage(lib, e.page);
    e.dirty = e.mdDirty = true;
    if (action.operation !== "rename") e.page.updatedAt = new Date().toISOString();
  }
  return affected.map(e => e.page.id);
}

export type BulkAction = { operation: "category" | "add-tags" | "remove-tags"; ids: string[] };
export function bulkTaxonomy(lib: Library, selected: Record<string, string>, action: BulkAction, expected: string) {
  z.enum(["category", "add-tags", "remove-tags"]).parse(action.operation);
  z.array(z.string().min(1)).max(500).parse(action.ids);
  z.record(z.string()).parse(selected);
  if (taxonomyToken(lib) !== expected) throw Error("分类或标签已改变，请重新选择。");
  if (lib.taxonomyIssue) throw Error(lib.taxonomyIssue);
  const ids = [...new Set(action.ids)];
  if (!ids.length || (action.operation === "category" && ids.length !== 1)) throw Error("请选择分类或标签。");
  const catalog = action.operation === "category" ? lib.taxonomy!.categories : lib.taxonomy!.tags;
  if (ids.some(id => !catalog.some(x => x.id === id))) throw Error("分类或标签已不存在。");
  const entries = Object.entries(selected).map(([id, token]) => {
    const e = lib.entries[id];
    if (!e || e.issue || relationToken(e.page) !== token) throw Error("选中的网页已改变或存在冲突，请刷新后重试。");
    if (action.operation === "add-tags" && new Set([...e.page.tagIds!, ...ids]).size > 500)
      throw Error("每篇网页最多允许 500 个标签。");
    return e;
  });
  if (!entries.length) throw Error("请先选择网页。");
  const changed: string[] = [];
  for (const e of entries) {
    const p = e.page, before = relationToken(p);
    if (action.operation === "category") p.categoryId = ids[0];
    else if (action.operation === "add-tags") p.tagIds = [...new Set([...p.tagIds!, ...ids])];
    else p.tagIds = p.tagIds!.filter(id => !ids.includes(id));
    if (relationToken(p) !== before) {
      projectPage(lib, p);
      p.updatedAt = new Date().toISOString();
      e.dirty = e.mdDirty = true;
      changed.push(p.id);
    }
  }
  return changed;
}
