import {
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import type { Page, Taxonomy } from "./model";
import { CardFlow } from "./CardFlow";
import { PageCard } from "./PageCard";

import { TagFilters, matchesTagFilter, type TagFilter } from "./TagFilters";
export type { TagFilter } from "./TagFilters";

export function TagBrowser({
  pages,
  categories,
  tags,
  filter,
  change,
  query,
  matches,
  open,
  selectedId,
  compactCards = false,
  filterDivider,
  taxonomy,
  selection,
  selectionControls,
  navigation,
  sidebarFooter,
  showRatingFilter = false,
}: {
  pages: Page[];
  categories: string[];
  tags: string[];
  filter: TagFilter;
  change: (value: TagFilter) => void;
  query: string;
  matches: (page: Page) => boolean;
  open: (page: Page) => void;
  selectedId?: string;
  compactCards?: boolean;
  filterDivider?: ReactNode;
  taxonomy?: Taxonomy;
  selection?: { ids: string[]; toggle: (id: string) => void };
  selectionControls?: (summary: ReactNode) => ReactNode;
  navigation?: ReactNode;
  sidebarFooter?: ReactNode;
  showRatingFilter?: boolean;
}) {
  const resultsRef = useRef<HTMLDivElement>(null);
  const searched = pages.filter((p) => matches(p));
  const results = searched.filter(p => matchesTagFilter(p, filter, taxonomy));
  const selectionKey = JSON.stringify(filter);
  useEffect(() => {
    resultsRef.current?.scrollTo(0, 0);
  }, [selectionKey, query]);
  return (
    <div className="tag-browser">
      {navigation && <aside className="library-rail">{navigation}{sidebarFooter}</aside>}
      {filterDivider}
      <TagFilters pages={pages} categories={categories} tags={tags} filter={filter}
        change={change} matches={matches} taxonomy={taxonomy}
        showRating={showRatingFilter}
        storageKey={navigation ? "localmark.filters.dashboard.pages" : "localmark.filters.sidepanel.tags"} />
      {selectionControls ? selectionControls(<b role="status">{results.length} 个网页</b>) : <div className="result-heading">
        <b role="status">{results.length} 个网页</b>
        <small>最近修改优先</small>
      </div>}
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
                ? "试试取消部分筛选条件，或调整搜索词。"
                : "在当前页面添加分类、标签或评论后，即可在这里筛选。"}
            </small>
          </div>
        )}
        <ResultCards columns={compactCards}>{results.map((p) => (
          <PageCard key={p.id} page={p} open={open}
            selected={selectedId === undefined ? undefined : p.id === selectedId}
            selectedTags={p.tags.filter(tag => filter.tags.includes(taxonomy ? taxonomy.tags.find(x => x.name === tag)?.id ?? tag : tag))}
            selection={selection ? { checked: selection.ids.includes(p.id), toggle: () => selection.toggle(p.id) } : undefined} />
        ))}</ResultCards>
      </div>
    </div>
  );
}

function ResultCards({ columns, children }: { columns: boolean; children: ReactNode }) {
  return columns ? <CardFlow className="page-card-columns">{children}</CardFlow> : <>{children}</>;
}
