import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  emptyLibrary,
  folderName,
  markdown,
  pageId,
  type Library,
  type Page,
} from "../src/model";
import type { Files } from "../src/files";
import type { Request } from "../src/protocol";
import type { ImportFile, ImportResult } from "../src/metadata-import";

const harness = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  files: null as Files | null,
  failSave: false,
  listener: null as
    ((m: unknown, s: unknown, reply: (r: any) => void) => void) | null,
  alarm: null as ((alarm: { name: string }) => void) | null,
}));
vi.mock("../src/db", () => ({
  get: async (key: string) =>
    key === "library"
      ? structuredClone(harness.values.get(key))
      : harness.values.get(key),
  set: async (key: string, value: unknown) => {
    if (key === "library" && harness.failSave)
      throw Error("IndexedDB unavailable");
    harness.values.set(key, key === "library" ? structuredClone(value) : value);
  },
}));
vi.mock("../src/files", () => ({
  DirectoryFiles: vi.fn(function () {
    return harness.files;
  }),
}));

let page: Page, data: Map<string, string>, writes: string[];
const saved = () => harness.values.get("library") as Library;
const send = (m: Request) =>
  new Promise<{ ok: boolean; data: Library; error?: string }>((reply) => {
    harness.listener!(m, { id: "extension", tab: { url: page.url } }, reply);
  });
const tag = (name: string) =>
  send({
    type: "page-tag",
    url: page.url,
    title: page.title,
    favicon: "",
    tag: name,
    action: "add",
  });
const tick = () => vi.advanceTimersByTimeAsync(100);
const importFiles = (files: ImportFile[], url = "chrome-extension://extension/sidepanel.html") =>
  new Promise<{ ok: boolean; data: ImportResult; error?: string }>(reply => {
    harness.listener!({ type: "import-metadata", files }, { id: "extension", url }, reply);
  });
const setting = (enabled: boolean) =>
  new Promise<{ ok: boolean; data: Library; error?: string }>((reply) => {
    harness.listener!({ type: "auto-generate-markdown", enabled },
      { id: "extension", url: "chrome-extension://extension/settings.html" }, reply);
  });
const rate = (rating: number | null, expectedRating: number | null) =>
  send({ type: "page-rating", url: page.url, title: page.title, favicon: "", rating, expectedRating });

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  harness.values.clear();
  harness.failSave = false;
  const url = "https://example.com/article",
    id = await pageId(url),
    title = "Article";
  page = {
    schemaVersion: 1,
    id,
    url,
    originalUrl: url,
    title,
    favicon: "",
    folderName: folderName(title, id),
    markdownFile: "Article.md",
    createdAt: "2026-09-17T01:00:00.000Z",
    updatedAt: "2026-09-17T01:00:00.000Z",
    tags: [],
    annotations: [],
    category: "未分类",
  };
  const lib = { ...emptyLibrary(), autoGenerateMarkdown: true },
    raw = JSON.stringify(page, null, 2) + "\n",
    md = markdown(page);
  lib.entries[id] = {
    page,
    baseJson: raw,
    baseMd: md,
    dirty: false,
    mdDirty: false,
  };
  data = new Map([
    [`data/${id}.json`, raw],
    ["Article.md", md],
  ]);
  writes = [];
  harness.values.set("library", structuredClone(lib));
  harness.values.set("root", {
    name: "test",
    queryPermission: async () => "granted",
  });
  harness.files = {
    listJson: async () => [...data.keys()].filter(path => path.startsWith("data/")).map(path => path.slice(5)),
    read: async (path) => data.get(path) ?? null,
    write: async (path, value) => {
      writes.push(path);
      data.set(path, value);
    },
    remove: async (path) => {
      data.delete(path);
    },
  };
  vi.stubGlobal("chrome", {
    runtime: {
      id: "extension",
      getURL: (p: string) => `chrome-extension://extension/${p}`,
      onMessage: {
        addListener: (fn: typeof harness.listener) => {
          harness.listener = fn;
        },
      },
      sendMessage: async () => {},
    },
    tabs: { query: async () => [], sendMessage: async () => {} },
    sidePanel: { setPanelBehavior: async () => {} },
    alarms: {
      create: vi.fn(),
      onAlarm: {
        addListener: (fn: typeof harness.alarm) => {
          harness.alarm = fn;
        },
      },
    },
  });
  await import("../src/background");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("defaults existing libraries to off and keeps that choice across a worker restart", async () => {
  delete saved().autoGenerateMarkdown;
  data.delete("Article.md");
  const snapshot = await send({ type: "snapshot", refresh: true });
  expect(snapshot.data.autoGenerateMarkdown).toBe(false);
  expect((await send({ type: "page-comment", url: page.url, title: page.title, favicon: "", comment: "默认不导出", expectedComment: "" })).ok).toBe(true);
  await tick();
  await vi.waitFor(() => expect(saved().entries[page.id].dirty).toBe(false));
  expect(data.has("Article.md")).toBe(false);
  expect(JSON.parse(data.get(`data/${page.id}.json`)!).comment).toBe("默认不导出");
  expect((await setting(true)).ok).toBe(true);
  expect(data.get("Article.md")).toContain("默认不导出");
  vi.clearAllTimers();
  vi.resetModules();
  await import("../src/background");
  expect((await send({ type: "snapshot" })).data.autoGenerateMarkdown).toBe(true);
  expect((await setting(false)).ok).toBe(true);
  const exported = data.get("Article.md");
  await send({ type: "page-comment", url: page.url, title: page.title, favicon: "", comment: "关闭后的修改", expectedComment: "默认不导出" });
  harness.alarm!({ name: "retry-sync" });
  await tick();
  await vi.waitFor(() => expect(saved().entries[page.id].dirty).toBe(false));
  expect(data.get("Article.md")).toBe(exported);
  expect(saved().entries[page.id].mdDirty).toBe(false);
});

