import { expect, it } from "vitest";
import { emptyLibrary, folderName, markdown, pageId, parsePage, type Library, type Page } from "../src/model";
import { bulkTaxonomy, ensureTaxon, manageTaxonomy, migrateTaxonomy, relationToken, taxonomyToken, TAXONOMY_PATH, UNCATEGORIZED } from "../src/taxonomy";
import { SyncEngine } from "../src/sync";
import { mergeSyncResult } from "../src/sync-state";
import type { Files } from "../src/files";

class MemoryFiles implements Files {
  data = new Map<string, string>();
  writes: string[] = [];
  async listJson() { return [...this.data.keys()].filter(x => x.startsWith("原始数据/")).map(x => x.split("/")[1]); }
  async read(path: string) { return this.data.get(path) ?? null; }
  async write(path: string, value: string) { this.writes.push(path); this.data.set(path, value); }
  async remove(path: string) { this.data.delete(path); }
}
async function setup() {
  const lib = emptyLibrary(), files = new MemoryFiles();
  for (let n = 0; n < 3; n++) {
    const url = `https://example.com/taxonomy/${n}`, id = await pageId(url);
    const page: Page = { schemaVersion: 1, id, url, originalUrl: url, title: `Article ${n}`, favicon: "",
      folderName: folderName(`Article ${n}`, id), markdownFile: `Article ${n}.md`,
      createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z",
      category: n === 2 ? "未分类" : "游戏设计", tags: n === 2 ? [] : ["旧标签"], annotations: [], comment: "保留评论" };
    const raw = JSON.stringify(page), md = markdown(page);
    lib.entries[id] = { page, baseJson: raw, baseMd: md, dirty: false, mdDirty: false };
    files.data.set(`原始数据/${id}.json`, raw); files.data.set(page.markdownFile!, md);
  }
  const engine = new SyncEngine(lib, files, async () => {});
  await engine.run();
  return { lib, files, engine, pages: Object.values(lib.entries).map(e => e.page) };
}
const selected = (pages: Page[]) => Object.fromEntries(pages.map(p => [p.id, relationToken(p)]));
const act = (lib: Library, action: Parameters<typeof manageTaxonomy>[1]) => manageTaxonomy(lib, action, taxonomyToken(lib));

it("migrates identical names to shared IDs once and round-trips a standalone library", async () => {
  const { lib, files, engine, pages } = await setup();
  expect(pages.every(p => p.schemaVersion === 2)).toBe(true);
  expect(pages[0].tagIds).toEqual(pages[1].tagIds);
  const ids = pages.map(p => [p.id, p.categoryId, p.tagIds]);
  const writes = files.writes.length;
  await engine.run(); expect(files.writes.length).toBe(writes);
  const reopened = emptyLibrary();
  await new SyncEngine(reopened, files, async () => {}).run();
  expect(Object.values(reopened.entries).map(e => [e.page.id, e.page.categoryId, e.page.tagIds])).toEqual(ids);
  expect(reopened.taxonomy).toEqual(lib.taxonomy);
});

it("renames categories and tags without changing IDs, timestamps or other fields", async () => {
  const { lib, pages, engine, files } = await setup();
  const before = structuredClone(pages[0]);
  act(lib, { operation: "rename", kind: "tags", id: pages[0].tagIds![0], name: "新标签" });
  act(lib, { operation: "rename", kind: "categories", id: pages[0].categoryId!, name: "玩法设计" });
  expect(pages[0]).toEqual({ ...before, category: "玩法设计", tags: ["新标签"] });
  await engine.run();
  expect(files.data.get(pages[0].markdownFile!)).toContain('category: "玩法设计"');
  expect(files.data.get(pages[0].markdownFile!)).toContain('"新标签"');
});

it("keeps removed defaults removed and retains empty user categories across reloads", async () => {
  const { lib, files, engine, pages } = await setup();
  act(lib, { operation: "delete", kind: "categories", id: pages[0].categoryId! });
  act(lib, { operation: "create", kind: "categories", name: "以后再读" });
  await engine.run();
  const reopened = emptyLibrary();
  await new SyncEngine(reopened, files, async () => {}).run();
  expect(reopened.taxonomy!.categories.some(x => x.name === "游戏设计")).toBe(false);
  expect(reopened.taxonomy!.categories.some(x => x.name === "以后再读")).toBe(true);
  expect(pages[0].categoryId).toBe(UNCATEGORIZED);
});

it("merges tag IDs and deduplicates relationships", async () => {
  const { lib, pages } = await setup();
  const target = ensureTaxon(lib, "tags", "目标");
  bulkTaxonomy(lib, selected([pages[0]]), { operation: "add-tags", ids: [target.id] }, taxonomyToken(lib));
  const old = pages[0].tagIds![0];
  act(lib, { operation: "merge", kind: "tags", id: old, targetId: target.id });
  expect(pages[0].tagIds).toEqual([target.id]); expect(pages[1].tagIds).toEqual([target.id]);
  expect(lib.taxonomy!.tags.some(x => x.id === old)).toBe(false);
});

