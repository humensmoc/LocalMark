// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { captureElement, elementChain, locateElement } from "../src/element-anchors";
import { AnchorSchema, emptyLibrary, folderName, markdown, pageId, parsePage, type Page } from "../src/model";
import { prepareMetadataImport } from "../src/metadata-import";
import { Painter, capture } from "../src/anchors";
Object.defineProperty(globalThis, "crypto", { value: webcrypto });
beforeEach(() => {
  vi.stubGlobal("CSS", {});
  document.body.innerHTML = '<main><article data-id="one"><h2>第一张卡片</h2><p>保存重要内容</p><a href="https://example.com/one">详情</a></article><article data-id="two"><h2>第二张卡片</h2></article></main>';
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 10, top: 10, right: 310, bottom: 210, width: 300, height: 200, x: 10, y: 10, toJSON: () => ({}) });
});
const target = () => document.querySelector("article")!;
describe("element anchors", () => {
  it("restores through a fresh DOM, insertions and moving the target", () => {
    const a = captureElement(target());
    document.body.innerHTML = document.body.innerHTML;
    const original = target();
    original.before(document.createElement("article"));
    document.body.append(original);
    expect(locateElement(a)).toBe(original);
  });
  it("never moves a note onto a recycled node with different content", () => {
    const a = captureElement(target());
    target().querySelector("h2")!.textContent = "全新的商品";
    expect(locateElement(a)).toBeNull();
  });
  it("does not use the old ordinal path to choose duplicate content", () => {
    target().removeAttribute("data-id");
    const a = captureElement(target());
    target().after(target().cloneNode(true));
    expect(locateElement(a)).toBeNull();
  });
  it("uses parent identity to disambiguate repeated child labels", () => {
    document.body.innerHTML = '<section data-id="a"><button>阅读</button></section><section data-id="b"><button>阅读</button></section>';
    const button = document.querySelector("button")!;
    const a = captureElement(button);
    document.querySelector("section")!.after(document.createElement("section"));
    expect(locateElement(a)).toBe(button);
  });
  it("retains image anchors without requiring a text range", () => {
    document.body.innerHTML = '<img src="https://example.com/image.png" alt="设计草图">';
    const img = document.querySelector("img")!;
    const a = captureElement(img);
    expect(AnchorSchema.parse(a).kind).toBe("element");
    expect(locateElement(a)).toBe(img);
    img.src = "https://example.com/new.png";
    expect(locateElement(a)).toBeNull();
  });
  it("hides missing or collapsed targets and recovers when they return", () => {
    const el = target(), a = captureElement(el);
    el.style.display = "none";
    expect(locateElement(a)).toBeNull();
    el.style.display = "";
    expect(locateElement(a)).toBe(el);
    el.remove();
    expect(locateElement(a)).toBeNull();
    document.querySelector("main")!.append(el);
    expect(locateElement(a)).toBe(el);
  });
  it("excludes plugin UI, editable fields and translation copies", () => {
    expect(elementChain(document.querySelector("h2"))).toEqual([document.querySelector("h2"), target(), document.querySelector("main")]);
    const a = captureElement(target());
    target().insertAdjacentHTML("beforeend", '<font class="immersive-translate-target-wrapper">额外译文</font>');
    expect(locateElement(a)).toBe(target());
    document.body.insertAdjacentHTML("beforeend", '<div id="local-web-clipper-root">插件</div><input>');
    expect(elementChain(document.querySelector("input"))).toEqual([]);
    expect(() => captureElement(document.getElementById("local-web-clipper-root")!)).toThrow();
  });
  it("rejects an empty anonymous box instead of claiming it can be restored", () => {
    document.body.innerHTML = '<div></div>';
    expect(() => captureElement(document.querySelector("div")!)).toThrow("缺少可恢复");
  });
});

async function elementPage(): Promise<Page> {
  const url = "https://example.com/elements", id = await pageId(url), now = "2026-09-21T07:00:00.000Z";
  return { schemaVersion: 3, id, url, originalUrl: url, title: "元素测试", favicon: "", folderName: folderName("元素测试", id),
    createdAt: now, updatedAt: now, tags: [], category: "未分类", categoryId: "category:uncategorized", tagIds: [],
    annotations: [{ id: crypto.randomUUID(), anchor: captureElement(target()), text: "可编辑的卡片说明", note: "卡片批注", tags: [], color: "blue", createdAt: now, updatedAt: now }] };
}
describe("element persistence and coexistence", () => {
  it("round-trips v3 and imports without downgrading or discarding anchors", async () => {
    const page = await elementPage(), raw = JSON.stringify(page);
    expect((await parsePage(raw)).annotations).toEqual(page.annotations);
    const result = await prepareMetadataImport(emptyLibrary(), [{ name: "elements.json", text: raw }]);
    expect(result.items[0].status).toBe("pending");
    expect(result.library.entries[page.id].page.schemaVersion).toBe(3);
    expect(result.library.entries[page.id].page.annotations).toEqual(page.annotations);
    expect(markdown(page)).toContain("元素标注（article）");
    expect(markdown(page)).toContain("卡片批注");
    await expect(parsePage(JSON.stringify({ ...page, schemaVersion: 2 }))).rejects.toThrow();
  });
  it("keeps text highlighting, element targets and their removal independent", async () => {
    const page = await elementPage(), range = document.createRange();
    range.selectNodeContents(document.querySelector("h2")!);
    const text = { ...page.annotations[0], id: crypto.randomUUID(), anchor: capture(range)! };
    const painter = new Painter();
    painter.paint([...page.annotations, text]);
    expect(painter.elements.size).toBe(1);
    expect(painter.ranges.size).toBe(1);
    expect(painter.orderedIds()).toHaveLength(2);
    painter.paint([text]);
    expect(painter.elements.size).toBe(0);
    expect(painter.ranges.size).toBe(1);
    painter.clear();
    expect(painter.orderedIds()).toEqual([]);
  });
});