it("restricts the preference to settings and preserves it when browser storage fails", async () => {
  expect((await send({ type: "auto-generate-markdown", enabled: false })).ok).toBe(false);
  expect((await setting("false" as unknown as boolean)).ok).toBe(false);
  harness.failSave = true;
  expect((await setting(false)).ok).toBe(false);
  expect(saved().autoGenerateMarkdown).toBe(true);
  expect(writes).toEqual([]);
});

it("queues disabling after an active write and keeps subsequent saves in JSON", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const write = harness.files!.write;
  let started = false;
  harness.files!.write = async (path, value) => {
    if (path.endsWith(".md")) { started = true; await blocked; }
    await write(path, value);
  };
  await send({ type: "page-comment", url: page.url, title: page.title, favicon: "", comment: "写入中", expectedComment: "" });
  await tick();
  await vi.waitFor(() => expect(started).toBe(true));
  const disabling = setting(false);
  release();
  expect((await disabling).data.autoGenerateMarkdown).toBe(false);
  const exported = data.get("Article.md");
  await send({ type: "page-comment", url: page.url, title: page.title, favicon: "", comment: "稍后修改", expectedComment: "写入中" });
  await tick();
  await vi.waitFor(() => expect(saved().entries[page.id].dirty).toBe(false));
  expect(data.get("Article.md")).toBe(exported);
  expect(JSON.parse(data.get(`data/${page.id}.json`)!).comment).toBe("稍后修改");
});

it("persists ratings without highlights and restores them from disk", async () => {
  const result = await rate(4, null);
  expect(result.ok).toBe(true);
  expect(saved().entries[page.id].page.rating).toBe(4);
  await tick();
  await vi.waitFor(() => expect(saved().entries[page.id].dirty).toBe(false));
  expect(JSON.parse(data.get(`data/${page.id}.json`)!).rating).toBe(4);
  const snapshot = await send({ type: "snapshot", refresh: true });
  expect(snapshot.data.entries[page.id].page.rating).toBe(4);
  expect(snapshot.data.entries[page.id].page.annotations).toHaveLength(0);
});

it("rejects stale ratings and supports clearing without changing other page fields", async () => {
  await rate(2, null);
  expect((await rate(5, null)).ok).toBe(false);
  expect(saved().entries[page.id].page.rating).toBe(2);
  const cleared = await rate(null, 2);
  expect(cleared.ok).toBe(true);
  expect(cleared.data.entries[page.id].page.rating).toBeUndefined();
  expect(cleared.data.entries[page.id].page.title).toBe(page.title);
  expect(cleared.data.entries[page.id].page.category).toBe(page.category);
  await tick();
  await vi.waitFor(() => expect(saved().entries[page.id].dirty).toBe(false));
  expect(JSON.parse(data.get(`data/${page.id}.json`)!).rating).toBeUndefined();
});

it("rejects ratings outside the five integer star levels without persisting", async () => {
  for (const value of [0, -1, 6, 2.5, NaN, "3", undefined]) {
    expect((await rate(value as number, null)).ok).toBe(false);
    expect(saved().entries[page.id].page.rating).toBeUndefined();
  }
  expect(writes).toHaveLength(0);
});

