import { describe, expect, it } from "vitest";
import {
  emptyLibrary,
  folderName,
  markdown,
  pageId,
  type Page,
} from "../src/model";
import { SyncEngine } from "../src/sync";
import { mergeSyncResult } from "../src/sync-state";

export async function fixture(count = 1) {
  const lib = emptyLibrary(),
    data = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const url = `https://example.com/${i}`,
      id = await pageId(url),
      title = `Page ${i}`;
    const page: Page = {
      schemaVersion: 1,
      id,
      url,
      originalUrl: url,
      title,
      favicon: "",
      folderName: folderName(title, id),
      markdownFile: `${title}.md`,
      createdAt: "2026-09-17T01:00:00.000Z",
      updatedAt: "2026-09-17T01:00:00.000Z",
      annotations: [],
      tags: [],
      category: "未分类",
    };
    const baseJson = JSON.stringify(page, null, 2) + "\n",
      baseMd = markdown(page);
    lib.entries[id] = { page, baseJson, baseMd, dirty: false, mdDirty: false };
    data.set(`原始数据/${id}.json`, baseJson);
    data.set(page.markdownFile!, baseMd);
  }
  const reads: string[] = [],
    writes: string[] = [];
  let lists = 0,
    persists = 0;
  const files = {
    async listJson() {
      lists++;
      return [...data.keys()]
        .filter((p) => p.startsWith("原始数据/"))
        .map((p) => p.split("/")[1]);
    },
    async read(p: string) {
      reads.push(p);
      return data.get(p) ?? null;
    },
    async write(p: string, value: string) {
      writes.push(p);
      data.set(p, value);
    },
    async remove(p: string) {
      data.delete(p);
    },
  };
  const engine = new SyncEngine(lib, files, async () => {
    persists++;
  });
  const entry = Object.values(lib.entries)[0],
    id = entry.page.id;
  return {
    lib,
    data,
    files,
    engine,
    entry,
    id,
    reads,
    writes,
    counts: () => ({ lists, persists }),
  };
}

describe("incremental sync", () => {
  it("does constant file work for a single tag in a 100-page library", async () => {
    const f = await fixture(100);
    f.entry.page.tags = ["设计"];
    f.entry.dirty = f.entry.mdDirty = true;
    await f.engine.run(new Set([f.id]));
    expect(f.reads).toEqual([
      `原始数据/${f.id}.json`,
      `原始数据/${f.id}.json`,
      f.entry.page.markdownFile,
    ]);
    expect(f.writes).toHaveLength(2);
    // JSON-success recovery checkpoint + final batch, independent of library size.
    expect(f.counts()).toEqual({ lists: 0, persists: 2 });
    expect(f.lib.status).toBe("已保存到本地文件");
  });

  it("batches clean full-refresh persistence", async () => {
    const f = await fixture(100);
    await f.engine.run();
    expect(f.counts()).toEqual({ lists: 1, persists: 1 });
    expect(f.writes).toHaveLength(0);
  });

  it.each(["json", "markdown", "missing"])(
    "keeps %s conflicts during incremental writes",
    async (kind) => {
      const f = await fixture(2),
        raw = `原始数据/${f.id}.json`,
        md = f.entry.page.markdownFile!;
      const other = Object.values(f.lib.entries)[1];
      other.issue = { kind: "invalid", message: "unrelated error" };
      f.lib.errors = [`${other.page.id}.json：unrelated error`];
      f.entry.page.tags = ["local"];
      f.entry.dirty = f.entry.mdDirty = true;
      if (kind === "json")
        f.data.set(
          raw,
          JSON.stringify({ ...f.entry.page, tags: ["external"] }),
        );
      if (kind === "markdown") f.data.set(md, "manual content");
      if (kind === "missing") f.data.delete(raw);
      const protectedPath = kind === "markdown" ? md : raw,
        protectedValue = f.data.get(protectedPath);
      await f.engine.run(new Set([f.id]));
      expect(f.entry.issue?.kind).toBe(kind);
      expect(f.data.get(protectedPath)).toBe(protectedValue);
      expect(other.issue?.message).toBe("unrelated error");
      expect(f.lib.errors).toHaveLength(1);
    },
  );

  it("retains the JSON checkpoint if Markdown writing fails, then retries", async () => {
    const f = await fixture();
    f.entry.page.tags = ["new"];
    f.entry.dirty = f.entry.mdDirty = true;
    const write = f.files.write;
    f.files.write = async (path, value) => {
      if (path.endsWith(".md")) throw Error("disk failure");
      await write(path, value);
    };
    await f.engine.run(new Set([f.id]));
    expect(f.entry.dirty).toBe(false);
    expect(f.entry.mdDirty).toBe(true);
    expect(f.entry.baseJson).toBe(f.data.get(`原始数据/${f.id}.json`));
    f.files.write = write;
    await f.engine.run(new Set([f.id]));
    expect(f.entry.issue).toBeUndefined();
    expect(f.data.get(f.entry.page.markdownFile!)).toContain("new");
  });
});

describe("concurrent save reconciliation", () => {
  it("keeps newer tags and the writer's disk bases across both checkpoints", async () => {
    const f = await fixture();
    f.entry.page.tags = ["A"];
    f.entry.dirty = f.entry.mdDirty = true;
    const before = structuredClone(f.lib),
      latest = structuredClone(f.lib);
    latest.entries[f.id].page.tags.push("B");
    const engine = new SyncEngine(f.lib, f.files, async () => {
      mergeSyncResult(latest, before, f.lib);
      expect(latest.entries[f.id].page.tags).toEqual(["A", "B"]);
    });
    await engine.run(new Set([f.id]));
    expect(latest.entries[f.id].dirty).toBe(true);
    expect(latest.entries[f.id].baseJson).toBe(
      f.data.get(`原始数据/${f.id}.json`),
    );
    await new SyncEngine(latest, f.files, async () => {}).run(new Set([f.id]));
    expect(latest.entries[f.id].issue).toBeUndefined();
    expect(JSON.parse(f.data.get(`原始数据/${f.id}.json`)!).tags).toEqual([
      "A",
      "B",
    ]);
  });

  it("surfaces a disk edit imported during a concurrent local save", async () => {
    const f = await fixture(),
      before = structuredClone(f.lib),
      latest = structuredClone(f.lib);
    latest.entries[f.id].page.tags = ["local"];
    latest.entries[f.id].dirty = true;
    f.data.set(
      `原始数据/${f.id}.json`,
      JSON.stringify({ ...f.entry.page, tags: ["disk"] }),
    );
    await f.engine.run();
    mergeSyncResult(latest, before, f.lib);
    expect(latest.entries[f.id].page.tags).toEqual(["local"]);
    expect(latest.entries[f.id].issue?.kind).toBe("json");
    expect(latest.entries[f.id].issue?.external).toContain('"disk"');
  });
});
