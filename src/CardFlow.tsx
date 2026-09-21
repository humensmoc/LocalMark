import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Preserve source/keyboard order while packing cards from the top, then left. */
export function CardFlow({ children, className, minWidth = 230, gap = 10, singleColumnBelow, maxColumns = Infinity }: {
  children: ReactNode;
  className: string;
  minWidth?: number;
  gap?: number;
  singleColumnBelow?: number;
  maxColumns?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const cards = Array.from(container.children) as HTMLElement[];
    const narrow = singleColumnBelow === undefined ? undefined : matchMedia(`(max-width: ${singleColumnBelow}px)`);
    let frame = 0;
    const layout = () => {
      const width = container.clientWidth;
      if (!width) return;
      const count = narrow?.matches ? 1 : Math.max(1, Math.min(maxColumns, Math.floor((width + gap) / (minWidth + gap))));
      const cardWidth = (width - gap * (count - 1)) / count;
      cards.forEach(card => { card.style.width = `${cardWidth}px`; });
      const heights = cards.map(card => card.getBoundingClientRect().height);
      const bottoms = Array<number>(count).fill(0);
      cards.forEach((card, index) => {
        const column = bottoms.indexOf(Math.min(...bottoms));
        card.style.left = `${column * (cardWidth + gap)}px`;
        card.style.top = `${bottoms[column]}px`;
        bottoms[column] += heights[index] + gap;
      });
      container.style.height = `${Math.max(0, ...bottoms) - (cards.length ? gap : 0)}px`;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    };
    layout();
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    cards.forEach(card => observer.observe(card));
    narrow?.addEventListener("change", schedule);
    return () => {
      observer.disconnect();
      narrow?.removeEventListener("change", schedule);
      cancelAnimationFrame(frame);
    };
  }, [children, minWidth, gap, singleColumnBelow, maxColumns]);
  return <div className={`card-flow ${className}`} ref={containerRef}>{children}</div>;
}
