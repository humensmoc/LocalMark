import { describe, expect, it } from "vitest";
import { deletePageData } from "../src/page-delete";
import { markdown, type Entry, type Page } from "../src/model";

function fixture() {
  const id = "0123456789abcdef";
  const imagePath = `media/${id}/11111111-1111-4111-8111-111111111111.png`;
  const page: Page = {
    schemaVersion: 4, id, url: "https://example.com/article", originalUrl: "https://example.com/article",
    title: "测试网页", favicon: "", folderName: `测试网页--${id}`,
    createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z",
    annotations: [], videoMarks: [{ id: "11111111-1111-4111-8111-111111111111", kind: "screenshot",
      videoKey: "video", time: 3, text: "截图", note: "批注", color: "yellow", imagePath,
      createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z" }],
    tags: [], tagIds: [], category: "未分类", categoryId: "category:uncategorized",
    markdownFile: "测试网页.md",
  };
  const entry: Entry = { page, baseJson: JSON.stringify(page) + "\n", baseMd: markdown(page), dirty: false, mdDirty: false };
  const data = new Map<string, string | Blob>([
    [`data/${id}.json`, entry.baseJson!], [page.markdownFile!, entry.baseMd!],
    [imagePath, new Blob(["image"])], ["other.json", "keep"],
  ]);
  const files = {
    async read(path: string) { const value = data.get(path); return typeof value === "string" ? value : null; },
    async write(path: string, value: string) { data.set(path, value); },
    async remove(path: string) { data.delete(path); },
    async readBlob(path: string) { const value = data.get(path); return value instanceof Blob ? value : null; },
    async writeBlob(path: string, value: Blob) { data.set(path, value); },
  };
  return { entry, files, data, id, imagePath };
}

describe("delete whole page", () => {
  it("removes the exact page JSON, generated Markdown and screenshot", async () => {
    const { entry, files, data, id, imagePath } = fixture();
    let committed = false;
    await deletePageData(entry, files, async () => { committed = true; });
    expect(committed).toBe(true);
    expect([...data.keys()]).toEqual(["other.json"]);
    expect(data.has(`data/${id}.json`)).toBe(false);
    expect(data.has(imagePath)).toBe(false);
  });

  it("blocks deletion when the JSON or Markdown changed outside the extension", async () => {
    const { entry, files, data, id } = fixture();
    data.set(`data/${id}.json`, "external edit");
    await expect(deletePageData(entry, files, async () => {})).rejects.toThrow("JSON 已改变");
    data.set(`data/${id}.json`, entry.baseJson!);
    data.set(entry.page.markdownFile!, "manual note");
    await expect(deletePageData(entry, files, async () => {})).rejects.toThrow("Markdown 有手工修改");
    expect(data.size).toBe(4);
  });

  it("restores all files when committing the browser deletion fails", async () => {
    const { entry, files, data, id, imagePath } = fixture();
    await expect(deletePageData(entry, files, async () => { throw Error("storage failed"); })).rejects.toThrow("storage failed");
    expect(data.get(`data/${id}.json`)).toBe(entry.baseJson);
    expect(data.get(entry.page.markdownFile!)).toBe(entry.baseMd);
    expect(await (data.get(imagePath) as Blob).text()).toBe("image");
  });
});
