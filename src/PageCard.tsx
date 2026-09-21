import type { Page } from "./model";
import { SiteIcon } from "./SiteIcon";
import { RatingDots } from "./PageRating";

/** The same webpage summary in the library, sidebar and grouped highlights. */
export function PageCard({ page, open, selected, selectedTags = [], selection, className = "" }: {
  page: Page; open: (page: Page) => void; selected?: boolean; selectedTags?: string[];
  selection?: { checked: boolean; toggle: () => void }; className?: string;
}) {
  const notes = page.annotations.filter(mark => mark.note.trim()).length;
  return <article className={`result-card webpage-card page-surface${(selection ? selection.checked : selected) ? " selected-article" : ""}${selection ? " multi-select-card" : ""} ${className}`}
    onClickCapture={selection ? event => {
      // Native checkbox/label clicks toggle via onChange; other card surfaces
      // (including the title button) select instead of opening the detail.
      if ((event.target as Element).closest(".article-checkbox")) return;
      event.preventDefault(); event.stopPropagation(); selection.toggle();
    } : undefined}
    data-page-id={page.id} onClick={event => {
      if (event.defaultPrevented || (event.target as Element).closest("button,a,input,textarea,select,[role='button']") || window.getSelection()?.toString()) return;
      open(page);
    }}>
    {selection && <label className="article-checkbox" onClick={e => e.stopPropagation()}>
      <input type="checkbox" aria-label={`选择文章：${page.title}`} checked={selection.checked} onChange={selection.toggle} />选择
    </label>}
    <SiteIcon site={page} backdrop />
    <div className="site-heading"><SiteIcon site={page} />
      <button className="title tag-page-title" title={page.title} aria-pressed={selection ? selection.checked : selected} onClick={() => open(page)}>{page.title}</button>
    </div>
    <div className="page-card-meta">
      <div className="result-taxonomy">
        <span className="result-category">{page.category}</span>
        {page.tags.map(tag => <span className={`result-tag${selectedTags.includes(tag) ? " selected" : ""}`} key={tag}>{tag}</span>)}
      </div>
      <RatingDots rating={page.rating} />
    </div>
    {page.comment?.trim() && <div className="result-comment"><p title={page.comment}>{page.comment.replace(/\s+/g, " ").trim()}</p></div>}
    {page.annotations.length > 0 && <div className="result-stats" aria-label={`${page.annotations.length} 条高亮${notes ? `，${notes} 条批注` : ""}`}>
      <span><strong>{page.annotations.length}</strong><span>高亮</span></span>
      {notes > 0 && <span><strong>{notes}</strong><span>批注</span></span>}
    </div>}
  </article>;
}
