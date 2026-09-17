import type { Anchor, Mark, Color } from "./model";
export const HOST = "local-web-clipper-root";
type Point = { node: Text; offset: number };
export type TextIndex = { text: string; points: Point[] };
const excluded =
  'script,style,noscript,template,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],#' +
  HOST;
export function indexText(root: HTMLElement = document.body): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const points: Point[] = [],
    parts: string[] = [];
  let previousSpace = false,
    previousBlock: Element | null = null;
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  const styleOf = (e: Element) => {
    let s = styles.get(e);
    if (!s) {
      s = getComputedStyle(e);
      styles.set(e, s);
    }
    return s;
  };
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest(excluded)) continue;
    let ancestor: Element | null = parent,
      block: Element | null = null,
      hidden = false;
    while (ancestor) {
      const s = styleOf(ancestor);
      if (s.display === "none" || s.visibility === "hidden") {
        hidden = true;
        break;
      }
      if (
        !block &&
        /^(block|list-item|table-cell|flex|grid|flow-root)$/.test(s.display)
      )
        block = ancestor;
      if (ancestor === root) break;
      ancestor = ancestor.parentElement;
    }
    if (hidden) continue;
    const t = node as Text;
    // Rendered block boundaries are whitespace even when the HTML has no newline.
    if (
      t.length &&
      previousBlock &&
      block !== previousBlock &&
      parts.length &&
      !previousSpace
    ) {
      parts.push(" ");
      points.push({ node: t, offset: 0 });
      previousSpace = true;
    }
    if (t.length) previousBlock = block;
    for (let offset = 0; offset < t.length; offset++) {
      const c = t.data[offset],
        space = /\s/.test(c);
      if (space && previousSpace) continue;
      parts.push(space ? " " : c);
      points.push({ node: t, offset });
      previousSpace = space;
    }
  }
  return { text: parts.join(""), points };
}
function domRange(index: TextIndex, start: number, end: number) {
  if (!index.points[start] || !index.points[end - 1]) return null;
  const r = document.createRange();
  try {
    r.setStart(index.points[start].node, index.points[start].offset);
    r.setEnd(index.points[end - 1].node, index.points[end - 1].offset + 1);
    return r;
  } catch {
    return null;
  }
}
function path(node: Node) {
  const parts: string[] = [];
  let el = node.parentElement;
  while (el && el !== document.body) {
    const tag = el.tagName.toLowerCase();
    let n = 1;
    for (
      let sib = el.previousElementSibling;
      sib;
      sib = sib.previousElementSibling
    )
      if (sib.tagName === el.tagName) n++;
    parts.unshift(`${tag}:nth-of-type(${n})`);
    el = el.parentElement;
  }
  return "body > " + parts.join(" > ");
}
export function capture(range: Range, index = indexText()): Anchor | null {
  // Comparing DOM boundary points handles selections starting on element nodes as well as Text.
  let start = -1,
    end = -1;
  for (let i = 0; i < index.points.length; i++) {
    const p = index.points[i];
    if (
      range.comparePoint(p.node, p.offset) === 0 &&
      !(p.node === range.endContainer && p.offset >= range.endOffset)
    ) {
      if (start < 0) start = i;
      end = i + 1;
    }
  }
  if (start < 0) return null;
  while (start < end && index.text[start] === " ") start++;
  while (end > start && index.text[end - 1] === " ") end--;
  if (start >= end) return null;
  const exact = index.text.slice(start, end);
  let occurrences = 0,
    at = index.text.indexOf(exact);
  while (at >= 0) {
    occurrences++;
    at = index.text.indexOf(exact, at + 1);
  }
  return {
    exact,
    prefix: index.text.slice(Math.max(0, start - 48), start),
    suffix: index.text.slice(end, end + 48),
    start,
    end,
    path: path(index.points[start].node),
    occurrences,
  };
}
export function locate(a: Anchor, index: TextIndex): Range | null {
  const positions: number[] = [];
  let at = index.text.indexOf(a.exact);
  while (at >= 0) {
    positions.push(at);
    at = index.text.indexOf(a.exact, at + 1);
  }
  if (!positions.length) return null;
  if (positions.length === 1 && (a.occurrences ?? 1) === 1)
    return domRange(index, positions[0], positions[0] + a.exact.length);
  // Do not guess on repeated quotes. Exact surrounding text must disambiguate.
  const candidates = positions.filter(
    (i) =>
      (!a.prefix ||
        index.text.slice(Math.max(0, i - a.prefix.length), i) === a.prefix) &&
      (!a.suffix ||
        index.text.slice(
          i + a.exact.length,
          i + a.exact.length + a.suffix.length,
        ) === a.suffix),
  );
  if (candidates.length === 1)
    return domRange(index, candidates[0], candidates[0] + a.exact.length);
  // No offset-only fallback: inserted duplicate text could otherwise steal an annotation.
  return null;
}
type HighlightCtor = new (...ranges: Range[]) => unknown;
type Registry = {
  set(name: string, value: unknown): void;
  delete(name: string): void;
};
export class Painter {
  ranges = new Map<string, Range>();
  private colors: Color[] = ["yellow", "green", "blue", "pink", "purple"];
  paint(marks: Mark[]) {
    if (!marks.length) {
      this.clear();
      return this.ranges;
    }
    const index = indexText();
    this.ranges.clear();
    const grouped = new Map<Color, Range[]>();
    for (const m of marks) {
      const r = locate(m.anchor, index);
      if (r) {
        this.ranges.set(m.id, r);
        grouped.set(m.color, [...(grouped.get(m.color) ?? []), r]);
      }
    }
    const api = (CSS as unknown as { highlights?: Registry }).highlights,
      H = (window as unknown as { Highlight?: HighlightCtor }).Highlight;
    if (api && H)
      for (const c of this.colors)
        api.set("wc-" + c, new H(...(grouped.get(c) ?? [])));
    return this.ranges;
  }
  hit(x: number, y: number) {
    const hits: string[] = [];
    for (const [id, r] of this.ranges)
      for (const rect of r.getClientRects())
        if (
          x >= rect.left &&
          x <= rect.right &&
          y >= rect.top &&
          y <= rect.bottom
        ) {
          hits.push(id);
          break;
        }
    return hits;
  }
  jump(id: string) {
    const r = this.ranges.get(id);
    if (!r) return false;
    const el = r.startContainer.parentElement;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    const api = (CSS as unknown as { highlights?: Registry }).highlights,
      H = (window as unknown as { Highlight?: HighlightCtor }).Highlight;
    if (api && H) {
      api.set("wc-focus", new H(r));
      setTimeout(() => api.delete("wc-focus"), 1400);
    }
    return true;
  }
  clear() {
    this.ranges.clear();
    const api = (CSS as unknown as { highlights?: Registry }).highlights;
    for (const c of this.colors) api?.delete("wc-" + c);
    api?.delete("wc-focus");
  }
}
