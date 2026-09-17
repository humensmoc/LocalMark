import { useState } from "react";

export function PageCategory({ category, categories, counts, change, browse }: {
  category: string;
  categories: string[];
  counts: Map<string, number>;
  change: (category: string) => Promise<void>;
  browse: (category: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const value = query.trim();
  async function select(next: string) {
    if (busy || !next) return;
    setBusy(true);
    setError("");
    try {
      await change(next);
      setQuery("");
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return <section className="page-category" aria-label="网页主分类">
    <div className="row spread">
      <label>主分类 · 单选</label>
      <button className="category-browse" onClick={() => browse(category)}>查看同类网页</button>
    </div>
    <button className="category-trigger" aria-label="选择主分类" aria-expanded={open} onClick={() => setOpen(!open)}>{category}</button>
    {open && <div className="tag-picker">
      <input autoFocus aria-label="搜索或新建主分类" placeholder="搜索分类，或输入新分类…" maxLength={100} value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
          if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault(); void select(value);
          }
        }} />
      <div className="category-options" role="radiogroup" aria-label="主分类选项">
        {categories.filter((name) => name.toLocaleLowerCase().includes(value.toLocaleLowerCase())).map((name) =>
          <label className="category-option" key={name}>
            <input type="radio" name="wc-category" checked={category === name} disabled={busy} onChange={() => void select(name)} />
            <span>{name}</span><small>{counts.get(name) ?? 0}</small>
          </label>
        )}
      </div>
      {value && !categories.includes(value) && <button disabled={busy} onClick={() => void select(value)}>新建并选择“{value}”</button>}
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