it("applies bulk deltas only to selected pages and preserves unrelated tags and content", async () => {
  const { lib, pages } = await setup();
  const extra = ensureTaxon(lib, "tags", "新标签");
  const untouched = structuredClone(pages[1]);
  const original = pages[0].tagIds![0];
  expect(bulkTaxonomy(lib, selected([pages[0], pages[2]]), { operation: "add-tags", ids: [extra.id] }, taxonomyToken(lib))).toHaveLength(2);
  expect(bulkTaxonomy(lib, selected([pages[0]]), { operation: "add-tags", ids: [extra.id] }, taxonomyToken(lib))).toHaveLength(0);
  bulkTaxonomy(lib, selected([pages[0], pages[2]]), { operation: "remove-tags", ids: [original] }, taxonomyToken(lib));
  expect(pages[0].tagIds).toEqual([extra.id]); expect(pages[1]).toEqual(untouched);
  expect(pages[0].comment).toBe("保留评论");
});

it("rejects stale bulk selections before touching any page", async () => {
  const { lib, pages } = await setup();
  const snapshot = selected(pages);
  snapshot[pages[2].id] = "stale";
  const before = JSON.stringify(lib);
  expect(() => bulkTaxonomy(lib, snapshot, { operation: "category", ids: [UNCATEGORIZED] }, taxonomyToken(lib))).toThrow();
  expect(JSON.stringify(lib)).toBe(before);
});

it("protects uncategorized, refuses duplicate names and rejects stale catalog edits", async () => {
  const { lib, pages } = await setup();
  expect(() => act(lib, { operation: "delete", kind: "categories", id: UNCATEGORIZED })).toThrow();
  expect(() => act(lib, { operation: "rename", kind: "categories", id: pages[0].categoryId!, name: "未分类" })).toThrow();
  expect(() => manageTaxonomy(lib, { operation: "create", kind: "tags", name: "新增" }, "stale")).toThrow();
});

it("ignores edited name caches in v2 JSON and follows IDs", async () => {
  const { lib, pages, files, engine } = await setup();
  files.data.set(`原始数据/${pages[0].id}.json`, JSON.stringify({ ...pages[0], category: "伪分类", tags: ["伪标签"] }));
  await engine.run();
  expect(lib.entries[pages[0].id].page.tags).toEqual(["旧标签"]);
  expect(lib.taxonomy!.tags.some(x => x.name === "伪标签")).toBe(false);
});

it("preserves manually edited Markdown during a global rename", async () => {
  const { lib, pages, files, engine } = await setup();
  files.data.set(pages[0].markdownFile!, "手工内容");
  act(lib, { operation: "rename", kind: "tags", id: pages[0].tagIds![0], name: "新标签" });
  await engine.run();
  expect(lib.entries[pages[0].id].issue?.kind).toBe("markdown");
  expect(files.data.get(pages[0].markdownFile!)).toBe("手工内容");
});

it("stops on concurrent registry edits and backs up before keeping local data", async () => {
  const { lib, pages, files, engine } = await setup();
  act(lib, { operation: "rename", kind: "tags", id: pages[0].tagIds![0], name: "浏览器名称" });
  const disk = JSON.parse(files.data.get(TAXONOMY_PATH)!); disk.tags[0].name = "文件名称";
  const external = JSON.stringify(disk); files.data.set(TAXONOMY_PATH, external);
  await engine.run();
  expect(lib.taxonomyIssue).toBeTruthy(); expect(files.data.get(TAXONOMY_PATH)).toBe(external);
  await engine.resolveTaxonomy("local");
  expect(lib.taxonomyIssue).toBeUndefined();
  expect([...files.data.entries()].some(([p, v]) => p.startsWith("冲突备份/") && v === external)).toBe(true);
  expect(JSON.parse(files.data.get(TAXONOMY_PATH)!).tags[0].name).toBe("浏览器名称");
});

it("reloads disk-side renames while preserving relationships", async () => {
  const { lib, pages, files, engine } = await setup();
  const id = pages[0].tagIds![0], disk = JSON.parse(files.data.get(TAXONOMY_PATH)!);
  disk.tags[0].name = "外部重命名";
  files.data.set(TAXONOMY_PATH, JSON.stringify(disk));
  await engine.run();
  expect(lib.entries[pages[0].id].page.tagIds).toEqual([id]);
  expect(lib.entries[pages[0].id].page.tags).toEqual(["外部重命名"]);
});

it("keeps unknown references visible as conflicts instead of silently reassigning", async () => {
  const { lib, pages, files, engine } = await setup();
  files.data.set(`原始数据/${pages[0].id}.json`, JSON.stringify({ ...pages[0], tagIds: ["missing"] }));
  await engine.run(); expect(lib.entries[pages[0].id].issue?.kind).toBe("invalid");
});

