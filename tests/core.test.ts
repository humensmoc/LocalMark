// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  canonicalUrl,
  pageId,
  folderName,
  textLink,
  markdown,
  compactMarkdown,
  titledMarkdown,
  previousMarkdown,
  markdownFileName,
  parsePage,
  emptyLibrary,
  type Page,
  type Entry,
  DEFAULT_CATEGORY,
} from "../src/model";
import { capture, indexText, locate } from "../src/anchors";
import { SyncEngine } from "../src/sync";
import type { Files } from "../src/files";
Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const markId = "12b942f7-841f-4f5d-bdd5-8d404706125c";
async function fixture(): Promise<Page> {
  const url = "https://example.com/article?q=1";
  const id = await pageId(url);
  return {
    schemaVersion: 1,
    category: DEFAULT_CATEGORY,
    id,
    url,
    originalUrl: url,
    title: "CON: A / title",
    favicon: "",
    folderName: folderName("CON: A / title", id),
    createdAt: "2026-09-15T01:00:00.000Z",
    updatedAt: "2026-09-15T01:00:00.000Z",
    annotations: [
      {
        id: markId,
        text: "hello world",
        note: "笔记\n第二行",
        tags: ["设计"],
        color: "yellow",
        anchor: {
          exact: "hello world",
          prefix: "before ",
          suffix: " after",
          start: 7,
          end: 18,
        },
        createdAt: "2026-09-15T01:00:00.000Z",
        updatedAt: "2026-09-15T01:00:00.000Z",
      },
    ],
    tags: ["设计"],
  };
}
class MemoryFiles implements Files {
  async remove(path: string) {
    this.data.delete(path);
  }
  data = new Map<string, string>();
  writes: string[] = [];
  fail = "";
  async read(p: string) {
    return this.data.get(p) ?? null;
  }
  async write(p: string, v: string) {
    if (p === this.fail) throw Error("disk unavailable");
    this.data.set(p, v);
    this.writes.push(p);
  }
  async listJson() {
    return [...this.data.keys()]
      .filter((p) => p.startsWith("原始数据/"))
      .map((p) => p.slice("原始数据/".length));
  }
}
async function setup() {
  const p = await fixture(),
    files = new MemoryFiles(),
    lib = emptyLibrary();
  const e: Entry = {
    page: p,
    baseJson: null,
    baseMd: null,
    dirty: true,
    mdDirty: true,
  };
  lib.entries[p.id] = e;
  const engine = new SyncEngine(lib, files, async () => {});
  return {
    p,
    e,
    files,
    lib,
    engine,
    json: `原始数据/${p.id}.json`,
    md: markdownFileName(p.title),
  };
}
describe("Markdown content eligibility", () => {
  it.each([undefined, "", " \n\t "])("saves JSON without Markdown for empty content (%s)", async (comment) => {
    const { p, e, files, lib, engine, json } = await setup();
    p.annotations = [];
    p.comment = comment;
    await engine.run();
    expect(files.data.has(json)).toBe(true);
    expect([...files.data.keys()].some(path => path.endsWith(".md"))).toBe(false);
    expect(p.markdownFile).toBeUndefined();
    expect(e.dirty || e.mdDirty || e.issue).toBeFalsy();
    expect(lib.status).toBe("已保存到本地文件");
    await engine.run();
    expect([...files.data.keys()].some(path => path.endsWith(".md"))).toBe(false);
  });

  it("creates for a description, removes after clearing, and recreates when content returns", async () => {
    const { p, e, files, engine, json, md } = await setup();
    const marks = p.annotations;
    p.annotations = [];
    await engine.run();
    p.comment = "网页描述";
    e.dirty = e.mdDirty = true;
    await engine.run();
    expect(files.data.get(md)).toContain("网页描述");
    p.comment = "  ";
    e.dirty = e.mdDirty = true;
    await engine.run();
    expect(files.data.has(md)).toBe(false);
    expect(files.data.has(json)).toBe(true);
    expect(e.baseMd).toBeNull();
    p.annotations = marks.map(m => ({ ...m, note: "" }));
    e.dirty = e.mdDirty = true;
    await engine.run();
    expect(files.data.get(md)).toContain("hello world");
    expect(e.issue).toBeUndefined();
  });

  it.each([false, true])("cleans untouched empty exports on first import (legacy=%s)", async (legacy) => {
    const { p, files, json, md } = await setup();
    p.annotations = [];
    if (!legacy) p.markdownFile = md;
    const path = legacy ? `${p.folderName}/标注.md` : md;
    files.data.set(json, JSON.stringify(p));
    files.data.set(path, legacy ? previousMarkdown(p) : markdown(p));
    const lib = emptyLibrary();
    await new SyncEngine(lib, files, async () => {}).run();
    expect(files.data.has(path)).toBe(false);
    expect(files.data.has(json)).toBe(true);
    expect(lib.entries[p.id].issue).toBeUndefined();
  });

  it("preserves manual edits when the last highlight is removed, with backup on resolution", async () => {
    const { p, e, files, engine, md } = await setup();
    await engine.run();
    files.data.set(md, "手工笔记");
    p.annotations = [];
    e.dirty = e.mdDirty = true;
    await engine.run();
    expect(e.issue?.kind).toBe("markdown");
    expect(files.data.get(md)).toBe("手工笔记");
    await engine.resolve(p.id, "local");
    expect(files.data.has(md)).toBe(false);
    expect([...files.data.entries()].some(([path, value]) => path.startsWith("冲突备份/") && value === "手工笔记")).toBe(true);
    expect(e.issue).toBeUndefined();
  });

  it("retries failed removal without losing the JSON checkpoint", async () => {
    const { p, e, files, engine, md, json } = await setup();
    await engine.run();
    p.annotations = [];
    e.dirty = e.mdDirty = true;
    const remove = files.remove.bind(files);
    files.remove = async () => { throw Error("permission denied"); };
    await engine.run();
    expect(e.issue?.kind).toBe("io");
    expect(JSON.parse(files.data.get(json)!).annotations).toEqual([]);
    expect(files.data.has(md)).toBe(true);
    files.remove = remove;
    await engine.run();
    expect(files.data.has(md)).toBe(false);
    expect(e.issue).toBeUndefined();
  });
});

