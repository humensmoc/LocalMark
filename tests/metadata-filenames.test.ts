import { expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { DirectoryFiles } from "../src/files";
import { emptyLibrary, folderName, markdown, pageId, type Page } from "../src/model";
import { metadataFileId, metadataFileName, metadataFilePath } from "../src/metadata-names";
import { migrateTaxonomy, TAXONOMY_PATH } from "../src/taxonomy";
import { SyncEngine } from "../src/sync";

// Real temporary Windows files behind the same handle contract as the browser.
async function disk() {
  const path = await mkdtemp(join(tmpdir(), "localmark-json-names-"));
  const faults: { close?: (path: string) => Promise<void>; remove?: (path: string) => Promise<void> } = {};
  const writes: string[] = [];
  async function checked<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new DOMException("Missing", "NotFoundError");
      if ((e as NodeJS.ErrnoException).code === "ENOTEMPTY") throw new DOMException("Not empty", "InvalidModificationError");
      throw e;
    }
  }
  function file(full: string) {
    return {
      name: basename(full), kind: "file",
      async getFile() {
        const data = await checked(() => readFile(full));
        return { size: data.length, text: async () => data.toString("utf8") };
      },
      async createWritable() {
        let value = "";
        return {
          async write(next: string) { value = next; },
          async close() { await faults.close?.(full); await writeFile(full, value, "utf8"); writes.push(full); },
          async abort() {},
        };
      },
    };
  }
  function directory(full: string): FileSystemDirectoryHandle {
    return {
      name: basename(full), kind: "directory",
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const target = join(full, name);
        if (options?.create) await mkdir(target, { recursive: true });
        await checked(() => stat(target));
        return directory(target);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const target = join(full, name);
        if (options?.create) {
          try { await writeFile(target, "", { flag: "wx" }); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
        }
        await checked(() => stat(target));
        return file(target);
      },
      async *entries() {
        for (const item of await readdir(full, { withFileTypes: true }))
          yield [item.name, item.isDirectory() ? directory(join(full, item.name)) : file(join(full, item.name))];
      },
      async removeEntry(name: string) {
        const target = join(full, name);
        await faults.remove?.(target);
        await checked(async () => { if ((await stat(target)).isDirectory()) await rmdir(target); else await unlink(target); });
      },
    } as unknown as FileSystemDirectoryHandle;
  }
  const root = directory(path);
  return { path, root, faults, writes, files: new DirectoryFiles(root) };
}

async function fixture() {
  const d = await disk(), lib = emptyLibrary();
  const url = "https://example.com/metadata", id = await pageId(url);
  const title = "飞书测试文章";
  const page: Page = { schemaVersion: 1, id, url, originalUrl: url, title, favicon: "", folderName: folderName(title, id),
    createdAt: "2026-09-20T01:00:00.000Z", updatedAt: "2026-09-20T01:00:00.000Z", tags: [], category: "未分类", annotations: [], rating: 4 };
  lib.entries[id] = { page, dirty: true, mdDirty: true, baseJson: null, baseMd: null };
  migrateTaxonomy(lib);
  const entry = lib.entries[id];
  const raw = JSON.stringify(entry.page, null, 2) + "\n";
  const legacy = `${id}.json`, name = metadataFileName(title, id);
  async function seedLegacy() {
    await mkdir(join(d.path, "原始数据"));
    await writeFile(join(d.path, "原始数据", legacy), raw);
    lib.taxonomyBase = JSON.stringify(lib.taxonomy, null, 2) + "\n";
    lib.taxonomyDirty = false;
    await writeFile(join(d.path, TAXONOMY_PATH), lib.taxonomyBase);
    entry.baseJson = raw;
    entry.dirty = entry.mdDirty = false;
  }
  const run = () => new SyncEngine(lib, new DirectoryFiles(d.root), async () => {}).run();
  const dateDir = join(d.path, "data", "2026-09", "20");
  const names = () => readdir(dateDir);
  const read = (file = name) => readFile(join(dateDir, file), "utf8");
  const readLegacy = (file = legacy) => readFile(join(d.path, "原始数据", file), "utf8");
  return { ...d, dateDir, lib, entry, id, raw, legacy, name, seedLegacy, run, names, read, readLegacy };
}

it("uses readable, Windows-safe names and stable suffixes for duplicate titles", () => {
  const id = "0123456789abcdef";
  expect(metadataFileName("\u202c飞书: 反馈/测试", id)).toBe(`飞书_ 反馈_测试--${id}.json`);
  expect(metadataFileName("CON", id)).toBe(`_CON--${id}.json`);
  expect(metadataFileName("\u202c", id)).toBe(`未命名网页--${id}.json`);
  expect(metadataFileName("长标题".repeat(100), id).length).toBeLessThan(100);
  expect(metadataFileName("同名文章", id)).not.toBe(metadataFileName("同名文章", "fedcba9876543210"));
  expect(metadataFileId(`飞书:展示--${id}.json`)).toBe(id);
  expect(metadataFileId(`${id}.json`)).toBe(id);
  expect(metadataFileId(`../${id}.json`)).toBeUndefined();
  expect(metadataFilePath("标题", id, "2026-09-20T01:00:00.000Z")).toBe(`data/2026-09/20/标题--${id}.json`);
  expect(() => metadataFilePath("标题", id, "not a date")).toThrow("创建日期无效");
});

it("writes a readable JSON immediately for a page with only a rating", async () => {
  const f = await fixture();
  await f.run();
  expect(await f.names()).toEqual([f.name]);
  expect(JSON.parse(await f.read())).toEqual(f.entry.page);
  expect(f.entry.page.markdownFile).toBeUndefined();
  expect(f.entry.issue).toBeUndefined();
});

