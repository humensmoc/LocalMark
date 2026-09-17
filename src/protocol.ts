import type { Anchor, Color, Library } from "./model";
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
  | {
      type: "page-category";
      url: string;
      title: string;
      favicon: string;
      category: string;
      expectedCategory: string;
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
    }
  | { type: "snapshot"; refresh?: boolean }
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
