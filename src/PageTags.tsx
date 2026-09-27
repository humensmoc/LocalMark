import { useState } from "react";
import { Icon } from "./Icon";

export function PageTags({
  tags,
  allTags,
  change,
  browse,
  counts,
  compact = false,
}: {
  tags: string[];
  allTags: string[];
  counts: Map<string, number>;
  change: (tag: string, action: "add" | "remove") => Promise<void>;
  browse: (tag: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const value = query.trim().replace(/^#/, "");
  const suggestions = value
    ? allTags.filter((tag) =>
        tag.toLocaleLowerCase().includes(value.toLocaleLowerCase()),
      )
    : allTags;
  async function update(tag: string, action: "add" | "remove") {
    if (!tag || busy) return;
    setBusy(true);
    setError("");
    try {
      await change(tag, action);
      setQuery("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="page-tags" aria-label="网页标签">
      {!compact && <div className="section-title">小标签 · 可多选</div>}
      <div className="row wrap">
        <button
          className="tag-add"
          aria-label="添加网页标签"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          +
        </button>
        {tags.map((tag) => (
          <span className="page-tag" key={tag}>
            <button onClick={() => browse(tag)} title={`查看标签：${tag}`}>
              {tag}
            </button>
            <button
              disabled={busy}
              aria-label={`移除网页标签：${tag}`}
              onClick={() => void update(tag, "remove")}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
        {!tags.length && <small>给这个网页添加标签</small>}
      </div>
      {open && (
        <div className="tag-picker">
          <input
            autoFocus
            aria-label="搜索或新建网页标签"
            placeholder="搜索标签，或输入新标签…"
            value={query}
            maxLength={100}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
              if (
                e.key === "Enter" &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault();
                void update(value, "add");
              }
            }}
          />
          <div className="section-title">
            {value ? "搜索结果" : "全部小标签"}
          </div>
          <div className="tag-options">
            {suggestions.map((tag) => (
              <button
                key={tag}
                disabled={busy}
                aria-pressed={tags.includes(tag)}
                onClick={() =>
                  void update(tag, tags.includes(tag) ? "remove" : "add")
                }
              >
                <Icon name="tag" size={14} />
                {tag}
                <small>{tags.includes(tag) ? "已添加" : "添加"} · {counts.get(tag) ?? 0}</small>
              </button>
            ))}
            {value && !allTags.includes(value) && (
              <button
                className="create-tag"
                disabled={busy}
                onClick={() => void update(value, "add")}
              >
                + 新建“{value}”
              </button>
            )}
            {!value && !allTags.length && (
              <small>输入名称，按 Enter 创建标签</small>
            )}
          </div>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
