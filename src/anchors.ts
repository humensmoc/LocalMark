import type { Anchor, Mark, Color } from "./model";
import { colorInfo, ColorSchema } from "./model";
import { locateElement } from "./element-anchors";
import { existingQuoteLayout, readableQuote } from "./quote-layout";
export const HOST = "local-web-clipper-root";
export const TRANSLATION = ".immersive-translate-target-wrapper";
type Point = { node: Text; offset: number };
export type TextIndex = { text: string; points: Point[] };
const excluded =
  'script,style,noscript,template,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],#' +
  HOST;
export function indexText(
  root: HTMLElement = document.body,
  sourceOnly = false,
): TextIndex {
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
    if (
      !parent ||
      parent.closest(excluded) ||
      (sourceOnly && parent.closest(TRANSLATION))
    )
      continue;
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
// Index points are in DOM order, including repeated points at normalized block
// boundaries. Find both bounds without comparing every character in the page.
function rangeBounds(range: Range, index: TextIndex) {
  const bound = (end: boolean) => {
    let low = 0, high = index.points.length;
    while (low < high) {
      const middle = (low + high) >>> 1, p = index.points[middle];
      const relation = range.comparePoint(p.node, p.offset);
      const before = end
        ? relation <= 0 && !(p.node === range.endContainer && p.offset >= range.endOffset)
        : relation < 0;
      if (before) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return { start: bound(false), end: bound(true) };
}
export function capture(range: Range, index = indexText()): Anchor | null {
  // Still compare DOM boundaries so element-based selections work too.
  let { start, end } = rangeBounds(range, index);
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
// One DOM Range spanning two source paragraphs also contains the intervening
// translation. Draw only indexed text nodes, never that enclosing range.
function splitRange(range: Range, index: TextIndex): Range[] {
  const ranges: Range[] = [];
  const { start, end } = rangeBounds(range, index);
  for (let i = start; i < end;) {
    const first = index.points[i];
    let last = first;
    while (++i < end && index.points[i].node === first.node) last = index.points[i];
    const current = document.createRange();
    current.setStart(first.node, first.offset);
    // Set an endpoint once per Text node, not once per selected character.
    current.setEnd(last.node, last.offset + 1);
    ranges.push(current);
  }
  return ranges;
}

function contents(element: Element) {
  const r = document.createRange();
  r.selectNodeContents(element);
  return r;
}

function translationOwner(wrapper: Element): HTMLElement | null {
  const owner = wrapper.parentElement;
  // Only adapt an explicit, unambiguous Immersive Translate unit. No ID or
  // previous-paragraph heuristic: translated inline elements can duplicate IDs.
  return owner?.matches('[data-imt-p="1"]') &&
    owner.querySelectorAll(TRANSLATION).length === 1
    ? owner
    : null;
}

export function captureSelection(
  range: Range,
): { anchor: Anchor; text: string; warning?: string } | null {
  const visible = indexText();
  const selected = capture(range, visible);
  if (!selected) return null;
  const text = readableQuote(splitRange(range, visible));
  const source = indexText(document.body, true);
  const original = capture(range, source);
  const segments: NonNullable<Anchor["segments"]> = original
    ? [{ source: original }]
    : [];
  let translated = false;
  for (const wrapper of document.querySelectorAll<HTMLElement>(TRANSLATION)) {
    if (!range.intersectsNode(wrapper)) continue;
    const quote = capture(range, indexText(wrapper));
    if (!quote) continue;
    const owner = translationOwner(wrapper);
    const sourceQuote = owner && capture(contents(owner), source);
    if (!sourceQuote || segments.length >= 500) {
      return {
        anchor: selected,
        text,
        warning: "此译文结构暂不支持关联原文，关闭翻译后可能需要重新绑定。",
      };
    }
    segments.push({ source: sourceQuote, translation: quote });
    translated = true;
  }
  if (!translated)
    return original
      ? { anchor: { ...original, basis: "source" }, text }
      : null;
  const start = Math.min(...segments.map((s) => s.source.start));
  const end = Math.max(...segments.map((s) => s.source.end));
  const combined = domRange(source, start, end);
  const quote = combined && capture(combined, source);
  return quote
    ? { anchor: { ...quote, basis: "source", segments }, text }
    : null;
}

export type ResolvedAnchor = { exact: Range[]; context: Range[] };
export function resolveAnchor(
  a: Anchor,
  source = indexText(document.body, true),
  legacy?: TextIndex,
): ResolvedAnchor | null {
  if (a.basis !== "source") {
    const index = legacy ?? indexText();
    const r = locate(a, index);
    return r ? { exact: splitRange(r, index), context: [] } : null;
  }
  const result: ResolvedAnchor = { exact: [], context: [] };
  for (const segment of a.segments ?? [{ source: a }]) {
    const r = locate(segment.source, source);
    if (!r) return null; // Partial restoration must not look like full recovery.
    if (!segment.translation) {
      result.exact.push(...splitRange(r, source));
      continue;
    }
    let owner = r.startContainer.parentElement;
    let wrapper: HTMLElement | undefined;
    const resolved = capture(r, source);
    while (owner && owner !== document.body) {
      const candidate = owner.querySelector<HTMLElement>(TRANSLATION);
      if (candidate && translationOwner(candidate) === owner) {
        const quote = capture(contents(owner), source);
        // Offsets may shift between visits; compare to the resolved range.
        if (
          quote &&
          resolved &&
          quote.start === resolved.start &&
          quote.end === resolved.end
        ) {
          wrapper = candidate;
          break;
        }
      }
      owner = owner.parentElement;
    }
    const translationIndex = wrapper && indexText(wrapper);
    const translated =
      translationIndex && locate(segment.translation, translationIndex);
    if (translated)
      result.exact.push(...splitRange(translated, translationIndex!));
    else if (translationIndex?.text.trim()) {
      result.context.push(...splitRange(contents(wrapper!), translationIndex));
    } else result.context.push(...splitRange(r, source));
  }
  return result;
}

type HighlightCtor = new (...ranges: Range[]) => unknown;
type Registry = {
  set(name: string, value: unknown): void;
  delete(name: string): void;
};
type CachedAnchor = {
  key: string;
  resolved?: ResolvedAnchor | null;
  element?: HTMLElement | null;
  text?: string;
  excerpt?: string;
};
export class Painter {
  private cache = new Map<string, CachedAnchor>();
  // A DOM/visibility change can make even a previously unique quote ambiguous.
  // The content observer invalidates synchronously, before its deferred repaint.
  invalidate() { this.cache.clear(); }
  private visible = true;
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) this.clearHighlights();
  }
  ranges = new Map<string, Range>();
  elements = new Map<string, HTMLElement>();
  target(id: string): Range | HTMLElement | undefined {
    return this.elements.get(id) ?? this.ranges.get(id);
  }
  orderedIds() {
    const node = (id: string): Node => this.elements.get(id) ?? this.ranges.get(id)!.startContainer;
    return [...this.ranges.keys(), ...this.elements.keys()].sort((a, b) => {
      const relation = node(a).compareDocumentPosition(node(b));
      return relation & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : relation & Node.DOCUMENT_POSITION_PRECEDING ? 1 : a.localeCompare(b);
    });
  }
  private allRanges = new Map<string, Range[]>();
  approximate = new Set<string>();
  excerpts = new Map<string, string>();
  private colors: Color[] = ["yellow", "green", "blue", "pink", "purple"];
  private colorSheet?: CSSStyleSheet;
  private colorRules = "";
  private colorName(color: Color) { return color.replace("#", "hex-"); }
  paint(marks: Mark[], reuse = false) {
    // Standalone callers retain fresh-DOM semantics. Reuse requires the caller
    // to observe DOM changes and invalidate, as the content script does.
    if (!reuse) this.invalidate();
    if (!marks.length) {
      this.clear();
      return this.ranges;
    }
    const ids = new Set(marks.map(m => m.id));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
    let source: TextIndex | undefined, legacy: TextIndex | undefined;
    this.ranges.clear();
    this.elements.clear();
    this.allRanges.clear();
    this.approximate.clear();
    this.excerpts.clear();
    const grouped = new Map<Color, Range[]>();
    const context = new Map<Color, Range[]>();
    for (const m of marks) {
      const key = JSON.stringify(m.anchor);
      let cached = this.cache.get(m.id);
      if (!cached || cached.key !== key) {
        cached = { key };
        if (m.anchor.kind === "element") cached.element = locateElement(m.anchor);
        else {
          source ??= indexText(document.body, true);
          if (m.anchor.basis !== "source") legacy ??= indexText();
          cached.resolved = resolveAnchor(m.anchor, source, legacy);
        }
        this.cache.set(m.id, cached);
      }
      if (m.anchor.kind === "element") {
        if (cached.element) this.elements.set(m.id, cached.element);
        continue;
      }
      const resolved = cached.resolved;
      if (resolved) {
        const ranges = [...resolved.exact, ...resolved.context];
        if (!ranges.length) continue;
        this.ranges.set(m.id, ranges[0]);
        this.allRanges.set(m.id, ranges);
        if (resolved.context.length) this.approximate.add(m.id);
        if (!resolved.context.length) {
          if (cached.text !== m.text) {
            cached.text = m.text;
            cached.excerpt = existingQuoteLayout(m.text, resolved.exact);
          }
          if (cached.excerpt !== undefined && cached.excerpt !== m.text)
            this.excerpts.set(m.id, cached.excerpt);
        }
        const exactRanges = grouped.get(m.color) ?? [];
        exactRanges.push(...resolved.exact);
        grouped.set(m.color, exactRanges);
        const contextRanges = context.get(m.color) ?? [];
        contextRanges.push(...resolved.context);
        context.set(m.color, contextRanges);
      }
    }
    const api = (CSS as unknown as { highlights?: Registry }).highlights,
      H = (window as unknown as { Highlight?: HighlightCtor }).Highlight;
    if (api && H && this.visible) {
      const colors = [...new Set(marks.map(mark => mark.color))].filter(color => ColorSchema.safeParse(color).success);
      for (const color of this.colors) if (!colors.includes(color)) {
        api.delete("wc-" + this.colorName(color));
        api.delete("wc-context-" + this.colorName(color));
      }
      this.colors = colors;
      const rules = colors.filter(color => color.startsWith("#")).map(color => {
        const hex = colorInfo(color).hex;
        const rgb = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
        const ink = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150 ? "#17231f" : "#ffffff";
        return `::highlight(wc-${this.colorName(color)}) { background: ${hex}; color: ${ink}; } ::highlight(wc-context-${this.colorName(color)}) { text-decoration: underline dashed ${hex}; }`;
      }).join("\n");
      if (rules !== this.colorRules) {
        this.colorSheet ??= new CSSStyleSheet();
        this.colorSheet.replaceSync(rules);
        this.colorRules = rules;
      }
      if (this.colorSheet && !document.adoptedStyleSheets.includes(this.colorSheet))
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.colorSheet];
      for (const c of this.colors) {
        api.set("wc-" + this.colorName(c), new H(...(grouped.get(c) ?? [])));
        api.set("wc-context-" + this.colorName(c), new H(...(context.get(c) ?? [])));
      }
    }
    return this.ranges;
  }
  hit(x: number, y: number) {
    const hits: string[] = [];
    if (!this.visible) return hits;
    for (const [id, ranges] of this.allRanges)
      for (const rect of ranges.flatMap((r) => [...r.getClientRects()]))
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
    const element = this.elements.get(id);
    if (element?.isConnected) {
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      return true;
    }
    const r = this.ranges.get(id);
    if (!r) return false;
    const el = r.startContainer.parentElement;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    const api = (CSS as unknown as { highlights?: Registry }).highlights,
      H = (window as unknown as { Highlight?: HighlightCtor }).Highlight;
    if (api && H && this.visible) {
      if (!this.approximate.has(id))
        api.set("wc-focus", new H(...(this.allRanges.get(id) ?? [r])));
      setTimeout(() => api.delete("wc-focus"), 1400);
    }
    return true;
  }
  clear() {
    this.invalidate();
    this.ranges.clear();
    this.elements.clear();
    this.allRanges.clear();
    this.approximate.clear();
    this.excerpts.clear();
    this.clearHighlights();
  }
  private clearHighlights() {
    const api = (CSS as unknown as { highlights?: Registry }).highlights;
    for (const c of this.colors) {
      api?.delete("wc-" + this.colorName(c));
      api?.delete("wc-context-" + this.colorName(c));
    }
    api?.delete("wc-focus");
    if (this.colorSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== this.colorSheet);
  }
}