it("migrates clean old JSON byte for byte, reloads it and does not rewrite it again", async () => {
  const f = await fixture();
  await f.seedLegacy();
  await f.run();
  expect(await f.names()).toEqual([f.name]);
  expect(await f.read()).toBe(f.raw);
  await expect(stat(join(f.path, "原始数据"))).rejects.toMatchObject({ code: "ENOENT" });
  const reloaded = emptyLibrary();
  await new SyncEngine(reloaded, new DirectoryFiles(f.root), async () => {}).run();
  expect(reloaded.entries[f.id].page).toEqual(f.entry.page);
  const writes = f.writes.length;
  await f.run();
  expect(f.writes).toHaveLength(writes);
});

it("renames JSON after a title edit while keeping Markdown and article identity", async () => {
  const f = await fixture();
  f.lib.autoGenerateMarkdown = true;
  f.entry.page.comment = "保留评论";
  await f.run();
  const md = f.entry.page.markdownFile;
  f.entry.page.title = "新的文章标题";
  f.entry.dirty = f.entry.mdDirty = true;
  await f.run();
  const next = metadataFileName(f.entry.page.title, f.id);
  expect(await f.names()).toEqual([next]);
  expect(JSON.parse(await f.read(next))).toEqual(f.entry.page);
  expect(f.entry.page.markdownFile).toBe(md);
  expect(await readFile(join(f.path, md!), "utf8")).toBe(markdown(f.entry.page));
});

it("imports external edits to a readable file and protects concurrent browser edits", async () => {
  const f = await fixture();
  await f.run();
  const external = { ...f.entry.page, title: "外部改名", rating: 2 };
  await writeFile(join(f.dateDir, f.name), JSON.stringify(external));
  await f.run();
  expect(f.entry.page.rating).toBe(2);
  const renamed = metadataFileName(external.title, f.id);
  expect(await f.names()).toEqual([renamed]);
  const conflict = JSON.stringify({ ...external, rating: 3 });
  await writeFile(join(f.dateDir, renamed), conflict);
  f.entry.page.rating = 5; f.entry.dirty = true;
  await f.run();
  expect(f.entry.issue?.kind).toBe("json");
  expect(await f.read(renamed)).toBe(conflict);
});

it("retries an interrupted old-file cleanup without duplicates or data loss", async () => {
  const f = await fixture();
  await f.seedLegacy();
  f.faults.remove = async path => { if (basename(path) === f.legacy) throw Error("locked"); };
  await f.run();
  expect(await f.readLegacy()).toBe(f.raw);
  expect(await f.read()).toBe(f.raw);
  expect(f.entry.issue?.kind).toBe("io");
  delete f.faults.remove;
  await f.run();
  expect(await f.names()).toEqual([f.name]);
  expect(f.entry.issue).toBeUndefined();
});

it("never removes the original if writing the readable copy fails", async () => {
  const f = await fixture();
  await f.seedLegacy();
  f.faults.close = async path => { if (basename(path) === f.name) throw Error("disk full"); };
  await f.run();
  expect(await f.readLegacy()).toBe(f.raw);
  expect(f.entry.issue?.kind).toBe("io");
});

it("keeps divergent duplicate JSON files intact and never picks a winning version", async () => {
  const f = await fixture();
  await f.seedLegacy();
  const external = JSON.stringify({ ...f.entry.page, rating: 1 });
  await mkdir(f.dateDir, { recursive: true });
  await writeFile(join(f.dateDir, f.name), external);
  await f.run();
  expect(f.entry.issue?.kind).toBe("invalid");
  expect(await f.read()).toBe(external);
  expect(await f.readLegacy()).toBe(f.raw);
  expect(await f.names()).toEqual([f.name]);
});

it("migrates flat data files, keeps the creation date on edits, and imports another month", async () => {
  const f = await fixture();
  await f.seedLegacy();
  await mkdir(join(f.path, "data"));
  await writeFile(join(f.path, "data", f.name), f.raw);
  await f.run();
  expect(await f.read()).toBe(f.raw);
  await expect(stat(join(f.path, "data", f.name))).rejects.toMatchObject({ code: "ENOENT" });
  f.entry.page.updatedAt = "2026-10-21T03:00:00.000Z";
  f.entry.dirty = true;
  await f.run();
  expect(JSON.parse(await f.read()).updatedAt).toBe(f.entry.page.updatedAt);
  const other = { ...f.entry.page, id: "fedcba9876543210", title: "另一个月份", createdAt: "2024-12-05T03:00:00.000Z" };
  other.folderName = folderName(other.title, other.id);
  const otherPath = join(f.path, metadataFilePath(other.title, other.id, other.createdAt));
  await mkdir(join(f.path, "data/2024-12/05"), { recursive: true });
  await writeFile(otherPath, JSON.stringify(other));
  const restored = emptyLibrary();
  await new SyncEngine(restored, new DirectoryFiles(f.root), async () => {}).run();
  expect(Object.keys(restored.entries).sort()).toEqual([f.id, other.id].sort());
  expect(restored.entries[other.id].page.title).toBe(other.title);
});

it("reports malformed JSON in nested data without changing it", async () => {
  const f = await fixture();
  await f.run();
  const value = "invalid json";
  await writeFile(join(f.dateDir, "broken.json"), value);
  await f.run();
  expect(f.lib.errors.some(error => error.includes("broken.json"))).toBe(true);
  expect(await readFile(join(f.dateDir, "broken.json"), "utf8")).toBe(value);
});
