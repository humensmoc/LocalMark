import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Mark, Page } from "./model";
import { SiteIcon } from "./SiteIcon";

export type TagFilter = { category: string; tags: string[] };

export function TagBrowser({
  pages,
  categories,
  tags,
  filter,
  change,
  query,
  matches,
  open,
  annotation,
  selectedId,
  wholeCard = false,
  filterDivider,
}: {
  pages: Page[];
  categories: string[];
  tags: string[];
  filter: TagFilter;
  change: (value: TagFilter) => void;
  query: string;
  matches: (page: Page) => boolean;
  open: (page: Page) => void;
  annotation: (page: Page, mark: Mark) => ReactNode;
  selectedId?: string;
  wholeCard?: boolean;
  filterDivider?: ReactNode;
}) {
  const resultsRef = useRef<HTMLDivElement>(null);
  const searched = pages.filter((p) => matches(p));
  const results = searched.filter(
    (p) =>
      (!filter.category || p.category === filter.category) &&
      filter.tags.every((t) => p.tags.includes(t)),
  );
  const selectionKey = JSON.stringify(filter);
  useEffect(() => {
    resultsRef.current?.scrollTo(0, 0);
  }, [selectionKey, query]);
  const active = !!filter.category || filter.tags.length > 0;
  const toggleTag = (tag: string) =>
    change({
      ...filter,
      tags: filter.tags.includes(tag)
        ? filter.tags.filter((t) => t !== tag)
        : [...filter.tags, tag],
    });
  const categoryNames = [
    ...new Set([
      ...categories.filter((name) => pages.some((p) => p.category === name)),
      ...(filter.category ? [filter.category] : []),
    ]),
  ];
  const tagNames = [...new Set([...tags, ...filter.tags])];
  const categoryOptions = categoryNames
    .map((name) => ({
      name,
      count: searched.filter(
        (p) =>
          p.category === name && filter.tags.every((t) => p.tags.includes(t)),
      ).length,
    }))
    .filter((option) => option.count > 0);
  const tagOptions = tagNames
    .map((name) => ({
      name,
      count: results.filter((p) => p.tags.includes(name)).length,
    }))
    .filter((option) => option.count > 0);
  return (
    <div className="tag-browser">
      <section className="filter-panel" aria-label="标签筛选条件">
        <div className="filter-heading">
          <b>筛选网页</b>
          <button
            disabled={!active}
            onClick={() => change({ category: "", tags: [] })}
          >
            清空筛选
          </button>
        </div>
        <div className="filter-options">
          <div className="filter-label">
            主分类 <span>单选</span>
          </div>
          <div className="filter-chips" role="group" aria-label="主分类筛选">
            <button
              className="filter-chip"
              aria-pressed={!filter.category}
              onClick={() => change({ ...filter, category: "" })}
            >
              全部
            </button>
            {categoryOptions.map(({ name, count }) => (
              <button
                key={name}
                className="filter-chip"
                aria-pressed={filter.category === name}
                onClick={() =>
                  change({
                    ...filter,
                    category: filter.category === name ? "" : name,
                  })
                }
              >
                <span>{name}</span>
                <small>{count}</small>
              </button>
            ))}
          </div>
          <div className="filter-label">
            小标签 <span>多选 · 同时满足</span>
          </div>
          <div className="filter-chips" role="group" aria-label="小标签筛选">
            {tagOptions.map(({ name: tag, count }) => (
              <button
                key={tag}
                className="filter-chip"
                aria-pressed={filter.tags.includes(tag)}
                onClick={() => toggleTag(tag)}
              >
                <span>{tag}</span>
                <small>{count}</small>
              </button>
            ))}
            {!tagOptions.length && (
              <small>
                {tagNames.length
                  ? "当前条件下没有可用的小标签。"
                  : "暂无小标签，可在当前页面添加。"}
              </small>
            )}
          </div>
        </div>
      </section>
      {filterDivider}
      <div className="result-heading">
        <b role="status">{results.length} 个网页</b>
        <small>最近修改优先</small>
      </div>
      <div
        className="tag-results"
        ref={resultsRef}
        aria-label="筛选结果"
        tabIndex={0}
      >
        {!results.length && (
          <div className="empty">
            <p>{pages.length ? "没有符合条件的网页" : "尚未保存网页"}</p>
            <small>
              {pages.length
                ? "试试取消部分标签，或调整搜索词。"
                : "在当前页面添加分类、标签或评论后，即可在这里筛选。"}
            </small>
          </div>
        )}
        {results.map((p) => (
          <article
            className={`result-card page-surface${p.id === selectedId ? " selected-article" : ""}`}
            key={p.id}
            onClick={wholeCard ? (event) => {
              // Nested controls keep their own behavior; dragging text is not selection.
              if (event.defaultPrevented || (event.target as Element).closest("button,a,summary,input,textarea,select,[role='button']") || window.getSelection()?.toString()) return;
              open(p);
            } : undefined}
          >
            <SiteIcon site={p} backdrop />
            <div className="site-heading">
            <SiteIcon site={p} />
            <button
              className="title tag-page-title"
              title={p.title}
              onClick={() => open(p)}
              aria-pressed={selectedId === undefined ? undefined : p.id === selectedId}
            >
              {p.title}
            </button>
            </div>
            <div className="result-taxonomy">
              <span className="result-category">{p.category}</span>
              {p.tags.map((t) => (
                <span
                  className={
                    filter.tags.includes(t)
                      ? "result-tag selected"
                      : "result-tag"
                  }
                  key={t}
                >
                  {t}
                </span>
              ))}
            </div>
            {p.comment?.trim() && <CommentPreview comment={p.comment} />}
            {p.annotations.length > 0 && (
              <details className="result-annotations">
                <summary>
                  {p.annotations.length} 条高亮 ·{" "}
                  {p.annotations.filter((m) => m.note.trim()).length} 条批注{" "}
                  <span>展开摘录</span>
                </summary>
                {p.annotations.map((m) => annotation(p, m))}
              </details>
            )}
            {!p.comment?.trim() && !p.annotations.length && (
              <small className="result-empty">已收藏 · 暂无评论或摘录</small>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

function CommentPreview({ comment }: { comment: string }) {
  const previewRef = useRef<HTMLParagraphElement>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const measure = () =>
      setTruncated(preview.scrollWidth > preview.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [comment]);
  return (
    <div className="result-comment">
      <p ref={previewRef}>{comment.replace(/\s+/g, " ").trim()}</p>
      {truncated && (
        <details>
          <summary>查看完整评论</summary>
          <div>{comment}</div>
        </details>
      )}
    </div>
  );
}
