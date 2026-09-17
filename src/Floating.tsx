import {
  useLayoutEffect,
  useRef,
  type PropsWithChildren,
  type MouseEventHandler,
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
}: PropsWithChildren<{
  x: number;
  y: number;
  className: string;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
}>) {
  const ref = useRef<HTMLDivElement>(null);
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
      el.style.left = `${Math.max(left + margin, Math.min(x, left + width - bounds.width - margin))}px`;
      el.style.top = `${Math.max(top + margin, Math.min(y, top + height - bounds.height - margin))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(el);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [x, y, className]);
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
