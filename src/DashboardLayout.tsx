import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

type Columns = [number, number, number];
const defaults: Columns = [0.15, 0.55, 0.3];
const minimums: Columns = [160, 260, 300];
const storageKey = "localmark.dashboard.columns";
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

function readColumns(): Columns {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (
      Array.isArray(saved) &&
      saved.length === 3 &&
      saved.every(
        (n) => typeof n === "number" && Number.isFinite(n) && n > 0,
      ) &&
      Math.abs(saved.reduce((a, b) => a + b, 0) - 1) < 0.001
    )
      return saved as Columns;
  } catch {
    /* Use defaults if storage is unavailable or invalid. */
  }
  return defaults;
}

export function useDashboardLayout() {
  const workspace = useRef<HTMLDivElement>(null);
  const [ratios, setRatios] = useState<Columns>(readColumns);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = workspace.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    setWidth(node.clientWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // Two 8px handles are outside the three content columns.
  const available = Math.max(720, width - 16);
  const left = clamp(
    ratios[0] * available,
    minimums[0],
    available - minimums[1] - minimums[2],
  );
  const right = clamp(
    ratios[2] * available,
    minimums[2],
    available - left - minimums[1],
  );
  const columns: Columns = [left, available - left - right, right];
  function save(next: Columns) {
    setRatios(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Still resize for this window. */
    }
  }
  const divider = (index: 0 | 1) => (
    <ColumnDivider
      index={index}
      columns={columns}
      change={(next) => save(next.map((n) => n / available) as Columns)}
      reset={() => save(defaults)}
    />
  );
  return {
    workspace,
    style: {
      "--filter-width": `${columns[0]}px`,
      "--browser-width": `${columns[0] + columns[1] + 8}px`,
    } as CSSProperties,
    filterDivider: divider(0),
    detailDivider: divider(1),
  };
}

function ColumnDivider({
  index,
  columns,
  change,
  reset,
}: {
  index: 0 | 1;
  columns: Columns;
  change: (next: Columns) => void;
  reset: () => void;
}) {
  const drag = useRef<{ x: number; columns: Columns } | null>(null);
  const [active, setActive] = useState(false);
  const pair = columns[index] + columns[index + 1];
  function move(base: Columns, delta: number) {
    const next = [...base] as Columns;
    const total = base[index] + base[index + 1];
    next[index] = clamp(
      base[index] + delta,
      minimums[index],
      total - minimums[index + 1],
    );
    next[index + 1] = total - next[index];
    change(next);
  }
  function end() {
    drag.current = null;
    setActive(false);
  }
  return (
    <div
      className={`dashboard-divider ${index === 0 ? "filter-divider" : "detail-divider"}${active ? " dragging" : ""}`}
      role="separator"
      aria-label={
        index === 0 ? "调整筛选栏与网页列表宽度" : "调整网页列表与文章详情宽度"
      }
      aria-orientation="vertical"
      aria-valuemin={Math.round((minimums[index] / pair) * 100)}
      aria-valuemax={Math.round(((pair - minimums[index + 1]) / pair) * 100)}
      aria-valuenow={Math.round((columns[index] / pair) * 100)}
      aria-valuetext={`${Math.round(columns[index])} 像素`}
      tabIndex={0}
      title="拖动调整宽度 · 方向键微调 · 双击恢复默认布局"
      onDoubleClick={reset}
      onPointerDown={(e) => {
        if (e.button !== 0 || !e.isPrimary) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, columns };
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (drag.current)
          move(drag.current.columns, e.clientX - drag.current.x);
      }}
      onPointerUp={(e) => {
        if (drag.current)
          move(drag.current.columns, e.clientX - drag.current.x);
        end();
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          move(
            columns,
            (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 40 : 10),
          );
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          move(columns, e.key === "Home" ? -pair : pair);
        } else if (e.key === "Enter") {
          e.preventDefault();
          reset();
        }
      }}
    />
  );
}
