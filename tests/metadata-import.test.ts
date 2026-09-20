import { expect, it } from "vitest";
import { emptyLibrary, folderName, pageId, type Page } from "../src/model";
import { prepareMetadataImport, validateImportBatch } from "../src/metadata-import";
import { ensureTaxon, migrateTaxonomy } from "../src/taxonomy";

async function page(suffix = "a"): Promise<Page> {
  const url = `https://example.com/import/${suffix}`, id = await pageId(url);
  return { schemaVersion: 2, id, url, originalUrl: url, title: suffix, favicon: "", folderName: folderName(suffix, id),
    createdAt: "2024-12-05T02:00:00.000Z", updatedAt: "2026-09-20T02:00:00.000Z", category: "新分类", categoryId: "foreign-category",
    tags: ["旧标签", "新标签"], tagIds: ["foreign-a", "foreign-b"], rating: 4, comment: "网页评论", markdownFile: "foreign.md",
    annotations: [{ id: "12b942f7-841f-4f5d-bdd5-8d404706125c", text: "高亮", note: "批注", color: "yellow", tags: [],
      createdAt: "2024-12-05T02:00:00.000Z", updatedAt: "2026-09-20T02:00:00.000Z",
      anchor: { exact: "高亮", start: 0, end: 2, prefix: "", suffix: "" } }] };
}
const file = (value: unknown, name = "文章.json") => ({ name, text: JSON.stringify(value) });

it("imports standalone v2 exports by names and keeps content, IDs and timestamps", async () => {
  const lib = emptyLibrary(); migrateTaxonomy(lib);
  const existing = ensureTaxon(lib, "tags", "旧标签");
  const p = await page();
  const before = JSON.stringify(lib);
  const result = await prepareMetadataImport(lib, [file(p)]);
  const actual = result.library.entries[p.id].page;
  expect(result.items[0].status).toBe("pending");
  expect(actual).toEqual({ ...p, categoryId: expect.any(String), tagIds: [existing.id, expect.any(String)], markdownFile: undefined });
  expect(actual.categoryId).not.toBe(p.categoryId);
  expect(actual.tagIds).not.toContain("foreign-b");
  expect(result.library.autoGenerateMarkdown).toBe(false);
  expect(JSON.stringify(lib)).toBe(before);
});

it("supports legacy v1 exports and UTF-8 BOM without a supplied catalog", async () => {
  const p = { ...await page(), schemaVersion: 1, category: undefined, categoryId: undefined, tagIds: undefined };
  const result = await prepareMetadataImport(emptyLibrary(), [{ name: "older.JSON", text: "\uFEFF" + JSON.stringify(p) }]);
  expect(result.items[0].status).toBe("pending");
  expect(result.library.entries[p.id].page.category).toBe("未分类");
  expect(result.library.entries[p.id].page.schemaVersion).toBe(2);
  expect(result.library.entries[p.id].page.annotations).toEqual(p.annotations);
});

it("skips duplicate IDs and URLs in a batch and never overwrites current content", async () => {
  const p = await page();
  const initial = await prepareMetadataImport(emptyLibrary(), [file(p)]);
  const modified = { ...p, title: "覆盖标题", comment: "不能覆盖" };
  const differentId = { ...modified, id: "0123456789abcdef", folderName: folderName("other", "0123456789abcdef") };
  const result = await prepareMetadataImport(initial.library, [file(modified), file(differentId)]);
  expect(result.items.map(item => item.status)).toEqual(["skipped", "skipped"]);
  expect(result.library.entries[p.id].page.title).toBe(p.title);
  expect(Object.keys(result.library.entries)).toHaveLength(1);
  const repeated = await prepareMetadataImport(emptyLibrary(), [file(p), file(p, "重复.json")]);
  expect(repeated.items.map(item => item.status)).toEqual(["pending", "skipped"]);
});

it("reports bad files separately and does not leak their taxonomy additions", async () => {
  const p = await page();
  const invalid = { ...p, tagIds: ["one"], tags: ["污染标签", "second"], category: "污染分类" };
  const result = await prepareMetadataImport(emptyLibrary(), [file(invalid), { name: "broken.json", text: "{" }, file(p), file(p, "picture.png")]);
  expect(result.items.map(item => item.status)).toEqual(["error", "error", "pending", "error"]);
  expect(result.library.taxonomy!.categories.some(item => item.name === "污染分类")).toBe(false);
  expect(result.library.taxonomy!.tags.some(item => item.name === "污染标签")).toBe(false);
});

it("rejects metadata with unsafe paths or unknown catalog references without names", async () => {
  const p = await page();
  for (const invalid of [{ ...p, folderName: "../other" }, { ...p, tags: undefined }, { ...p, category: undefined }]) {
    const result = await prepareMetadataImport(emptyLibrary(), [file(invalid)]);
    expect(result.items[0].status).toBe("error");
    expect(Object.keys(result.library.entries)).toHaveLength(0);
  }
});

it("does not import into a library with unresolved catalog or file-read errors", async () => {
  const lib = emptyLibrary(); lib.taxonomyIssue = "conflict";
  await expect(prepareMetadataImport(lib, [file(await page())])).rejects.toThrow("冲突");
  delete lib.taxonomyIssue; lib.errors = ["broken file"];
  await expect(prepareMetadataImport(lib, [file(await page())])).rejects.toThrow("冲突");
});

it("validates batch and file limits before a request can change anything", () => {
  expect(() => validateImportBatch([])).toThrow();
  expect(() => validateImportBatch(Array(501).fill(file({})))).toThrow();
  expect(() => validateImportBatch([{ name: "x.json", text: "x".repeat(16_000_001) }])).toThrow();
  expect(() => validateImportBatch([{ name: "x.json", text: "汉".repeat(11_000_000) }])).toThrow("32 MB");
});