it("exports ratings to existing Markdown and protects external rating edits", async () => {
  const comment = await send({ type: "page-comment", url: page.url, title: page.title, favicon: "", comment: "Review", expectedComment: "" });
  expect(comment.ok).toBe(true);
  await rate(5, null);
  await tick();
  await vi.waitFor(() => expect(saved().entries[page.id].mdDirty).toBe(false));
  expect(data.get("Article.md")).toContain("rating: 5\n");
  const disk = JSON.parse(data.get(`data/${page.id}.json`)!);
  disk.rating = 3;
  disk.updatedAt = "2026-09-18T01:00:00.000Z";
  data.set(`data/${page.id}.json`, JSON.stringify(disk));
  const response = await new Promise<any>(reply => harness.listener!(
    { type: "page-rating", url: page.url, title: page.title, favicon: "", rating: 1, expectedRating: 5 },
    { id: "extension", url: "chrome-extension://extension/dashboard.html" }, reply));
  expect(response.ok).toBe(false);
  expect(response.error).toContain("评分");
  expect(saved().entries[page.id].page.rating).toBe(3);
});

it("acknowledges durable tags before disk writes and coalesces a burst", async () => {
  const a = await tag("A"),
    b = await tag("B");
  expect(a.ok && b.ok).toBe(true);
  expect(b.data.entries[page.id].page.tags).toEqual(["A", "B"]);
  expect(saved().entries[page.id].page.tags).toEqual(["A", "B"]);
  expect(writes).toHaveLength(0);
  await tick();
  await vi.waitFor(() => expect(saved().status).toBe("已保存到本地文件"));
  expect(writes.filter(path => path !== "分类标签.json")).toEqual([`data/${page.id}.json`]);
  expect(data.has("Article.md")).toBe(false);
  expect(saved().status).toBe("已保存到本地文件");
});

it("accepts another tag and snapshots while an earlier file write is stalled", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = harness.files!.write;
  let started = false;
  harness.files!.write = async (path, value) => {
    started = true;
    await blocked;
    await write(path, value);
  };
  await tag("A");
  await tick();
  await vi.waitFor(() => expect(started).toBe(true));
  const next = await tag("B");
  expect(next.data.entries[page.id].page.tags).toEqual(["A", "B"]);
  expect(
    (await send({ type: "snapshot" })).data.entries[page.id].page.tags,
  ).toEqual(["A", "B"]);
  release();
  await tick();
  await tick();
  await vi.waitFor(() => expect(saved().status).toBe("已保存到本地文件"));
  expect(saved().entries[page.id].page.tags).toEqual(["A", "B"]);
  expect(JSON.parse(data.get(`data/${page.id}.json`)!).tags).toEqual([
    "A",
    "B",
  ]);
  expect(saved().entries[page.id].issue).toBeUndefined();
});

it("reports browser-save failure without starting a file write", async () => {
  harness.failSave = true;
  const response = await tag("A");
  expect(response.ok).toBe(false);
  expect(response.error).toContain("IndexedDB unavailable");
  await tick();
  expect(writes).toHaveLength(0);
  expect(saved().entries[page.id].page.tags).toEqual([]);
});

it("keeps an external JSON edit and exposes its conflict after the early reply", async () => {
  const raw = `data/${page.id}.json`;
  data.set(raw, JSON.stringify({ ...page, tags: ["disk"] }));
  expect((await tag("local")).ok).toBe(true);
  await tick();
  await vi.waitFor(() =>
    expect(saved().entries[page.id].issue?.kind).toBe("json"),
  );
  expect(saved().entries[page.id].page.tags).toEqual(["local"]);
  expect(JSON.parse(data.get(raw)!).tags).toEqual(["disk"]);
});

it("retries durable pending changes after a worker restart", async () => {
  await tag("pending");
  vi.clearAllTimers();
  vi.resetModules();
  await import("../src/background");
  expect(chrome.alarms.create).toHaveBeenCalledWith("retry-sync", {
    periodInMinutes: 1,
  });
  harness.alarm!({ name: "retry-sync" });
  await tick();
  await vi.waitFor(() => expect(saved().status).toBe("已保存到本地文件"));
  expect(JSON.parse(data.get(`data/${page.id}.json`)!).tags).toEqual([
    "pending",
  ]);
  expect(saved().status).toBe("已保存到本地文件");
});

