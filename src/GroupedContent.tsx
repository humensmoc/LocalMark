import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Page, Mark } from "./model";
import { PageCard } from "./PageCard";
import { groupedLayout } from "./grouped-layout";

export function GroupedContent({ groups, open, renderMark }: {
  groups: { page: Page; marks: Mark[] }[]; open: (page: Page) => void;
  renderMark: (page: Page, mark: Mark) => ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<ReturnType<typeof groupedLayout>>();
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const rows = [...root.querySelectorAll<HTMLElement>(".content-page-group")].map(group => [...group.children] as HTMLElement[]);
    let frame = 0;
    const narrow = matchMedia("(max-width: 720px)");
    const layout = () => {
      const width = root.clientWidth;
      if (!width) return;
      const columns = narrow.matches ? 1 : Math.max(1, Math.floor(width / 328));
      for (const row of rows) for (const card of row) card.style.width = `${width / Math.min(columns, row.length) - 18}px`;
      const next = groupedLayout(rows.map(row => row.map(card => card.getBoundingClientRect().height)), width, columns);
      rows.forEach((row, g) => row.forEach((card, i) => {
        const box = next.groups[g].cards[i];
        card.style.left = `${box.left}px`;
        card.style.top = `${box.top}px`;
      }));
      root.style.height = `${next.height}px`;
      setGeometry(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout); };
    layout();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    for (const row of rows) for (const card of row) observer.observe(card);
    narrow.addEventListener("change", schedule);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); narrow.removeEventListener("change", schedule); };
  }, [groups]);
  return <div className="grouped-content-flow" ref={rootRef}>
    {geometry && <svg className="content-group-outlines" width="100%" height={geometry.height} aria-hidden="true">
      {geometry.groups.map((group, i) => <path key={groups[i]?.page.id ?? i} d={group.path} className={`group-color-${i % 4}`} data-group-id={groups[i]?.page.id} />)}
    </svg>}
    {groups.map(({ page, marks }, index) => <section className={`content-page-group group-color-${index % 4}`} key={page.id} data-page-id={page.id} aria-label={`网页摘录：${page.title}`}>
      <PageCard page={page} open={open} className="group-page-card" />
      {marks.map(mark => renderMark(page, mark))}
    </section>)}
  </div>;
}
