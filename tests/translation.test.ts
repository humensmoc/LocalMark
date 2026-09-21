// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  capture,
  captureSelection,
  indexText,
  resolveAnchor,
} from "../src/anchors";
import { AnchorSchema, MarkSchema } from "../src/model";

const wrapper = (text: string) =>
  `<font class="notranslate immersive-translate-target-wrapper" lang="zh-CN"><br><font class="immersive-translate-target-inner">${text}</font></font>`;
const fixture = () =>
  `<p data-imt-p="1" id="first">First <b id="term">source</b> paragraph.${wrapper('第一<b id="term">原文</b>段落。')}</p><p data-imt-p="1" id="second">Second source paragraph.${wrapper("第二原文段落。")}</p>`;
function range(selector: string) {
  const r = document.createRange();
  r.selectNodeContents(document.querySelector(selector)!);
  return r;
}
const texts = (ranges: Range[]) => ranges.map((r) => r.toString()).join("");
beforeEach(() => {
  document.body.innerHTML = fixture();
});

describe("Immersive Translate anchors", () => {
  it.each([
    '<h2 data-imt-p="1">Heading{translation}</h2>',
    '<ul><li data-imt-p="1">List item{translation}</li></ul>',
    '<table><tbody><tr><td data-imt-p="1">Table cell{translation}</td></tr></tbody></table>',
  ])("supports inline headings, list items and table cells: %s", markup => {
    document.body.innerHTML = markup.replace("{translation}", wrapper("对应译文"));
    const selected = captureSelection(range(".immersive-translate-target-inner"))!;
    expect(texts(resolveAnchor(selected.anchor)!.exact)).toBe("对应译文");
    document.querySelector(".immersive-translate-target-wrapper")!.remove();
    expect(texts(resolveAnchor(selected.anchor)!.context)).toBe(selected.anchor.exact);
  });
  it("retains the selected Chinese while anchoring its source, ignoring duplicate IDs", () => {
    const before = document.body.innerHTML;
    const result = captureSelection(
      range("#first .immersive-translate-target-inner b"),
    )!;
    expect(result.text).toBe("原文");
    expect(result.anchor.exact).toBe("First source paragraph.");
    expect(texts(resolveAnchor(result.anchor)!.exact)).toBe("原文");
    expect(document.body.innerHTML).toBe(before);
  });
  it("preserves translation metadata through persisted mark validation", () => {
    const result = captureSelection(
      range("#first .immersive-translate-target-inner"),
    )!;
    const mark = {
      id: "12b942f7-841f-4f5d-bdd5-8d404706125c",
      text: result.text,
      anchor: result.anchor,
      note: "note",
      color: "yellow",
      tags: [],
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    };
    expect(MarkSchema.parse(JSON.parse(JSON.stringify(mark)))).toEqual(mark);
    expect(
      AnchorSchema.safeParse({ ...result.anchor, basis: undefined }).success,
    ).toBe(false);
  });
  it.each(["hide", "remove"])(
    "falls back to a source paragraph after %s and restores precision on return",
    (mode) => {
      const result = captureSelection(
        range("#first .immersive-translate-target-inner b"),
      )!;
      const w = document.querySelector(
        "#first .immersive-translate-target-wrapper",
      ) as HTMLElement;
      if (mode === "hide") w.style.display = "none";
      else w.remove();
      expect(resolveAnchor(result.anchor)!.exact).toHaveLength(0);
      expect(texts(resolveAnchor(result.anchor)!.context)).toBe(
        "First source paragraph.",
      );
      if (mode === "hide") w.style.display = "";
      else document.querySelector("#first")!.append(w);
      expect(texts(resolveAnchor(result.anchor)!.exact)).toBe("原文");
    },
  );
  it("marks the current translation paragraph when the saved wording disappears", () => {
    const result = captureSelection(
      range("#first .immersive-translate-target-inner b"),
    )!;
    document.querySelector(
      "#first .immersive-translate-target-inner",
    )!.textContent = "这是一段重新翻译的文字。";
    const resolved = resolveAnchor(result.anchor)!;
    expect(resolved.exact).toHaveLength(0);
    expect(texts(resolved.context)).toBe("这是一段重新翻译的文字。");
    expect(result.text).toBe("原文");
  });
  it("relocates after preceding content is added without depending on saved offsets", () => {
    const result = captureSelection(
      range("#second .immersive-translate-target-inner"),
    )!;
    document.body.insertAdjacentHTML(
      "afterbegin",
      "<p>New unrelated content.</p>",
    );
    expect(texts(resolveAnchor(result.anchor)!.exact)).toBe("第二原文段落。");
  });
  it("keeps source context identical across translation changes", () => {
    const result = captureSelection(range("#first > b"))!;
    const before = indexText(document.body, true).text;
    document
      .querySelectorAll(".immersive-translate-target-wrapper")
      .forEach((w) => w.remove());
    expect(indexText(document.body, true).text).toBe(before);
    expect(texts(resolveAnchor(result.anchor)!.exact)).toBe("source");
  });
  it("does not include translations when drawing a source selection spanning paragraphs", () => {
    document
      .querySelectorAll(".immersive-translate-target-wrapper")
      .forEach((w) => w.remove());
    const r = document.createRange();
    r.setStart(document.querySelector("#first")!.firstChild!, 0);
    r.setEnd(document.querySelector("#second")!.firstChild!, 6);
    const result = captureSelection(r)!;
    document
      .querySelector("#first")!
      .insertAdjacentHTML("beforeend", wrapper("新增译文"));
    document
      .querySelector("#second")!
      .insertAdjacentHTML("beforeend", wrapper("第二译文"));
    const resolved = resolveAnchor(result.anchor)!;
    expect(texts(resolved.exact)).toBe("First source paragraph.Second");
    expect(
      resolved.exact.every(
        (r) =>
          !r.startContainer.parentElement!.closest(
            ".immersive-translate-target-wrapper",
          ),
      ),
    ).toBe(true);
  });
  it("captures mixed English and Chinese as a single mark with separate ranges", () => {
    const result = captureSelection(range("#first"))!;
    const resolved = resolveAnchor(result.anchor)!;
    expect(result.anchor.segments).toHaveLength(2);
    expect(texts(resolved.exact)).toContain("First source paragraph.");
    expect(texts(resolved.exact)).toContain("第一原文段落。");
  });
  it("does not silently restore only half a selection if one source paragraph disappears", () => {
    const r = document.createRange();
    r.setStart(
      document.querySelector("#first .immersive-translate-target-inner")!
        .firstChild!,
      0,
    );
    r.setEndAfter(
      document.querySelector("#second .immersive-translate-target-inner")!,
    );
    const result = captureSelection(r)!;
    document.querySelector("#first")!.remove();
    expect(resolveAnchor(result.anchor)).toBeNull();
  });
  it("refuses ambiguous source matches", () => {
    const result = captureSelection(
      range("#first .immersive-translate-target-inner"),
    )!;
    document.body.innerHTML = `<p>First source paragraph.</p><p>First source paragraph.</p>`;
    expect(resolveAnchor(result.anchor)).toBeNull();
  });
  it("keeps legacy anchors readable and makes new ordinary anchors source based", () => {
    const old = capture(range("#first .immersive-translate-target-inner b"))!;
    expect(texts(resolveAnchor(old)!.exact)).toBe("原文");
    expect(captureSelection(range("#first > b"))!.anchor.basis).toBe("source");
  });
  it("warns instead of guessing when an owner has multiple translation wrappers", () => {
    document
      .querySelector("#first")!
      .insertAdjacentHTML("beforeend", wrapper("另一译文"));
    const result = captureSelection(
      range("#first .immersive-translate-target-inner b"),
    )!;
    expect(result.warning).toContain("暂不支持");
    expect(result.anchor.basis).toBeUndefined();
  });
});
