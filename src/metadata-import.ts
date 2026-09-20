import { z } from "zod";
import { parsePage, PageCategorySchema, PageTagsSchema, type Library } from "./model";
import { ensureTaxon, migrateTaxonomy, projectPage, TaxonomySchema } from "./taxonomy";

export const IMPORT_MAX_FILES = 500;
export const IMPORT_MAX_BYTES = 32_000_000;
export type ImportFile = { name: string; text: string };
export type ImportItem = { name: string; status: "saved" | "pending" | "skipped" | "error"; message: string; pageId?: string };
export type ImportResult = { library: Library; items: ImportItem[]; directoryName: string };
export type ImportRequest = { type: "import-metadata"; files: ImportFile[] };

export function validateImportBatch(files: unknown): ImportFile[] {
  const parsed = z.array(z.object({ name: z.string().min(1).max(1000), text: z.string().max(16_000_000) }))
    .min(1).max(IMPORT_MAX_FILES).parse(files);
  if (parsed.reduce((sum, file) => sum + new TextEncoder().encode(file.text).length, 0) > IMPORT_MAX_BYTES)
    throw Error("每批导入文件总计不能超过 32 MB，请分批导入。");
  return parsed;
}

/** Add valid new pages to an isolated library; never replace a stored page. */
export async function prepareMetadataImport(library: Library, files: ImportFile[]) {
  const next = structuredClone(library);
  migrateTaxonomy(next);
  if (next.taxonomyIssue || next.errors.length)
    throw Error("当前目录存在文件读取或分类数据冲突，请先在设置中处理后再导入。");
  const items: ImportItem[] = [];
  for (const file of files) {
    try {
      if (!/\.json$/i.test(file.name)) throw Error("仅支持文章元数据 .json 文件。");
      const text = file.text.replace(/^\uFEFF/, "");
      const raw = JSON.parse(text);
      const page = await parsePage(text);
      const existing = next.entries[page.id] ?? Object.values(next.entries).find(entry => entry.page.url === page.url);
      if (existing) {
        items.push({ name: file.name, status: "skipped", message: "该网页已存在，保留当前版本。", pageId: existing.page.id });
        continue;
      }
      // A standalone v2 export carries names as well as IDs. Reconcile by name
      // across collections; IDs from a foreign catalog must never retarget local tags.
      const category = PageCategorySchema.parse(raw.category ?? (page.schemaVersion === 1 ? page.category :
        next.taxonomy!.categories.find(item => item.id === page.categoryId)?.name));
      const tags = PageTagsSchema.parse(raw.tags ?? (page.schemaVersion === 1 ? page.tags :
        page.tagIds!.map(id => next.taxonomy!.tags.find(item => item.id === id)?.name)));
      if (page.schemaVersion === 2 && page.tagIds!.length !== tags.length)
        throw Error("标签名称与标签 ID 数量不一致，请使用包含完整标签名称的元数据。");
      // Validate a per-file candidate before publishing its catalog additions.
      const candidate = { ...next, taxonomy: structuredClone(next.taxonomy) };
      page.categoryId = ensureTaxon(candidate, "categories", category).id;
      page.tagIds = [...new Set(tags.map(name => ensureTaxon(candidate, "tags", name).id))];
      page.schemaVersion = 2;
      projectPage(candidate, page);
      TaxonomySchema.parse(candidate.taxonomy);
      // The current folder chooses its own free Markdown name if export is enabled.
      delete page.markdownFile;
      next.taxonomy = candidate.taxonomy;
      next.taxonomyDirty = candidate.taxonomyDirty;
      next.entries[page.id] = { page, baseJson: null, baseMd: null, dirty: true, mdDirty: next.autoGenerateMarkdown === true };
      items.push({ name: file.name, status: "pending", pageId: page.id, message: "等待写入当前目录。" });
    } catch (error) {
      const message = error instanceof SyntaxError ? "JSON 格式不正确。" :
        error instanceof z.ZodError ? "文章元数据不完整或格式不正确，请使用插件导出的文章 JSON。" :
          error instanceof Error ? error.message : String(error);
      items.push({ name: file.name, status: "error", message });
    }
  }
  return { library: next, items };
}

export async function importMetadata(files: ImportFile[]): Promise<ImportResult> {
  const response = await chrome.runtime.sendMessage({ type: "import-metadata", files } satisfies ImportRequest);
  if (!response?.ok) throw Error(response?.error || "插件连接已断开，请刷新页面后重试。");
  return response.data;
}
