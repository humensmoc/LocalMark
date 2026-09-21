import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { COLORS, type Color } from "./model";
import { Icon } from "./Icon";
import { elementBox, elementChain, elementName, type ElementBox } from "./element-anchors";

type BoxItem = { id: string; element: HTMLElement; color: Color; label?: string };
function useBoxes(items: BoxItem[]) {
  const [boxes, setBoxes] = useState<Record<string, ElementBox>>({});
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next: Record<string, ElementBox> = {};
      for (const item of items) {
        const box = elementBox(item.element);
        if (box) next[item.id] = box;
      }
      setBoxes(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    for (const { element } of items) observer.observe(element);
    // Also follows positional layout shifts and transforms that ResizeObserver cannot see.
    const timer = items.length ? setInterval(schedule, 100) : undefined;
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      clearInterval(timer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [items]);
  return boxes;
}
export function ElementOverlays({ items, preview = false, focused, hovered = [], buttonRef, keepHover, leaveHover, edit }: {
  items: BoxItem[]; preview?: boolean; focused?: string;
  hovered?: string[]; buttonRef?: RefObject<HTMLButtonElement | null>;
  keepHover?: () => void; leaveHover?: () => void;
  edit?: (id: string, x: number, y: number) => void;
}) {
  const boxes = useBoxes(items);
  const primary = hovered.find(id => items.some(item => item.id === id));
  const occupied = new Map<string, number>();
  return <div className="element-overlays" aria-label={preview ? "元素选择预览" : "元素标注"}>
    {items.map(item => {
      const box = boxes[item.id];
      if (!box) return null;
      const key = `${Math.round(box.left + box.width)}:${Math.round(box.top)}`;
      const slot = occupied.get(key) ?? 0;
      occupied.set(key, slot + 1);
      return <div key={item.id} data-element-mark={item.id}
        className={`element-outline${preview ? " is-preview" : ""}${focused === item.id ? " is-focused" : ""}`}
        style={{ ...box, "--mark": COLORS[item.color].hex } as CSSProperties}>
        {edit && hovered.includes(item.id) && <button className="element-note-button" style={{ right: slot * 29 }}
          ref={item.id === primary ? buttonRef : undefined}
          aria-label={`编辑元素批注：${item.label ?? ""}`} title="编辑批注"
          onMouseEnter={keepHover} onMouseLeave={leaveHover} onFocus={keepHover} onBlur={leaveHover}
          onClick={e => { e.stopPropagation(); edit(item.id, box.left + box.width, box.top + 30); }}>
          <Icon name="pen" size={16} />
        </button>}
      </div>;
    })}
  </div>;
}

export function ElementPickButton({ picking, toggle }: { picking: boolean; toggle: () => void }) {
  const label = picking ? "退出元素选择" : "选择元素";
  return <button type="button" className="element-pick-toggle" aria-label={label}
    title={picking ? "退出元素选择（Esc）" : label} aria-pressed={picking} onClick={toggle}>
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 4H4v5M15 4h5v5M4 15v5h5" />
      <path d="m10 10 11 4-5 2-2 5Z" />
    </svg>
  </button>;
}

export function AnnotationVisibilityButton({ visible, toggle }: { visible: boolean; toggle: () => void }) {
  const label = visible ? "隐藏网页高亮和标注" : "显示网页高亮和标注";
  return <button type="button" className="annotation-visibility-toggle" aria-label={label}
    title={label} aria-pressed={visible} onClick={toggle}>
    <Icon name={visible ? "eye" : "eye-off"} size={22} />
  </button>;
}

export function SidePanelButton({ open, busy, toggle }: { open: boolean; busy: boolean; toggle: () => void }) {
  const label = open ? "关闭侧边栏" : "展开侧边栏";
  return <button type="button" className="sidepanel-toggle" aria-label={label}
    title={label} aria-expanded={open} disabled={busy} onClick={toggle}>
    <Icon name="sidebar" size={22} />
  </button>;
}

export function ElementPicker({ color, select, cancel }: {
  color: Color; select: (element: HTMLElement) => void; cancel: () => void;
}) {
  const [chain, setChain] = useState<HTMLElement[]>([]), [depth, setDepth] = useState(0);
  const active = chain[depth];
  const snapshot = useRef({ chain, depth, select, cancel });
  snapshot.current = { chain, depth, select, cancel };
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    toolbar.current?.focus({ preventScroll: true });
    let frame = 0, point: { x: number; y: number } | undefined;
    const own = (e: Event) => e.composedPath().some(n => n instanceof Element && n.id === "local-web-clipper-root");
    const targetAt = (x: number, y: number) => document.elementsFromPoint(x, y)
      .find(el => !el.closest("#local-web-clipper-root")) ?? null;
    const hover = (e: MouseEvent) => {
      if (own(e)) return;
      point = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (!point) return;
        const next = elementChain(targetAt(point.x, point.y));
        if (next[0] !== snapshot.current.chain[0]) { setChain(next); setDepth(0); }
      });
    };
    const block = (e: Event) => {
      if (own(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === "click" && e instanceof MouseEvent && e.button === 0) {
        const s = snapshot.current;
        const next = elementChain(targetAt(e.clientX, e.clientY));
        // Preserve an ancestor selected with the keyboard while hovering.
        const selected = next[0] === s.chain[0] ? s.chain[s.depth] : next[0];
        if (selected) s.select(selected);
      }
    };
    const key = (e: KeyboardEvent) => {
      const s = snapshot.current;
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); s.cancel(); }
      else if (!e.isComposing && ["ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        setDepth(d => Math.max(0, Math.min(s.chain.length - 1, d + (e.key === "ArrowUp" ? 1 : -1))));
      } else if (e.key === "Enter" && !own(e) && s.chain[s.depth]) {
        e.preventDefault(); e.stopImmediatePropagation(); s.select(s.chain[s.depth]);
      }
    };
    const blocked = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "dragstart"];
    for (const name of blocked) window.addEventListener(name, block, true);
    window.addEventListener("mousemove", hover, true);
    window.addEventListener("keydown", key, true);
    return () => {
      cancelAnimationFrame(frame);
      for (const name of blocked) window.removeEventListener(name, block, true);
      window.removeEventListener("mousemove", hover, true);
      window.removeEventListener("keydown", key, true);
      // The note editor manages its own focus when selection is confirmed.
      if (document.activeElement === document.body && previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  return <>
    <ElementOverlays preview items={active ? [{ id: "selection", element: active, color }] : []} />
    <div className="element-picker" ref={toolbar} tabIndex={-1} role="dialog" aria-label="选择网页元素">
      <p className="element-picker-target" aria-live="polite">{active ? elementName(active) : "移动鼠标选择元素"}</p>
      <small className="element-picker-hints"><span>↑ 父级</span><span>↓ 子级</span><span>Esc 退出</span><span>左键添加批注</span></small>
    </div>
  </>;
}
