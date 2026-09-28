import { describe, expect, it } from "vitest";
import { deletePageData } from "../src/page-delete";
import { markdown, type Entry, type Page } from "../src/model";

function fixture() {
  const id = "0123456789abcdef";
  const imagePath = `media/${id}/11111111-1111-4111-8111-111111111111.png`;
  const elementImagePath = `media/${id}/22222222-2222-4222-8222-222222222222.png`;
  const page: Page = {
    schemaVersion: 4, id, url: "https://example.com/article", originalUrl: "https://example.com/article",
    title: "测试网页", favicon: "", folderName: `测试网页--${id}`,
    createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z",
    annotations: [{ id: "22222222-2222-4222-8222-222222222222", text: "图片", note: "", tags: [], color: "yellow", imagePath: elementImagePath,
      anchor: { kind: "element", tag: "img", path: "body > img:nth-of-type(1)", identity: [], exact: "img · 图片", text: "", label: "图片", resources: ["https://example.com/image.png"], context: [] },
      createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z" }],
    videoMarks: [{ id: "11111111-1111-4111-8111-111111111111", kind: "screenshot",
      videoKey: "video", time: 3, text: "截图", note: "批注", color: "yellow", imagePath,
      createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z" }],
    tags: [], tagIds: [], category: "未分类", categoryId: "category:uncategorized",
    markdownFile: "测试网页.md",
  };
  const entry: Entry = { page, baseJson: JSON.stringify(page) + "\n", baseMd: markdown(page), dirty: false, mdDirty: false };
  const data = new Map<string, string | Blob>([
    [`data/${id}.json`, entry.baseJson!], [page.markdownFile!, entry.baseMd!],
    [imagePath, new Blob(["image"])], [elementImagePath, new Blob(["element image"])], ["other.json", "keep"],
  ]);
  const files = {
    async read(path: string) { const value = data.get(path); return typeof value === "string" ? value : null; },
    async write(path: string, value: string) { data.set(path, value); },
    async remove(path: string) { data.delete(path); },
    async readBlob(path: string) { const value = data.get(path); return value instanceof Blob ? value : null; },
    async writeBlob(path: string, value: Blob) { data.set(path, value); },
  };
  return { entry, files, data, id, imagePath, elementImagePath };
}

describe("delete whole page", () => {
  it("removes the exact page JSON, generated Markdown and saved images", async () => {
    const { entry, files, data, id, imagePath, elementImagePath } = fixture();
    let committed = false;
    await deletePageData(entry, files, async () => { committed = true; });
    expect(committed).toBe(true);
    expect([...data.keys()]).toEqual(["other.json"]);
    expect(data.has(`data/${id}.json`)).toBe(false);
    expect(data.has(imagePath)).toBe(false);
    expect(data.has(elementImagePath)).toBe(false);
  });

  it("blocks deletion when the JSON or Markdown changed outside the extension", async () => {
    const { entry, files, data, id } = fixture();
    data.set(`data/${id}.json`, "external edit");
    await expect(deletePageData(entry, files, async () => {})).rejects.toThrow("JSON 已改变");
    data.set(`data/${id}.json`, entry.baseJson!);
    data.set(entry.page.markdownFile!, "manual note");
    await expect(deletePageData(entry, files, async () => {})).rejects.toThrow("Markdown 有手工修改");
    expect(data.size).toBe(5);
  });

  it("restores all files when committing the browser deletion fails", async () => {
    const { entry, files, data, id, imagePath, elementImagePath } = fixture();
    await expect(deletePageData(entry, files, async () => { throw Error("storage failed"); })).rejects.toThrow("storage failed");
    expect(data.get(`data/${id}.json`)).toBe(entry.baseJson);
    expect(data.get(entry.page.markdownFile!)).toBe(entry.baseMd);
    expect(await (data.get(imagePath) as Blob).text()).toBe("image");
    expect(await (data.get(elementImagePath) as Blob).text()).toBe("element image");
  });
});
