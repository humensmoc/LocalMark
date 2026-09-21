import { useId, useLayoutEffect, useRef, useState } from "react";
import type { Page, Taxonomy } from "./model";
import { Icon } from "./Icon";

export type TagFilter = { category: string; tags: string[] };

export function matchesTagFilter(page: Page, filter: TagFilter, taxonomy?: Taxonomy) {
  return (!filter.category || (taxonomy ? page.categoryId : page.category) === filter.category)
    && filter.tags.every(tag => (taxonomy ? page.tagIds ?? [] : page.tags).includes(tag));
}

const defaultHeight = 180;
const minimumHeight = 84;
const clamp = (height: number, max: number) => Math.max(minimumHeight, Math.min(height, max));

export function TagFilters({ pages, categories, tags, filter, change, matches, taxonomy, storageKey, title = "筛选网页" }: {
  pages: Page[]; categories: string[]; tags: string[]; filter: TagFilter;
  change: (value: TagFilter) => void; matches: (page: Page) => boolean;
  taxonomy?: Taxonomy; storageKey: string; title?: string;
}) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const optionsId = useId();
  const drag = useRef<{ y: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [maximumHeight, setMaximumHeight] = useState(defaultHeight);
  const [contentHeight, setContentHeight] = useState(defaultHeight);
  const [preferences, setPreferences] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      const manual = saved?.manual === true;
      return { collapsed: saved?.collapsed === true, manual,
        height: typeof saved?.height === "number" && Number.isFinite(saved.height) ? clamp(saved.height, manual ? 2000 : defaultHeight) : defaultHeight };
    } catch { return { collapsed: false, manual: false, height: defaultHeight }; }
  });
  const height = clamp(preferences.manual ? preferences.height : Math.min(preferences.height, contentHeight), maximumHeight);
  function save(next: typeof preferences) {
    setPreferences(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep controls usable without storage. */ }
  }
  useLayoutEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    // Reserve room for the results even when a saved height came from a taller window.
    const measure = () => setMaximumHeight(Math.max(minimumHeight,
      Math.min(window.innerHeight * .65, parent.clientHeight - 160)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  useLayoutEffect(() => {
    const box = panel.current, head = heading.current, scroll = options.current, inner = content.current;
    if (!box || !head || !scroll || !inner) return;
    const measure = () => {
      const boxStyle = getComputedStyle(box), headStyle = getComputedStyle(head), scrollStyle = getComputedStyle(scroll);
      const extra = [boxStyle.paddingTop, boxStyle.paddingBottom, boxStyle.borderTopWidth, boxStyle.borderBottomWidth,
        headStyle.marginTop, headStyle.marginBottom, scrollStyle.paddingTop, scrollStyle.paddingBottom]
        .reduce((total, value) => total + (parseFloat(value) || 0), 0);
      setContentHeight(Math.ceil(inner.getBoundingClientRect().height + head.getBoundingClientRect().height + extra));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inner); observer.observe(head);
    return () => observer.disconnect();
  }, [preferences.collapsed]);
  const categoryId = (page: Page) => taxonomy ? page.categoryId : page.category;
  const tagIds = (page: Page) => taxonomy ? page.tagIds ?? [] : page.tags;
  const categoryName = (id: string) => taxonomy?.categories.find(item => item.id === id)?.name ?? id;
  const tagName = (id: string) => taxonomy?.tags.find(item => item.id === id)?.name ?? id;
  const searched = pages.filter(matches);
  const results = searched.filter(page => matchesTagFilter(page, filter, taxonomy));
  const categoryOptions = [...new Set([...(taxonomy?.categories.map(item => item.id) ?? categories), ...(filter.category ? [filter.category] : [])])]
    .map(id => ({ id, count: searched.filter(page => categoryId(page) === id && filter.tags.every(tag => tagIds(page).includes(tag))).length }))
    .filter(item => item.count > 0 || item.id === filter.category);
  const tagOptions = [...new Set([...(taxonomy?.tags.map(item => item.id) ?? tags), ...filter.tags])]
    .map(id => ({ id, count: results.filter(page => tagIds(page).includes(id)).length }))
    .filter(item => item.count > 0 || filter.tags.includes(item.id));
  const activeCount = Number(!!filter.category) + filter.tags.length;
  const selectedNames = [...(filter.category ? [categoryName(filter.category)] : []), ...filter.tags.map(tagName)].join("、");
  function resize(value: number) { save({ ...preferences, manual: true, height: clamp(value, maximumHeight) }); }
  function resetHeight() { save({ ...preferences, manual: false, height: defaultHeight }); }
  function endDrag() { drag.current = null; setDragging(false); }
  return <section ref={panel} className={`filter-panel resizable-filters${preferences.collapsed ? " collapsed" : ""}`}
    aria-label="标签筛选条件" style={{ height: preferences.collapsed ? "auto" : height }}>
    <div className="filter-heading" ref={heading}>
      <button className="filter-collapse" aria-expanded={!preferences.collapsed} aria-controls={optionsId}
        aria-label={preferences.collapsed ? "展开标签筛选" : "收起标签筛选"}
        onClick={() => save({ ...preferences, collapsed: !preferences.collapsed })}>
        <Icon name="arrow" size={13} /><b>{title}</b>
        <span>{preferences.collapsed ? "展开" : "收起"}</span>
      </button>
      {!!activeCount && <small className="filter-active-count" title={selectedNames}>已选 {activeCount} 项</small>}
      <button disabled={!activeCount} onClick={() => change({ category: "", tags: [] })}>清空筛选</button>
    </div>
    {!preferences.collapsed && <>
      <div className="filter-options" id={optionsId} ref={options}>
        <div className="filter-options-content" ref={content}>
        <div className="filter-label">主分类 <span>单选</span></div>
        <div className="filter-chips" role="group" aria-label="主分类筛选">
          <button className="filter-chip" aria-pressed={!filter.category} onClick={() => change({ ...filter, category: "" })}>全部</button>
          {categoryOptions.map(({ id, count }) => <button key={id} className="filter-chip" aria-pressed={filter.category === id}
            onClick={() => change({ ...filter, category: filter.category === id ? "" : id })}><span>{categoryName(id)}</span><small>{count}</small></button>)}
        </div>
        <div className="filter-label" title="多个标签同时满足">小标签 <span>多选</span></div>
        <div className="filter-chips" role="group" aria-label="小标签筛选">
          {tagOptions.map(({ id, count }) => <button key={id} className="filter-chip" aria-pressed={filter.tags.includes(id)}
            onClick={() => change({ ...filter, tags: filter.tags.includes(id) ? filter.tags.filter(tag => tag !== id) : [...filter.tags, id] })}>
            <span>{tagName(id)}</span><small>{count}</small>
          </button>)}
          {!tagOptions.length && <small>当前条件下没有可用的小标签。</small>}
        </div>
        </div>
      </div>
      <div className={`filter-height-divider${dragging ? " dragging" : ""}`} role="separator" tabIndex={0}
        aria-label="调整标签区域高度" aria-orientation="horizontal" aria-controls={optionsId}
        aria-valuemin={minimumHeight} aria-valuemax={Math.round(maximumHeight)} aria-valuenow={Math.round(height)} aria-valuetext={`${Math.round(height)} 像素`}
        title="拖动调整高度 · 上下方向键微调 · 双击恢复紧凑自动高度"
        onDoubleClick={resetHeight}
        onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { y: event.clientY, height }; setDragging(true);
        }}
        onPointerMove={event => { if (drag.current) resize(drag.current.height + event.clientY - drag.current.y); }}
        onPointerUp={event => {
          if (drag.current) resize(drag.current.height + event.clientY - drag.current.y);
          endDrag();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={endDrag} onLostPointerCapture={endDrag}
        onKeyDown={event => {
          if (["ArrowUp", "ArrowDown", "Home", "End", "Enter"].includes(event.key)) {
            event.preventDefault();
            if (event.key === "Enter") { resetHeight(); return; }
            resize(event.key === "Home" ? minimumHeight : event.key === "End" ? maximumHeight
              : height + (event.key === "ArrowUp" ? -1 : 1) * (event.shiftKey ? 40 : 10));
          }
        }} />
    </>}
  </section>;
}
