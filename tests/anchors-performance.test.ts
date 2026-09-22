// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { capture, captureSelection, indexText, Painter, resolveAnchor } from "../src/anchors";
import type { Mark } from "../src/model";

const select = (selector: string) => {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector(selector)!);
  return range;
};
const mark = (selector: string, id = selector): Mark => {
  const captured = captureSelection(select(selector))!;
  return { id, ...captured, note: "", tags: [], color: "yellow",
    createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z" };
};
beforeEach(() => {
  document.body.innerHTML = '<p id="one">First <b>important</b> paragraph.</p><p id="two">Another paragraph.</p>';
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal("Highlight", class extends Set<Range> {
    constructor(...ranges: Range[]) { super(ranges); }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])("preserves linear capture semantics for all DOM boundaries (sourceOnly=%s)", sourceOnly => {
  document.body.innerHTML = '<p>A  <b>BC</b><span hidden>hidden</span>D<font class="immersive-translate-target-wrapper">译文</font></p><p> E<br>F </p><input value="excluded">';
  const index = indexText(document.body, sourceOnly);
  const endpoints: { node: Node; offset: number }[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null = document.body;
  do {
    const length = node.nodeType === Node.TEXT_NODE ? node.textContent!.length : node.childNodes.length;
    for (let offset = 0; offset <= length; offset++) endpoints.push({ node, offset });
  } while ((node = walker.nextNode()));
  for (const from of endpoints) for (const to of endpoints) {
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    // Reference the original exhaustive definition, including exclusive ends
    // and duplicate synthetic block-space points. No binary-search oracle.
    const inside = index.points.flatMap((p, i) => range.comparePoint(p.node, p.offset) === 0 &&
      !(p.node === range.endContainer && p.offset >= range.endOffset) ? [i] : []);
    let start = inside[0] ?? 0, end = inside.length ? inside.at(-1)! + 1 : 0;
    while (start < end && index.text[start] === " ") start++;
    while (end > start && index.text[end - 1] === " ") end--;
    const result = capture(range, index);
    if (start >= end) expect(result).toBeNull();
    else expect({ start: result?.start, end: result?.end, exact: result?.exact })
      .toEqual({ start, end, exact: index.text.slice(start, end) });
  }
});

it("bounds DOM comparisons and endpoint writes on a long selected paragraph", () => {
  document.querySelector("#one")!.textContent = "A long article with spaces. ".repeat(4000);
  const range = select("#one"), index = indexText(document.body, true);
  const compare = vi.spyOn(Range.prototype, "comparePoint");
  const anchor = capture(range, index)!;
  expect(compare.mock.calls.length).toBeLessThan(40);
  compare.mockClear();
  const endpoints = vi.spyOn(Range.prototype, "setEnd");
  const restored = resolveAnchor({ ...anchor, basis: "source" }, index)!;
  expect(restored.exact.map(r => r.toString()).join("")).toBe(anchor.exact);
  expect(compare.mock.calls.length).toBeLessThan(40);
  expect(endpoints.mock.calls.length).toBeLessThan(5);
});

it("reuses unchanged ranges through note, color, excerpt, add and delete updates", () => {
  const a = mark("#one"), b = mark("#two"), painter = new Painter();
  painter.paint([a], true);
  const original = painter.ranges.get(a.id);
  const scan = vi.spyOn(document, "createTreeWalker");
  painter.paint([{ ...a, note: "changed", color: "blue", text: "Edited excerpt" }], true);
  expect(scan).not.toHaveBeenCalled();
  expect(painter.ranges.get(a.id)).toBe(original);
  expect([...CSS.highlights.get("wc-blue")!]).toContain(original);
  painter.paint([a, b], true);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(painter.ranges.get(a.id)).toBe(original);
  scan.mockClear();
  painter.paint([a], true);
  expect(scan).not.toHaveBeenCalled();
  expect(painter.ranges.has(b.id)).toBe(false);
  painter.paint([a, b], true);
  expect(scan).toHaveBeenCalledTimes(1);
  painter.setVisible(false);
  expect(CSS.highlights.size).toBe(0);
  painter.setVisible(true);
  painter.paint([a, b], true);
  expect(painter.ranges.get(a.id)).toBe(original);
  expect([...CSS.highlights.get("wc-yellow")!]).toContain(original);
});

it("invalidates reused locations on DOM changes and never steals an ambiguous quote", () => {
  const a = mark("#one"), painter = new Painter();
  if (a.anchor.kind !== "element") { a.anchor.prefix = ""; a.anchor.suffix = ""; }
  painter.paint([a], true);
  const original = painter.ranges.get(a.id);
  document.querySelector("#one")!.after(document.querySelector("#one")!.cloneNode(true));
  painter.invalidate();
  painter.paint([a], true);
  expect(painter.ranges.has(a.id)).toBe(false);
  document.querySelectorAll("#one")[1].remove();
  painter.invalidate();
  painter.paint([a], true);
  expect(painter.ranges.get(a.id)?.toString()).toBe("First ");
  expect(painter.ranges.get(a.id)).not.toBe(original);
  const rebound = { ...a, anchor: mark("#two").anchor };
  painter.paint([rebound], true);
  expect(painter.ranges.get(a.id)?.toString()).toBe("Another paragraph.");
});

it("invalidates translated precision when wrappers hide, change and return", () => {
  document.body.innerHTML = '<p data-imt-p="1">Original source.<font class="immersive-translate-target-wrapper">中文译文</font></p>';
  const a = mark("font"), painter = new Painter();
  painter.paint([a], true);
  const wrapper = document.querySelector("font")!;
  wrapper.style.display = "none";
  painter.invalidate();
  painter.paint([a], true);
  expect(painter.approximate.has(a.id)).toBe(true);
  expect(painter.ranges.get(a.id)?.toString()).toBe("Original source.");
  wrapper.style.display = "";
  wrapper.textContent = "更换后的译文";
  painter.invalidate();
  painter.paint([a], true);
  expect(painter.approximate.has(a.id)).toBe(true);
  expect(painter.ranges.get(a.id)?.toString()).toBe("更换后的译文");
  wrapper.textContent = "中文译文";
  painter.invalidate();
  painter.paint([a], true);
  expect(painter.approximate.has(a.id)).toBe(false);
  expect(painter.ranges.get(a.id)?.toString()).toBe("中文译文");
});