describe("identity and export", () => {
  it("migrates old pages to one category and preserves all existing small tags", async () => {
    const p = await fixture();
    const { category: _category, ...legacy } = p;
    legacy.tags = ["游戏营销", "Steam", "Demo"];
    const files = new MemoryFiles(), lib = emptyLibrary();
    legacy.markdownFile = markdownFileName(p.title);
    files.data.set(`原始数据/${p.id}.json`, JSON.stringify(legacy));
    files.data.set(legacy.markdownFile, compactMarkdown({ ...p, tags: legacy.tags }));
    await new SyncEngine(lib, files, async () => {}).run();
    const stored = JSON.parse(files.data.get(`原始数据/${p.id}.json`)!);
    expect(stored.category).toBe(DEFAULT_CATEGORY);
    expect(stored.tags).toEqual(legacy.tags);
    expect(lib.entries[p.id].issue).toBeUndefined();
    for (const category of [null, "", "  ", [], ["设计", "营销"]])
      await expect(parsePage(JSON.stringify({ ...p, category }))).rejects.toThrow();
    expect((await parsePage(JSON.stringify({ ...p, category: " 游戏营销 " }))).category).toBe("游戏营销");
  });
  it("exports Obsidian properties without duplicating titles, metadata or internal IDs", async () => {
    const p = await fixture();
    p.tags = ["设计", "a: b", 'quote"slash\\', "line\nbreak", "#topic", "true"];
    const output = markdown(p);
    expect(output.startsWith("---\n")).toBe(true);
    const end = output.indexOf("\n---\n", 4);
    expect(parseYaml(output.slice(4, end))).toEqual({
      created: p.createdAt, updated: p.updatedAt, category: p.category, tags: p.tags, source: p.url,
    });
    const body = output.slice(end + 5);
    expect(body).not.toMatch(/^# /m);
    expect(body).not.toMatch(/来源：|创建：|更新：|网页标签：/);
    expect(output).not.toContain("<!--");
    expect(output).not.toContain(p.id);
    expect(output).not.toContain(markId);
    expect(output).toContain(textLink(p, p.annotations[0].anchor));
    expect(p.annotations[0].id).toBe(markId);
    p.tags = [];
    expect(parseYaml(markdown(p).split("\n---\n")[0].slice(4)).tags).toEqual([]);
  });
  it("upgrades compact exports and migrates JSON while retaining content and identity", async () => {
    for (const modified of [false, true]) {
      const p = await fixture();
      p.comment = "整页评论";
      p.markdownFile = markdownFileName(p.title);
      const files = new MemoryFiles(), lib = emptyLibrary();
      const raw = JSON.stringify(p);
      const old = compactMarkdown(p) + (modified ? "\n手工补充\n" : "");
      files.data.set(`原始数据/${p.id}.json`, raw);
      files.data.set(p.markdownFile, old);
      await new SyncEngine(lib, files, async () => {}).run();
      expect(files.data.get(p.markdownFile)).toBe(modified ? old : markdown(p));
      const migrated = JSON.parse(files.data.get(`原始数据/${p.id}.json`)!);
      expect(migrated.schemaVersion).toBe(2);
      expect(migrated.id).toBe(p.id);
      expect(migrated.annotations).toEqual(p.annotations);
      expect(lib.entries[p.id].issue?.kind).toBe(modified ? "markdown" : undefined);
    }
  });
  it("recognizes an untouched marker-free export but preserves an edited same-title file", async () => {
    for (const modified of [false, true]) {
      const { p, e, files, engine, md } = await setup();
      const existing = markdown(p) + (modified ? "\n个人内容\n" : "");
      files.data.set(md, existing);
      await engine.run();
      expect(files.data.get(md)).toBe(existing);
      expect(e.page.markdownFile).toBe(modified ? markdownFileName(p.title, `--${p.id}`) : md);
      expect(e.issue).toBeUndefined();
    }
  });
  it("updates an old cached export while preserving annotation IDs and new edits", async () => {
    const { p, e, files, engine, json, md } = await setup();
    p.markdownFile = md;
    const raw = JSON.stringify(p), old = compactMarkdown(p);
    files.data.set(json, raw);
    files.data.set(md, old);
    e.baseJson = raw;
    e.baseMd = old;
    p.annotations[0].note = "更新的批注";
    p.comment = "新评论";
    await engine.run();
    expect(e.issue).toBeUndefined();
    expect(files.data.get(md)).toBe(markdown(p));
    expect(files.data.get(md)).toContain("更新的批注");
    expect(JSON.parse(files.data.get(json)!).annotations[0].id).toBe(markId);
    files.data.set(md, markdown(p).replace('tags:\n  - "设计"', 'tags:\n  - "手工标签"'));
    await engine.run();
    expect(e.issue?.kind).toBe("markdown");
    expect(files.data.get(md)).toContain("手工标签");
  });
  it("round-trips standalone comments, reads external edits, and clears both exports", async () => {
    const { p, e, files, engine, json, md } = await setup();
    p.annotations = [];
    p.comment = "整体想法\n<script> & **纯文本**";
    await engine.run();
    expect(JSON.parse(files.data.get(json)!).comment).toBe(p.comment);
    expect(files.data.get(md)).toContain("## 网页评论\n\n整体想法  \n\\<script\\> & \\*\\*纯文本\\*\\*");
    expect(files.data.get(md)).not.toContain("回到原文并高亮");
    const restored = emptyLibrary();
    const reopened = new SyncEngine(restored, files, async () => {});
    await reopened.run();
    expect(restored.entries[p.id].page.comment).toBe(p.comment);
    const external = JSON.parse(files.data.get(json)!);
    external.comment = "外部修改的网页评论";
    files.data.set(json, JSON.stringify(external));
    await engine.run();
    expect(e.page.comment).toBe(external.comment);
    expect(files.data.get(md)).toContain(external.comment);
    e.page.comment = "";
    e.dirty = true;
    await engine.run();
    expect(JSON.parse(files.data.get(json)!).comment).toBe("");
    expect(files.data.has(md)).toBe(false);
    expect(JSON.parse(files.data.get(json)!).tags).toEqual(["设计"]);
  });
  it("accepts old JSON without a comment and rejects malformed comments", async () => {
    const p = await fixture();
    expect((await parsePage(JSON.stringify(p))).comment).toBeUndefined();
    for (const comment of [123, null, "x".repeat(100001)]) {
      await expect(parsePage(JSON.stringify({ ...p, comment }))).rejects.toThrow();
    }
  });
  it("exports quotes, optional notes and links without annotation headings", async () => {
    const p = await fixture();
    expect(markdown(p)).toContain("> hello world\n\n笔记  \n第二行\n\n[回到原文并高亮]");
    expect(markdown(p)).not.toMatch(/^#{2,3} /m);
    for (const note of ["", " \n\t"]) {
      p.annotations[0].note = note;
      expect(markdown(p)).toContain("> hello world\n\n[回到原文并高亮]");
      expect(markdown(p)).not.toContain("未填写批注");
    }
    expect(markdown(p)).toContain("回到原文并高亮");
  });
  it("upgrades untouched titled exports on reconnect but preserves manual changes", async () => {
    for (const modified of [false, true]) {
      const p = await fixture();
      p.annotations[0].note = "";
      p.markdownFile = markdownFileName(p.title);
      const files = new MemoryFiles(), lib = emptyLibrary();
      const old = titledMarkdown(p) + (modified ? "\n个人补充\n" : "");
      files.data.set(`原始数据/${p.id}.json`, JSON.stringify(p));
      files.data.set(p.markdownFile, old);
      await new SyncEngine(lib, files, async () => {}).run();
      expect(files.data.get(p.markdownFile)).toBe(modified ? old : markdown(p));
      expect(lib.entries[p.id].issue?.kind).toBe(modified ? "markdown" : undefined);
    }
  });
  it("uses title filenames and avoids overwriting a same-title document", async () => {
    const { p, files, lib, engine } = await setup();
    const plain = markdownFileName(p.title);
    files.data.set(plain, "别的文档");
    await engine.run();
    expect(files.data.get(plain)).toBe("别的文档");
    expect(lib.entries[p.id].page.markdownFile).toBe(
      markdownFileName(p.title, `--${p.id}`),
    );
    expect(files.data.get(lib.entries[p.id].page.markdownFile!)).toContain(
      "hello world",
    );
  });
  it("keeps manually edited legacy Markdown until the user resolves it", async () => {
    const p = await fixture(),
      files = new MemoryFiles(),
      lib = emptyLibrary();
    files.data.set(`原始数据/${p.id}.json`, JSON.stringify(p));
    files.data.set(`${p.folderName}/标注.md`, "人工保留内容");
    await new SyncEngine(lib, files, async () => {}).run();
    expect(lib.entries[p.id].issue?.kind).toBe("markdown");
    expect(files.data.get(`${p.folderName}/标注.md`)).toBe("人工保留内容");
    expect(files.data.has(markdownFileName(p.title))).toBe(false);
  });
  it("migrates legacy annotation tags once and honors subsequently removed page tags", async () => {
    const p = await fixture();
    const { tags: _tags, ...legacy } = p;
    const migrated = await parsePage(JSON.stringify(legacy));
    expect(migrated.tags).toEqual(["设计"]);
    migrated.tags = [];
    expect((await parsePage(JSON.stringify(migrated))).tags).toEqual([]);
    expect(markdown({ ...migrated, tags: ["网页主题"] })).toContain(
      'tags:\n  - "网页主题"',
    );
    expect(markdown(migrated)).not.toContain("标签：`设计`");
  });
  it("upgrades legacy JSON and generated Markdown without treating it as a manual edit", async () => {
    const p = await fixture();
    const { tags: _tags, ...legacy } = p;
    const files = new MemoryFiles();
    files.data.set(`原始数据/${p.id}.json`, JSON.stringify(legacy));
    files.data.set(`${p.folderName}/标注.md`, previousMarkdown(p, true));
    const lib = emptyLibrary();
    await new SyncEngine(lib, files, async () => {}).run();
    expect(lib.entries[p.id].issue).toBeUndefined();
    expect(JSON.parse(files.data.get(`原始数据/${p.id}.json`)!).tags).toEqual([
      "设计",
    ]);
    expect(files.data.has(`${p.folderName}/标注.md`)).toBe(false);
    expect(files.data.get(markdownFileName(p.title))).toContain(
      'tags:\n  - "设计"',
    );
  });
  it("keeps queries and SPA routes, removes ordinary anchors and directives", () => {
    expect(canonicalUrl("https://example.com/a?q=2#part:~:text=hi")).toBe(
      "https://example.com/a?q=2",
    );
    expect(canonicalUrl("https://example.com/#/a:~:text=hi")).toBe(
      "https://example.com/#/a",
    );
  });
  it("gives distinct pages stable safe folders", async () => {
    const a = await pageId("https://x.test/a#p"),
      b = await pageId("https://x.test/a");
    expect(a).toBe(b);
    expect(await pageId("https://x.test/a?q=1")).not.toBe(b);
    expect(folderName("CON", a)).toBe("_CON--" + a);
    expect(folderName("x/y:?", a)).not.toMatch(/[/:?]/);
  });
  it("exports no color metadata and encodes fragment syntax", async () => {
    const p = await fixture();
    expect(markdown(p)).toContain("笔记");
    expect(markdown(p)).not.toContain("yellow");
    expect(
      textLink(p, { ...p.annotations[0].anchor, exact: "a-b & c" }),
    ).toContain("a%2Db%20%26%20c");
    expect(markdown(p)).not.toContain("<!-- annotation:");
    expect(markdown(p)).not.toContain(markId);
  });
  it("rejects path traversal and mismatched IDs while allowing independent display quotes", async () => {
    const p = await fixture();
    await expect(
      parsePage(JSON.stringify({ ...p, folderName: "../evil" })),
    ).rejects.toThrow();
    await expect(
      parsePage(JSON.stringify({ ...p, url: "https://evil.test/" })),
    ).rejects.toThrow();
    await expect(
      parsePage(
        JSON.stringify({
          ...p,
          annotations: [...p.annotations, ...p.annotations],
        }),
      ),
    ).rejects.toThrow();
    p.annotations[0].text = "编辑后的展示文字";
    const edited = await parsePage(JSON.stringify(p));
    expect(edited.annotations[0].anchor.exact).toBe("hello world");
    expect(edited.annotations[0].text).toBe("编辑后的展示文字");
  });
});
describe("text anchors", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  it("captures exactly across inline nodes without changing DOM", () => {
    document.body.innerHTML = "<p>before <b>hello</b> world after</p>";
    const p = document.querySelector("p")!,
      r = document.createRange();
    r.setStart(p.querySelector("b")!.firstChild!, 0);
    r.setEnd(p.lastChild!, 6);
    const original = document.body.innerHTML;
    const a = capture(r)!;
    expect(a.exact).toBe("hello world");
    expect(locate(a, indexText())?.toString()).toBe("hello world");
    expect(document.body.innerHTML).toBe(original);
  });
  it("normalizes whitespace and retains CJK Unicode text", () => {
    document.body.innerHTML = "<p>中文  \n摘录 test</p>";
    const r = document.createRange();
    r.selectNodeContents(document.querySelector("p")!);
    expect(capture(r)?.exact).toBe("中文 摘录 test");
  });
  it("includes rendered paragraph separators and excludes hidden ancestors", () => {
    document.body.innerHTML =
      '<p>first</p><p>second</p><div style="display:none"><b>hidden text</b></div>';
    expect(indexText().text).toBe("first second");
  });
  it("does not anchor repeated text by stale offset alone", () => {
    document.body.innerHTML = "<p>same</p><p>same</p>";
    expect(
      locate(
        { exact: "same", prefix: "", suffix: "", start: 0, end: 4 },
        indexText(),
      ),
    ).toBeNull();
  });
  it("does not move a formerly repeated quote to the remaining wrong occurrence", () => {
    document.body.innerHTML = "<p>wrong same context</p>";
    expect(
      locate(
        {
          exact: "same",
          prefix: "original ",
          suffix: " quote",
          start: 0,
          end: 4,
          occurrences: 2,
        },
        indexText(),
      ),
    ).toBeNull();
  });
  it("uses context after unrelated text is inserted and excludes editors", () => {
    document.body.innerHTML =
      "<p>A hello world Z</p><p>B hello world Y</p><textarea>secret</textarea>";
    const idx = indexText();
    expect(idx.text).not.toContain("secret");
    expect(
      locate(
        { exact: "hello world", prefix: "B ", suffix: " Y", start: 0, end: 11 },
        idx,
      )?.toString(),
    ).toBe("hello world");
  });
  it("returns unresolved when text disappears and supports later reappearance", () => {
    const a = { exact: "target", prefix: "", suffix: "", start: 0, end: 6 };
    document.body.innerHTML = "<p>gone</p>";
    expect(locate(a, indexText())).toBeNull();
    document.body.innerHTML = "<p>target</p>";
    expect(locate(a, indexText())?.toString()).toBe("target");
  });
});
describe("real-file synchronization contract", () => {
  it("writes one page JSON and one Markdown idempotently", async () => {
    const { engine, files, json, md, e } = await setup();
    await engine.run();
    expect(files.data.size).toBe(3);
    expect(files.data.has(json)).toBe(true);
    expect(files.data.has(md)).toBe(true);
    expect(e.dirty).toBe(false);
    const n = files.writes.length;
    await engine.run();
    expect(files.writes.length).toBe(n);
  });
  it("reads external JSON edits and regenerates Markdown", async () => {
    const { engine, files, json, md, e, p } = await setup();
    await engine.run();
    const external = structuredClone(p);
    external.annotations[0].note = "外部修改";
    files.data.set(json, JSON.stringify(external));
    await engine.run();
    expect(e.page.annotations[0].note).toBe("外部修改");
    expect(files.data.get(md)).toContain("外部修改");
  });
  it("rebuilds an empty cache from disk", async () => {
    const { engine, files, p } = await setup();
    await engine.run();
    const lib = emptyLibrary();
    await new SyncEngine(lib, files, async () => {}).run();
    expect(lib.entries[p.id].page.annotations[0].note).toBe("笔记\n第二行");
    expect(lib.status).toBe("已保存到本地文件");
  });
  it("preserves concurrent versions and backs up the losing one", async () => {
    const { engine, files, json, e, p } = await setup();
    await engine.run();
    const ext = structuredClone(p);
    ext.annotations[0].note = "disk";
    files.data.set(json, JSON.stringify(ext));
    e.page.annotations[0].note = "local";
    e.dirty = true;
    await engine.run();
    expect(e.issue?.kind).toBe("json");
    expect(files.data.get(json)).toContain("disk");
    await engine.resolve(p.id, "local");
    expect(files.data.get(json)).toContain("local");
    expect(
      [...files.data.entries()].some(
        ([k, v]) => k.startsWith("冲突备份/") && v.includes("disk"),
      ),
    ).toBe(true);
  });
  it("protects hand-edited Markdown and archives on explicit regeneration", async () => {
    const { engine, files, md, e, p } = await setup();
    await engine.run();
    files.data.set(md, "manual note");
    await engine.run();
    expect(e.issue?.kind).toBe("markdown");
    expect(files.data.get(md)).toBe("manual note");
    await engine.resolve(p.id, "local");
    expect(files.data.get(md)).toContain("笔记");
    expect([...files.data.values()]).toContain("manual note");
  });
  it("does not lose invalid JSON or cached annotations", async () => {
    const { engine, files, json, e } = await setup();
    await engine.run();
    files.data.set(json, "{invalid");
    await engine.run();
    expect(e.issue?.kind).toBe("invalid");
    expect(files.data.get(json)).toBe("{invalid");
    expect(e.page.annotations).toHaveLength(1);
  });
  it("recovers partial JSON-success/Markdown-failure without duplicate entries", async () => {
    const { engine, files, json, md, e } = await setup();
    files.fail = md;
    await engine.run();
    expect(files.data.has(json)).toBe(true);
    expect(e.dirty).toBe(false);
    expect(e.mdDirty).toBe(true);
    expect(e.issue?.kind).toBe("io");
    files.fail = "";
    await engine.run();
    expect(e.mdDirty).toBe(false);
    expect(files.data.get(md)?.match(/\[回到原文并高亮\]/g)).toHaveLength(1);
    expect(JSON.parse(files.data.get(json)!).annotations[0].id).toBe(markId);
  });
  it("requires a choice for externally deleted JSON", async () => {
    const { engine, files, json, p, e, lib } = await setup();
    await engine.run();
    files.data.delete(json);
    await engine.run();
    expect(e.issue?.kind).toBe("missing");
    expect(files.data.has(json)).toBe(false);
    await engine.resolve(p.id, "disk");
    expect(lib.entries[p.id]).toBeUndefined();
    expect([...files.data.keys()].some((k) => k.startsWith("冲突备份/"))).toBe(
      true,
    );
  });
});
