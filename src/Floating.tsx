import {
  useLayoutEffect,
  useRef,
  type PropsWithChildren,
  type MouseEventHandler,
  type RefObject,
} from "react";

// Measure rendered content instead of estimating editor height from its fields.
export function Floating({
  x,
  y,
  className,
  children,
  onMouseDown,
  onMouseEnter,
  onMouseLeave,
  elementRef,
  anchorRef,
}: PropsWithChildren<{
  x: number;
  y: number;
  className: string;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
  elementRef?: RefObject<HTMLDivElement | null>;
  anchorRef?: RefObject<HTMLDivElement | null>;
}>) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = elementRef ?? localRef;
  useLayoutEffect(() => {
    const el = ref.current!;
    const position = () => {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0,
        top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth,
        height = viewport?.height ?? innerHeight;
      const margin = 12;
      el.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
      el.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
      const bounds = el.getBoundingClientRect();
      const anchor = anchorRef?.current?.getBoundingClientRect();
      let targetX = x,
        targetY = y;
      if (anchor) {
        // Reserve the quick button's entire rectangle, even in a short viewport.
        const gap = 8;
        const below = Math.max(0, top + height - margin - anchor.bottom - gap);
        const above = Math.max(0, anchor.top - gap - top - margin);
        const placeBelow = below >= bounds.height || below >= above;
        const available = placeBelow ? below : above;
        el.style.maxHeight = `${available}px`;
        const panelHeight = el.getBoundingClientRect().height;
        targetX = anchor.left;
        targetY = placeBelow
          ? anchor.bottom + gap
          : anchor.top - gap - panelHeight;
      }
      el.style.left = `${Math.max(left + margin, Math.min(targetX, left + width - bounds.width - margin))}px`;
      el.style.top = `${Math.max(top + margin, Math.min(targetY, top + height - el.getBoundingClientRect().height - margin))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(el);
    if (anchorRef?.current) observer.observe(anchorRef.current);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [x, y, className, ref, anchorRef]);
  return (
    <div
      ref={ref}
      className={`floating ${className}`}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>
  );
}
