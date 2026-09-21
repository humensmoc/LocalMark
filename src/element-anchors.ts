import { ElementAnchorSchema, type ElementAnchor } from "./element-model";

const HOST = "local-web-clipper-root";
const omitted = `script,style,noscript,template,input,textarea,select,[contenteditable]:not([contenteditable="false"]),#${HOST},.immersive-translate-target-wrapper`;
const identityNames = ["id", "data-id", "data-key", "data-item-id", "data-testid"] as const;
const normalize = (s: string, limit: number) => s.replace(/\s+/g, " ").trim().slice(0, limit);

function identity(el: Element): ElementAnchor["identity"] {
  return identityNames.flatMap(name => {
    const value = el.getAttribute(name);
    return value && value.length <= 500 ? [{ name, value }] : [];
  });
}
/** Read source content only; plugin UI and translated copies never become identity. */
function textOf(el: Element, limit = 2000) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: node => node instanceof Element
      ? node.matches(omitted) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
      : NodeFilter.FILTER_ACCEPT,
  });
  const parts: string[] = [];
  let node: Node | null, length = 0;
  while ((node = walker.nextNode()) && length < limit * 2) {
    const text = node.textContent ?? "";
    parts.push(text);
    length += text.length;
  }
  return normalize(parts.join(" "), limit);
}
function resourcesOf(el: Element) {
  const resources: string[] = [];
  const add = (node: Element) => {
    const attr = node.matches("a,area") ? "href" : "src";
    const raw = node.getAttribute(attr);
    if (!raw) return;
    try {
      const url = new URL(raw, document.baseURI);
      if (/^https?:$/.test(url.protocol) && url.href.length <= 4000)
        resources.push(url.href);
    } catch { /* A malformed resource is not an identity signal. */ }
  };
  add(el);
  for (const child of el.querySelectorAll("a[href],img[src],video[src],iframe[src]")) {
    if (!child.closest(omitted)) add(child);
    if (resources.length >= 4) break;
  }
  return [...new Set(resources)].slice(0, 4);
}
function labelOf(el: Element) {
  return normalize(el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "", 500);
}
function pathOf(el: Element) {
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
    let index = 1;
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling)
      if (sib.localName === node.localName) index++;
    parts.unshift(`${node.localName}:nth-of-type(${index})`);
  }
  return "body > " + parts.join(" > ");
}
export function selectableElement(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el === document.body || el === document.documentElement ||
      !el.isConnected || el.closest(omitted) || el.getRootNode() !== document) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  for (let p: Element | null = el; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.display === "none" || s.visibility === "hidden" || s.contentVisibility === "hidden" || s.opacity === "0") return false;
  }
  return true;
}
export function elementChain(el: Element | null) {
  const result: HTMLElement[] = [];
  for (let node = el; node && node !== document.body; node = node.parentElement)
    if (selectableElement(node)) result.push(node);
  return result;
}
export function elementName(el: Element) {
  return `${el.localName}${el.id ? "#" + el.id : ""}`.slice(0, 120);
}
export function captureElement(el: HTMLElement): ElementAnchor {
  if (!selectableElement(el)) throw Error("该元素已隐藏或移除，请重新选择。");
  const text = textOf(el), label = labelOf(el), resources = resourcesOf(el), ids = identity(el);
  if (!text && !label && !resources.length && !ids.length)
    throw Error("这个空元素缺少可恢复的内容，请扩大范围选择它的父元素。");
  const context: ElementAnchor["context"] = [];
  for (let p = el.parentElement; p && p !== document.body && context.length < 3; p = p.parentElement)
    context.push({ tag: p.localName, identity: identity(p), text: textOf(p, 500) });
  const anchor = ElementAnchorSchema.parse({ kind: "element", tag: el.localName, path: pathOf(el),
    identity: ids, text, label, resources, context,
    exact: `${el.localName} · ${text || label || resources[0] || elementName(el)}`.slice(0, 4000) });
  if (locateElement(anchor) !== el)
    throw Error("页面有无法区分的相同元素，请扩大范围选择包含标题的父元素。");
  return anchor;
}

function hasIdentity(el: Element, ids: ElementAnchor["identity"]) {
  return ids.every(({ name, value }) => el.getAttribute(name) === value);
}
/** A path is only a candidate hint, never proof. Recycled nodes must match content again. */
export function locateElement(a: ElementAnchor): HTMLElement | null {
  let candidates = [...document.getElementsByTagName(a.tag)].filter((el): el is HTMLElement => {
    if (!(el instanceof HTMLElement) || el.closest(omitted)) return false;
    if (a.identity.length && !hasIdentity(el, a.identity)) return false;
    return textOf(el) === a.text && labelOf(el) === a.label &&
      JSON.stringify(resourcesOf(el)) === JSON.stringify(a.resources);
  });
  if (candidates.length > 1 && a.context.length) {
    candidates = candidates.filter(el => a.context.every(saved => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (p.localName !== saved.tag) continue;
        if (saved.identity.length ? hasIdentity(p, saved.identity) : !!saved.text && textOf(p, 500) === saved.text)
          return true;
      }
      return false;
    }));
  }
  return candidates.length === 1 && selectableElement(candidates[0]) ? candidates[0] : null;
}

export type ElementBox = { left: number; top: number; width: number; height: number };
/** Clip overlays to both the viewport and nested scrolling/overflow containers. */
export function elementBox(el: HTMLElement): ElementBox | null {
  if (!selectableElement(el)) return null;
  const r = el.getBoundingClientRect(), viewport = window.visualViewport;
  let left = Math.max(r.left, viewport?.offsetLeft ?? 0), top = Math.max(r.top, viewport?.offsetTop ?? 0);
  let right = Math.min(r.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth));
  let bottom = Math.min(r.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight));
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p), box = p.getBoundingClientRect();
    if (/hidden|clip|scroll|auto/.test(s.overflowX)) {
      left = Math.max(left, box.left + p.clientLeft);
      right = Math.min(right, box.left + p.clientLeft + p.clientWidth);
    }
    if (/hidden|clip|scroll|auto/.test(s.overflowY)) {
      top = Math.max(top, box.top + p.clientTop);
      bottom = Math.min(bottom, box.top + p.clientTop + p.clientHeight);
    }
  }
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}
