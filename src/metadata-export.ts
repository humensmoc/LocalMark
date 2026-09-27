import { canonicalUrl, type Page } from "./model";
import { DirectoryFiles } from "./files";
import { metadataFileId, metadataFilePath } from "./metadata-names";

export type ExportChoice = "new" | "old";
export type ExportRecord = {
  path: string; destination: string; page: Page; value: string; previous: string | null;
  kind: "create" | "same" | "conflict";
};
export type ExportPlan = { root: FileSystemDirectoryHandle; pages: Page[]; records: ExportRecord[] };
export type ExportReport = { created: number; replaced: number; identical: number; kept: number };
export type ExportDifference = { label: string; oldValue: string; newValue: string };

function parse(value: string): unknown {
  return JSON.parse(value.replace(/^\uFEFF/, ""));
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
// Formatting and key order do not change content. Arrays and unknown fields stay significant.
function comparable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(comparable).join(",")}]`;
  const fields = object(value);
  return fields ? `{${Object.keys(fields).sort().map(k => `${JSON.stringify(k)}:${comparable(fields[k])}`).join(",")}}`
    : JSON.stringify(value) ?? "undefined";
}
export function sameMetadata(a: string, b: string) {
  try { return comparable(parse(a)) === comparable(parse(b)); } catch { return false; }
}
function url(value: unknown) {
  try { return typeof value === "string" && /^https?:\/\//i.test(value) ? canonicalUrl(value) : undefined; }
  catch { return undefined; }
}
function identity(value: string, path: string) {
  let record: Record<string, unknown> | undefined;
  try { record = object(parse(value)); } catch { /* Matching invalid files are reviewed as raw conflicts. */ }
  const looksLikePage = record && Array.isArray(record.annotations);
  return {
    fileId: metadataFileId(path.split("/").at(-1)!),
    id: looksLikePage && typeof record?.id === "string" ? record.id : metadataFileId(path.split("/").at(-1)!),
    url: looksLikePage ? url(record?.url) : undefined,
  };
}
async function scan(root: FileSystemDirectoryHandle, signal?: AbortSignal) {
  const result: { path: string; value: string }[] = [];
  async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, handle] of dir.entries()) {
      signal?.throwIfAborted();
      const path = prefix + name;
      if (handle.kind === "directory") await walk(handle, `${path}/`);
      else if (/\.json$/i.test(name)) {
        const file = await handle.getFile();
        if (file.size > 32_000_000) throw Error(`${path} 超过 32 MB，无法完整检查重复网页，请移出目标目录后重试。`);
        result.push({ path, value: await file.text() });
      }
    }
  }
  await walk(root, "");
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

// No file is created until all conflicts have a decision.
export async function prepareMetadataExport(root: FileSystemDirectoryHandle, pages: Page[], signal?: AbortSignal): Promise<ExportPlan> {
  if (!pages.length) throw Error("请先选择要导出的网页。");
  const saved = structuredClone(pages);
  const incoming = saved.map(page => ({ page, path: metadataFilePath(page.title, page.id, page.createdAt),
    value: JSON.stringify(page, null, 2) + "\n", url: url(page.url) }));
  if (new Set(saved.map(p => p.id)).size !== saved.length || new Set(incoming.map(p => p.url)).size !== incoming.length)
    throw Error("所选网页中存在重复 ID 或网址，请先整理重复记录。");
  const existing = (await scan(root, signal)).map(file => ({ ...file, ...identity(file.value, file.path) }));
  const records: ExportRecord[] = [];
  const claimed = new Set<string>();
  for (const next of incoming) {
    const matches = existing.filter(file => file.id === next.page.id || file.fileId === next.page.id || (next.url && file.url === next.url) || file.path === next.path);
    if (!matches.length) records.push({ path: next.path, destination: next.path, page: next.page, value: next.value, previous: null, kind: "create" });
    for (const file of matches) {
      if (claimed.has(file.path)) throw Error(`${file.path} 同时匹配多篇所选网页，请先检查该文件的 ID 和网址。`);
      claimed.add(file.path);
      const suffixId = metadataFileId(file.path.split("/").at(-1)!);
      // A URL match can have a different stable ID. Keep filename and JSON IDs
      // consistent so the exported file remains readable by the sync engine.
      const destination = suffixId && suffixId !== next.page.id ? file.path.replace(/[a-f0-9]{16}\.json$/, `${next.page.id}.json`) : file.path;
      records.push({ path: file.path, destination, page: next.page, value: next.value, previous: file.value,
        kind: sameMetadata(file.value, next.value) ? "same" : "conflict" });
    }
  }
  return { root, pages: saved, records };
}

export function exportSummary(report: ExportReport) {
  return `新增 ${report.created} 个文件，替换 ${report.replaced} 个文件，内容相同跳过 ${report.identical} 个，保留旧文件 ${report.kept} 个`;
}
export async function applyMetadataExport(plan: ExportPlan, choices: Record<string, ExportChoice> = {}, signal?: AbortSignal): Promise<ExportReport> {
  for (const record of plan.records) {
    if (record.kind === "conflict" && choices[record.path] !== "new" && choices[record.path] !== "old")
      throw Error("请为每个冲突文件选择用新文件或用旧文件。");
  }
  // Re-scan before any writes: another window may edit, delete or add a copy while reviewing.
  const latest = await prepareMetadataExport(plan.root, plan.pages, signal);
  const stamp = (p: ExportPlan) => JSON.stringify(p.records.map(({ path, destination, previous, value, kind }) => ({ path, destination, previous, value, kind })));
  if (stamp(plan) !== stamp(latest)) throw Error("目标目录中的相关文件已变化，本次尚未写入。请取消后重新导出并核对冲突。");
  const files = new DirectoryFiles(plan.root);
  const writes = new Map<string, { value: string; previous: string | null }>();
  const written = new Map<string, string>();
  for (const record of plan.records) {
    if (record.kind === "same" || (record.kind === "conflict" && choices[record.path] === "old")) continue;
    const target = plan.records.find(item => item.path === record.destination);
    const previous = target?.previous ?? null;
    if (target && target !== record && previous !== null && !sameMetadata(previous, record.value)
      && (target.kind === "same" || choices[target.path] !== "new"))
      throw Error(`${record.destination} 同时被选择保留旧内容。请统一该网页相关文件的选择后重试。`);
    const shared = writes.get(record.destination);
    if (shared && shared.value !== record.value) throw Error("多个导出文件指向相同位置但内容不同，请检查文件名。");
    writes.set(record.destination, { value: record.value, previous });
  }
  const report: ExportReport = { created: 0, replaced: 0, identical: 0, kept: 0 };
  for (const record of plan.records) {
    if (record.kind === "same") { report.identical++; continue; }
    if (record.kind === "conflict" && choices[record.path] === "old") { report.kept++; continue; }
    try {
      signal?.throwIfAborted();
      if (await files.readFile(record.path) !== (written.get(record.path) ?? record.previous)) throw Error("目标文件在写入前已变化");
      const target = writes.get(record.destination)!;
      if (!written.has(record.destination)) {
        if (await files.readFile(record.destination) !== target.previous) throw Error("新文件位置在写入前已变化");
        if (target.previous !== null && sameMetadata(target.previous, record.value)) written.set(record.destination, target.previous);
        else {
          await files.writeFile(record.destination, record.value);
          written.set(record.destination, record.value);
        }
      }
      if (await files.readFile(record.destination) !== written.get(record.destination)) throw Error("文件读回校验失败");
      if (record.destination !== record.path) {
        if (await files.readFile(record.path) !== record.previous) throw Error("旧文件在替换期间已变化，已保留两份文件");
        await files.removeFile(record.path);
      }
      if (record.kind === "create") report.created++; else report.replaced++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw Error(`导出未完成：${exportSummary(report)}；${record.path}：${reason}。已完成的写入已保留，请重新导出检查剩余文件。`);
    }
  }
  return report;
}

// Convenience for exports without conflicts; never silently choose a winner.
export async function exportMetadata(root: FileSystemDirectoryHandle, pages: Page[]) {
  return applyMetadataExport(await prepareMetadataExport(root, pages));
}

const labels: Record<string, string> = { title: "网页标题", url: "网址", originalUrl: "原始网址", category: "主分类", tags: "标签",
  comment: "网页评论", rating: "评分", createdAt: "首次收藏时间", updatedAt: "修改时间", annotations: "高亮与批注", videoMarks: "视频标注",
  text: "摘录内容", note: "批注", color: "高亮颜色", anchor: "定位信息", id: "网页 ID", categoryId: "主分类 ID", tagIds: "标签 ID",
  favicon: "网页图标", folderName: "文件夹名称", markdownFile: "Markdown 文件名", schemaVersion: "元数据格式版本" };
const display = (value: unknown) => value === undefined ? "（不存在）" : typeof value === "string" ? value || "（空）" : JSON.stringify(value, null, 2);
export function metadataDifferences(record: ExportRecord): ExportDifference[] {
  let old: Record<string, unknown> | undefined;
  try { old = object(parse(record.previous ?? "")); } catch { /* Show exact invalid contents. */ }
  const next = object(parse(record.value))!;
  if (!old) return [{ label: "完整文件内容（旧文件不是有效的网页 JSON 对象）", oldValue: record.previous ?? "（不存在）", newValue: record.value }];
  const differences: ExportDifference[] = [];
  const add = (label: string, a: unknown, b: unknown) => {
    if (comparable(a) !== comparable(b)) differences.push({ label, oldValue: display(a), newValue: display(b) });
  };
  for (const key of new Set([...Object.keys(next), ...Object.keys(old)])) {
    if (key !== "annotations" || !Array.isArray(old[key]) || !Array.isArray(next[key])) {
      add(labels[key] ?? key, old[key], next[key]); continue;
    }
    const a = old[key] as unknown[], b = next[key] as unknown[];
    const ids = (list: unknown[]) => list.map(mark => object(mark)?.id);
    if ([...a, ...b].some(mark => typeof object(mark)?.id !== "string") || new Set(ids(a)).size !== a.length || new Set(ids(b)).size !== b.length) {
      add(labels[key], a, b); continue;
    }
    const oldMarks = new Map(a.map(mark => [object(mark)!.id, object(mark)!]));
    const newMarks = new Map(b.map(mark => [object(mark)!.id, object(mark)!]));
    const allIds = [...new Set([...newMarks.keys(), ...oldMarks.keys()])];
    allIds.forEach((id, index) => {
      const before = oldMarks.get(id), after = newMarks.get(id), label = `摘录 ${index + 1}`;
      if (!before || !after) add(`${label} · ${after ? "新增" : "删除"}`, before, after);
      else for (const field of new Set([...Object.keys(after), ...Object.keys(before)])) add(`${label} · ${labels[field] ?? field}`, before[field], after[field]);
    });
    if (a.length === b.length && ids(a).every(id => newMarks.has(id))) add("摘录排列顺序", ids(a), ids(b));
  }
  return differences;
}