it("persists a manual title without renaming files or letting metadata overwrite it", async () => {
  const response = await send({ type: "page-title", url: page.url, title: "  手动标题  ", favicon: "", expectedTitle: page.title });
  expect(response.ok).toBe(true);
  await tag("设计"); // Carries the old automatically detected title.
  await tick();
  await vi.waitFor(() => expect(saved().status).toBe("已保存到本地文件"));
  const updated = saved().entries[page.id].page;
  expect(updated.title).toBe("手动标题");
  expect(updated.markdownFile).toBe("Article.md");
  expect(updated.folderName).toBe(page.folderName);
  expect(JSON.parse(data.get(`data/${page.id}.json`)!).title).toBe("手动标题");
  const stale = await send({ type: "page-title", url: page.url, title: "旧页面的修改", favicon: "", expectedTitle: page.title });
  expect(stale.ok).toBe(false);
  expect(stale.error).toContain("标题已在其他");
  expect(saved().entries[page.id].page.title).toBe("手动标题");
});

it("creates a title-only page and rejects invalid or stale title requests", async () => {
  harness.values.set("library", emptyLibrary());
  for (const title of ["   ", "x".repeat(1001)]) {
    expect((await send({ type: "page-title", url: page.url, title, favicon: "", expectedTitle: null })).ok).toBe(false);
    expect(Object.keys(saved().entries)).toHaveLength(0);
  }
  expect((await send({ type: "page-title", url: page.url, title: "独立标题", favicon: "", expectedTitle: null })).ok).toBe(true);
  expect(saved().entries[page.id].page.annotations).toEqual([]);
  expect(saved().entries[page.id].page.title).toBe("独立标题");
  expect((await send({ type: "page-title", url: page.url, title: "覆盖", favicon: "", expectedTitle: null })).ok).toBe(false);
});

async function importedPage() {
  const url = "https://example.com/imported", id = await pageId(url);
  return { ...page, id, url, originalUrl: url, title: "Imported", folderName: folderName("Imported", id), comment: "导入评论", tags: ["外部标签"] };
}
it("imports a batch into the current directory and reports invalid files separately", async () => {
  saved().autoGenerateMarkdown = false;
  const incoming = await importedPage();
  const result = await importFiles([{ name: "export.json", text: JSON.stringify(incoming) }, { name: "invalid.json", text: "{}" }]);
  expect(result.ok).toBe(true);
  expect(result.data.items.map(item => item.status)).toEqual(["saved", "error"]);
  expect(result.data.directoryName).toBe("test");
  expect(JSON.parse(data.get(`data/${incoming.id}.json`)!).comment).toBe("导入评论");
  expect(result.data.library.entries[incoming.id].page.tags).toEqual(["外部标签"]);
  expect(result.data.library.entries[incoming.id].page.markdownFile).toBeUndefined();
  const repeated = await importFiles([{ name: "same.json", text: JSON.stringify({ ...incoming, comment: "覆盖" }) }], "chrome-extension://extension/dashboard.html");
  expect(repeated.data.items[0].status).toBe("skipped");
  expect(saved().entries[incoming.id].page.comment).toBe("导入评论");
});

it("refuses imports from websites and without a writable connected directory", async () => {
  const files = [{ name: "export.json", text: JSON.stringify(await importedPage()) }];
  for (const url of [page.url, "chrome-extension://extension/settings.html"]) {
    expect((await importFiles(files, url)).ok).toBe(false);
  }
  harness.values.delete("root");
  expect((await importFiles(files)).error).toContain("连接本地文件夹");
  harness.values.set("root", { queryPermission: async () => "denied" });
  expect((await importFiles(files)).error).toContain("重新授权");
  expect(writes).toEqual([]);
  expect(Object.keys(saved().entries)).toEqual([page.id]);
});

it("reports an import as pending when disk writing fails, then retries after worker restart", async () => {
  saved().autoGenerateMarkdown = false;
  const incoming = await importedPage();
  const write = harness.files!.write;
  harness.files!.write = async (path, value) => {
    if (path === `data/${incoming.id}.json`) throw Error("disk full");
    await write(path, value);
  };
  const result = await importFiles([{ name: "export.json", text: JSON.stringify(incoming) }]);
  expect(result.data.items[0].status).toBe("pending");
  expect(result.data.items[0].message).toContain("disk full");
  expect(data.has(`data/${incoming.id}.json`)).toBe(false);
  expect(saved().entries[incoming.id].dirty).toBe(true);
  harness.files!.write = write;
  vi.resetModules(); await import("../src/background");
  harness.alarm!({ name: "retry-sync" });
  await tick();
  await vi.waitFor(() => expect(saved().entries[incoming.id].dirty).toBe(false));
  expect(JSON.parse(data.get(`data/${incoming.id}.json`)!).comment).toBe("导入评论");
});
