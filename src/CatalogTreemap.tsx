import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { CatalogItem } from "./LibraryViews";
import { treemap } from "./treemap";

const palette = ["#4e9cff", "#f29b45", "#bd7af2", "#31c3af", "#ed729f", "#bad15c", "#67bfe5", "#ed6b61", "#e8c75b", "#9295f7"];
const percent = (count: number, total: number) => {
  const value = total ? count / total * 100 : 0;
  return value > 0 && value < 0.1 ? "<0.1%" : `${Number(value.toFixed(1))}%`;
};

export function CatalogTreemap({ items, allItems, kind, filtered, selected, choose }: {
  items: CatalogItem[]; allItems: CatalogItem[]; kind: "categories" | "tags"; filtered: boolean; selected: string; choose: (id: string) => void;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const total = items.reduce((sum, item) => sum + item.count, 0);
  // Give the largest items distinct hues. Use the full catalog so searching and
  // resizing do not change the colors of the remaining items.
  const colors = new Map([...allItems].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .map((item, index) => [item.id, palette[index % palette.length]]));
  const color = (id: string) => colors.get(id)!;
  const ranked = items.filter(item => item.count > 0).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const empty = items.filter(item => !item.count);
  const tiles = treemap(items, size.width, size.height);
  const describe = (item: CatalogItem) => `${item.name} · ${item.count} 个网页 · ${percent(item.count, total)}`;
  return <div className="catalog-proportions">
    <div className="treemap-heading">
      <div><strong>{total.toLocaleString()}</strong><span>{kind === "tags" ? "次标签关联" : "个网页"}{filtered ? " · 当前搜索结果" : ""}</span></div>
      {ranked[0] && <span className="treemap-largest" style={{ "--tile-color": color(ranked[0].id) } as CSSProperties}><i aria-hidden="true" />最多：{ranked[0].name} <b>{percent(ranked[0].count, total)}</b></span>}
    </div>
    <p className="treemap-hint">面积越大，关联网页越多。{kind === "tags" ? "同一网页可计入多个标签，占比按标签关联总数计算。" : "占比按当前展示分类的网页总数计算。"}点击色块查看详情。</p>
    <div ref={canvas} className={`treemap-canvas${total ? "" : " is-empty"}`} role="group" aria-label={kind === "tags" ? "子标签网页数量占比图" : "主分类网页数量占比图"}>
      {tiles.map(({ item, x, y, width, height }) => <button key={item.id}
        className={`treemap-tile${selected === item.id ? " selected" : ""}${width < 130 || height < 150 ? " compact" : ""}${width < 80 ? " slim" : ""}${height < 56 ? " short" : ""}${width < 42 || height < 34 ? " tiny" : ""}`}
        style={{ left: x, top: y, width, height, "--tile-color": color(item.id), "--tile-font": `${Math.max(13, Math.min(26, Math.min(width / 7, height / 6)))}px` } as CSSProperties}
        title={`${describe(item)}${item.description ? `\n${item.description}` : ""}`} aria-label={describe(item)} aria-pressed={selected === item.id} onClick={() => choose(item.id)}>
        <span className="treemap-tile-surface">
          <span className="treemap-name">{item.name}</span>
          <span className="treemap-value"><strong>{item.count}</strong><span> 个网页</span></span>
          <span className="treemap-percent">{percent(item.count, total)}</span>
        </span>
      </button>)}
      {!total && <p className="treemap-empty">当前项目还没有关联网页，暂无数量占比。</p>}
    </div>
    {!!ranked.length && <details className="treemap-breakdown"><summary>数量明细 · {ranked.length} 项</summary>
      <div className="treemap-ranking">{ranked.map(item => <button key={item.id} aria-pressed={selected === item.id} onClick={() => choose(item.id)} title={describe(item)}>
        <i style={{ background: color(item.id) }} /><span>{item.name}</span><b>{item.count}</b><small>{percent(item.count, total)}</small>
      </button>)}</div>
    </details>}
    {!!empty.length && <div className="treemap-zero"><p>暂无网页 · {empty.length} 项</p><div>{empty.map(item => <button key={item.id} aria-pressed={selected === item.id} onClick={() => choose(item.id)}>{item.name}<small>0</small></button>)}</div></div>}
  </div>;
}