it("preserves article identity and annotation anchors when display fields change", async () => {
  const { pages } = await setup();
  const p = pages[0]; p.title = "新标题"; p.url = "https://example.com/moved";
  const anchor = { exact: "original quote", prefix: "", suffix: "", start: 0, end: 14 };
  p.annotations = [{ id: crypto.randomUUID(), text: "整理后的摘录", note: "新批注", color: "yellow", tags: [], anchor, createdAt: p.createdAt, updatedAt: p.updatedAt }];
  const parsed = await parsePage(JSON.stringify(p), p.id);
  expect(parsed.id).toBe(p.id); expect(parsed.annotations[0].anchor).toEqual(anchor);
});

it("retains both versions when a disk registry refresh overlaps a browser edit", async () => {
  const { lib, files, engine, pages } = await setup();
  const before = structuredClone(lib), latest = structuredClone(lib);
  act(latest, { operation: "rename", kind: "tags", id: pages[0].tagIds![0], name: "浏览器并发修改" });
  const disk = JSON.parse(files.data.get(TAXONOMY_PATH)!); disk.tags[0].name = "磁盘并发修改";
  const external = JSON.stringify(disk); files.data.set(TAXONOMY_PATH, external);
  await engine.run();
  mergeSyncResult(latest, before, lib);
  expect(latest.taxonomyIssue).toBeTruthy();
  await new SyncEngine(latest, files, async () => {}).run();
  expect(files.data.get(TAXONOMY_PATH)).toBe(external);
  expect(latest.taxonomy!.tags[0].name).toBe("浏览器并发修改");
  expect(latest.taxonomyIssue).toBeTruthy();
});

it("does not mistake display-name refresh for a concurrent article content edit", async () => {
  const { lib, files, engine, pages } = await setup();
  const before = structuredClone(lib), latest = structuredClone(lib);
  latest.entries[pages[0].id].page.comment = "新评论";
  latest.entries[pages[0].id].dirty = true;
  const disk = JSON.parse(files.data.get(TAXONOMY_PATH)!); disk.tags[0].name = "外部名称";
  files.data.set(TAXONOMY_PATH, JSON.stringify(disk));
  await engine.run(); mergeSyncResult(latest, before, lib);
  expect(latest.entries[pages[0].id].issue).toBeUndefined();
  migrateTaxonomy(latest);
  expect(latest.entries[pages[0].id].page.comment).toBe("新评论");
  expect(latest.entries[pages[0].id].page.tags).toEqual(["外部名称"]);
});

it("rejects a batch that would exceed the tag limit before changing any selected page", async () => {
  const { lib, pages } = await setup();
  pages[1].tagIds = Array.from({ length: 500 }, (_, n) => ensureTaxon(lib, "tags", `tag ${n}`).id);
  const extra = ensureTaxon(lib, "tags", "too many");
  const before = JSON.stringify(lib);
  expect(() => bulkTaxonomy(lib, selected(pages), { operation: "add-tags", ids: [extra.id] }, taxonomyToken(lib))).toThrow();
  expect(JSON.stringify(lib)).toBe(before);
});

it("merges pending browser names on first connection without leaving stale page IDs", async () => {
  const { lib: diskLib, files } = await setup();
  const local = emptyLibrary();
  migrateTaxonomy(local);
  const localTag = ensureTaxon(local, "tags", "旧标签");
  const p = structuredClone(Object.values(diskLib.entries)[0].page);
  p.tagIds = [localTag.id];
  local.entries[p.id] = { page: p, baseJson: files.data.get(`原始数据/${p.id}.json`)!, baseMd: markdown(p), dirty: false, mdDirty: false };
  await new SyncEngine(local, files, async () => {}).run();
  expect(local.entries[p.id].page.tagIds).toEqual(Object.values(diskLib.entries)[0].page.tagIds);
  expect(local.entries[p.id].issue).toBeUndefined();
});

it("reconciles repeated checkpoints after importing external ID references without false conflicts", async () => {
  const { lib, files, pages } = await setup();
  const before = structuredClone(lib), latest = structuredClone(lib);
  const disk = JSON.parse(files.data.get(TAXONOMY_PATH)!);
  const tag = { id: crypto.randomUUID(), name: "外部新标签" }; disk.tags.push(tag);
  files.data.set(TAXONOMY_PATH, JSON.stringify(disk));
  files.data.set(`原始数据/${pages[0].id}.json`, JSON.stringify({ ...pages[0], tagIds: [...pages[0].tagIds!, tag.id] }));
  let checkpoints = 0;
  await new SyncEngine(lib, files, async () => {
    checkpoints++;
    mergeSyncResult(latest, before, lib);
  }).run();
  expect(checkpoints).toBeGreaterThan(1);
  expect(latest.entries[pages[0].id].issue).toBeUndefined();
  expect(latest.entries[pages[0].id].dirty).toBe(false);
  expect(latest.entries[pages[0].id].page.tagIds).toContain(tag.id);
});
