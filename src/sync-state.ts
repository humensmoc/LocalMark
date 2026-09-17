import type { Library, Page } from "./model";

// File-name migration belongs to the writer, not to the user's pending edit.
const content = (page: Page) =>
  JSON.stringify({ ...page, markdownFile: undefined,
    ...(page.schemaVersion === 2 ? { category: undefined, tags: undefined } : {}) });

/** Merge a writer's isolated snapshot without rolling back edits saved meanwhile. */
export function mergeSyncResult(
  latest: Library,
  before: Library,
  synced: Library,
) {
  const currentTaxonomy = JSON.stringify(latest.taxonomy),
    oldTaxonomy = JSON.stringify(before.taxonomy),
    resultTaxonomy = JSON.stringify(synced.taxonomy);
  const taxonomyConflict = currentTaxonomy !== oldTaxonomy && resultTaxonomy !== oldTaxonomy && currentTaxonomy !== resultTaxonomy;
  if (currentTaxonomy === oldTaxonomy || currentTaxonomy === resultTaxonomy) {
    latest.taxonomy = structuredClone(synced.taxonomy);
    latest.taxonomyDirty = synced.taxonomyDirty;
  }
  latest.taxonomyBase = taxonomyConflict ? before.taxonomyBase ?? null : synced.taxonomyBase;
  latest.taxonomyIssue = taxonomyConflict ? "分类标签文件与浏览器同时修改，请在分类与标签管理中选择保留版本。" : synced.taxonomyIssue;
  if (taxonomyConflict) latest.taxonomyDirty = true;
  for (const id of new Set([
    ...Object.keys(before.entries),
    ...Object.keys(synced.entries),
  ])) {
    const original = before.entries[id],
      result = synced.entries[id],
      current = latest.entries[id];
    if (!original) {
      if (!current && result) latest.entries[id] = structuredClone(result);
      continue;
    }
    if (!current) continue;
    // A previous writer checkpoint may already have published this result.
    // Reapplying that checkpoint is not a new concurrent user edit.
    if (content(current.page) === content(original.page) || (result && content(current.page) === content(result.page))) {
      if (result) latest.entries[id] = structuredClone(result);
      else delete latest.entries[id];
      continue;
    }
    if (!result) continue;
    const merged = structuredClone(result);
    merged.page = { ...current.page, markdownFile: result.page.markdownFile };
    merged.dirty = merged.mdDirty = true;
    // A full refresh may have imported a disk edit while a new local edit arrived.
    // Keep both versions visible as a conflict instead of silently adopting its base.
    if (content(result.page) !== content(original.page)) {
      merged.issue = {
        kind: "json",
        message: "本地 JSON 与浏览器待保存版本同时修改，请选择保留版本。",
        external: result.baseJson ?? undefined,
      };
    }
    latest.entries[id] = merged;
  }
  latest.errors = [...synced.errors];
  latest.directoryName = synced.directoryName;
  latest.status = synced.status;
  if (
    latest.status === "已保存到本地文件" &&
    Object.values(latest.entries).some((e) => e.dirty || e.mdDirty || e.issue)
  ) {
    latest.status = "已暂存浏览器，等待后台同步";
  }
  return latest;
}
