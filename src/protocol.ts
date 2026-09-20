import type { Anchor, Color, Library } from "./model";
import type { BulkAction, TaxonomyAction } from "./taxonomy";
export type Mutation = {
  id?: string;
  expectedUpdatedAt?: string;
  expectedMark?: string;
  text: string;
  note: string;
  color: Color;
  anchor: Anchor;
};
export type Request =
  | { type: "page-rating"; url: string; title: string; favicon: string; rating: number | null; expectedRating: number | null }
  | { type: "taxonomy"; action: TaxonomyAction; expected: string }
  | { type: "bulk-taxonomy"; selected: Record<string, string>; action: BulkAction; expected: string }
  | { type: "resolve-taxonomy"; choice: "local" | "disk" }
  | {
      type: "page-title";
      url: string;
      title: string;
      favicon: string;
      expectedTitle: string | null;
    }
  | {
      type: "page-category";
      url: string;
      title: string;
      favicon: string;
      category: string;
      expectedCategory: string;
      categoryId?: string;
      expectedTaxonomy?: string;
    }
  | {
      type: "page-comment";
      url: string;
      title: string;
      favicon: string;
      comment: string;
      expectedComment: string;
    }
  | {
      type: "page-tag";
      url: string;
      title: string;
      favicon: string;
      tag: string;
      action: "add" | "remove";
      tagId?: string;
      expectedTaxonomy?: string;
    }
  | { type: "snapshot"; refresh?: boolean }
  | { type: "auto-generate-markdown"; enabled: boolean }
  | {
      type: "save";
      url: string;
      title: string;
      favicon: string;
      mark: Mutation;
    }
  | {
      type: "delete";
      pageId: string;
      id: string;
      expectedUpdatedAt: string;
      expectedMark: string;
    }
  | { type: "resolve"; pageId: string; choice: "local" | "disk" }
  | { type: "settings" }
  | { type: "dashboard" }
  | { type: "open"; url: string }
  | { type: "directory-connected" };
export async function request(message: Request): Promise<Library> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok)
    throw Error(response?.error || "插件连接已断开，请刷新网页");
  return response.data;
}
