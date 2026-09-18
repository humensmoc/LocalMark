import { ensureTaxon } from "../src/taxonomy";
import { describe, expect, it } from "vitest";
import { DirectoryFiles } from "../src/files";
import { emptyLibrary, folderName, markdownFileName, pageId, previousMarkdown, type Page } from "../src/model";
import { SyncEngine } from "../src/sync";

// Native Chromium rejects format characters in path components. OPFS and
// node:fs do not enforce the same restriction, so model it at the handle API.
function nativeFiles() {
  const data = new Map<string, string>();
  const directories = new Set<string>();
  const handle = (prefix = ""): FileSystemDirectoryHandle => ({
    kind: "directory",
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      if (/\p{Cf}/u.test(name)) throw new TypeError("Name is not allowed.");
      const path = prefix + name;
      if (options?.create) directories.add(path);
      if (!directories.has(path)) throw new DOMException("Missing", "NotFoundError");
      return handle(path + "/");
    },
    async *entries() {
      for (const path of directories) {
        if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
          yield [path.slice(prefix.length), handle(path + "/")];
      }
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (/\p{Cf}/u.test(name)) throw new TypeError("Name is not allowed.");
      const path = prefix + name;
      if (!options?.create && !data.has(path)) throw new DOMException("Missing", "NotFoundError");
      return {
        async getFile() { return { size: data.get(path)!.length, text: async () => data.get(path)! }; },
        async createWritable() {
          return {
            async write(value: string) { data.set(path, value); },
            async close() {}, async abort() {},
          };
        },
      };
    },
    async removeEntry(name: string) {
      if (/\p{Cf}/u.test(name)) throw new TypeError("Name is not allowed.");
      data.delete(prefix + name);
      directories.delete(prefix + name);
    },
  }) as unknown as FileSystemDirectoryHandle;
  return { root: handle(), data, directories };
}

async function pendingPage() {
  const url = "https://example.com/feishu", id = await pageId(url);
  const title = "\u200d\u200c\u2064\ufeff\u202c《喵呜岛》BUG 反馈表 - 飞书云文档";
  const page: Page = {
    schemaVersion: 1, id, url, originalUrl: url, title, favicon: "",
    folderName: `${title}--${id}`, tags: ["设计方法论"], category: "游戏分析",
    createdAt: "2026-09-17T01:00:00.000Z", updatedAt: "2026-09-17T01:00:00.000Z",
    annotations: [], comment: "记录反馈表的使用说明",
  };
  const lib = emptyLibrary();
  lib.entries[id] = { page, baseJson: null, baseMd: null, dirty: true, mdDirty: true,
    issue: { kind: "io", message: "文件写入失败：Name is not allowed." } };
  return { lib, page, id };
}

describe("invisible title characters and native directory sync", () => {
  it("generates visible filenames without modifying the title", () => {
    expect(markdownFileName("\u200d\u202c飞书\ufeff文档")).toBe("飞书文档.md");
    expect(folderName("\u200d\u202c飞书文档", "123")).toBe("飞书文档--123");
    expect(markdownFileName("\u200d\u202c")).toBe("未命名网页.md");
    expect(markdownFileName("\u200dCON")).toBe("_CON.md");
    expect(markdownFileName("\u200d".repeat(180) + "标题")).toBe("标题.md");
  });

  it("recovers a failed first save and persists subsequent tag and category edits", async () => {
    const { lib, page, id } = await pendingPage();
    const { root, data } = nativeFiles();
    const engine = new SyncEngine(lib, new DirectoryFiles(root), async () => {});
    await engine.run(new Set([id]));
    expect(lib.entries[id].issue).toBeUndefined();
    expect(page.markdownFile).toBe("《喵呜岛》BUG 反馈表 - 飞书云文档.md");
    for (const tags of [["交互设计"], ["交互设计", "开发复盘"], []]) {
      page.tagIds = tags.map(name => ensureTaxon(lib, "tags", name).id);
      page.categoryId = ensureTaxon(lib, "categories", "游戏设计").id;
      lib.entries[id].dirty = lib.entries[id].mdDirty = true;
      await engine.run(new Set([id]));
      expect(lib.status).toBe("已保存到本地文件");
      expect(JSON.parse(data.get(`原始数据/${id}.json`)!).tags).toEqual(tags);
      expect(data.get(page.markdownFile!)).toContain('category: "游戏设计"');
    }
    expect([...data.keys()]).toHaveLength(3);
  });

  it.each([false, true])("preserves an existing legacy directory and manual-edit checks (manual=%s)", async (manual) => {
    const { lib, page, id } = await pendingPage();
    const { root, data, directories } = nativeFiles();
    const oldPath = `${page.folderName}/标注.md`;
    directories.add(page.folderName);
    const old = manual ? "人工修改的旧文档" : previousMarkdown(page);
    data.set(oldPath, old);
    await new SyncEngine(lib, new DirectoryFiles(root), async () => {}).run(new Set([id]));
    if (manual) {
      expect(lib.entries[id].issue?.kind).toBe("markdown");
      expect(data.get(oldPath)).toBe(old);
      expect(page.markdownFile).toBeUndefined();
    } else {
      expect(lib.entries[id].issue).toBeUndefined();
      expect(data.has(oldPath)).toBe(false);
      expect(data.has(page.markdownFile!)).toBe(true);
    }
  });

  it("does not hide permission errors or invalid normal paths", async () => {
    const { root } = nativeFiles();
    root.getDirectoryHandle = async () => { throw new DOMException("Denied", "NotAllowedError"); };
    await expect(new DirectoryFiles(root).read("\u202c标题/标注.md")).rejects.toMatchObject({ name: "NotAllowedError" });
    root.getDirectoryHandle = async () => { throw new TypeError("Name is not allowed."); };
    await expect(new DirectoryFiles(root).read("invalid/标注.md")).rejects.toThrow("Name is not allowed.");
    await expect(new DirectoryFiles(root).write("\u202c标题/标注.md", "data")).rejects.toThrow("Name is not allowed.");
  });
});
