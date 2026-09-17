import { z } from "zod";
export const COLORS = {
  yellow: { name: "黄色", hex: "#ffe68b" },
  green: { name: "绿色", hex: "#8adbad" },
  blue: { name: "蓝色", hex: "#82c9ff" },
  pink: { name: "粉色", hex: "#f3a4c7" },
  purple: { name: "紫色", hex: "#c2abf5" },
} as const;
export type Color = keyof typeof COLORS;
export const PageCommentSchema = z.string().max(100000);
export const DEFAULT_CATEGORY = "未分类";
export const DEFAULT_CATEGORIES = [DEFAULT_CATEGORY, "游戏设计", "交互设计", "视觉设计", "游戏营销", "游戏分析", "访谈"];
export const PageCategorySchema = z.string().trim().min(1).max(100);
const timestamp = z.string().datetime();
export const PageTagsSchema = z
  .array(z.string().trim().min(1).max(100))
  .max(500);
export const AnchorSchema = z
  .object({
    exact: z.string().min(1).max(100000),
    prefix: z.string().max(128),
    suffix: z.string().max(128),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    path: z.string().max(4000).optional(),
    occurrences: z.number().int().positive().optional(),
  })
  .refine((a) => a.end > a.start, "定位范围无效");
export const MarkSchema = z
  .object({
    id: z.string().uuid(),
    text: z.string().min(1).max(100000),
    note: z.string().max(100000),
    tags: z.array(z.string().min(1).max(100)).max(50),
    color: z.enum(["yellow", "green", "blue", "pink", "purple"]),
    anchor: AnchorSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  ; // Display text can change without changing the original source anchor.
export const PageSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    id: z.string().regex(/^[a-f0-9]{16}$/),
    url: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//.test(u)),
    originalUrl: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//.test(u)),
    title: z.string().min(1).max(1000),
    favicon: z.string().max(8000),
    folderName: z
      .string()
      .min(1)
      .max(140)
      .refine(
        (s) =>
          !/[\\/:*?"<>|\x00-\x1f]/.test(s) &&
          !/[. ]$/.test(s) &&
          s !== "." &&
          s !== "..",
      ),
    createdAt: timestamp,
    updatedAt: timestamp,
    annotations: z.array(MarkSchema).max(10000),
    tags: PageTagsSchema.optional(),
    tagIds: z.array(z.string().min(1)).max(500).optional(),
    categoryId: z.string().min(1).optional(),
    comment: PageCommentSchema.optional(),
    category: PageCategorySchema.default(DEFAULT_CATEGORY),
    markdownFile: z
      .string()
      .min(4)
      .max(220)
      .refine(
        (s) =>
          !/[\\/:*?"<>|\x00-\x1f]/.test(s) &&
          s.endsWith(".md") &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(s),
      )
      .optional(),
  })
  .refine(p => p.schemaVersion === 1 || (!!p.categoryId && Array.isArray(p.tagIds) && new Set(p.tagIds).size === p.tagIds.length), "v2 网页必须包含有效的分类 ID 和不重复的标签 ID")
  .refine(
    (p) =>
      new Set(p.annotations.map((a) => a.id)).size === p.annotations.length,
    "标注 ID 重复",
  )
  .transform((p) => ({
    ...p,
    tags: p.tags ?? [...new Set(p.annotations.flatMap((m) => m.tags))],
  }));
export type Anchor = z.infer<typeof AnchorSchema>;
export type Mark = z.infer<typeof MarkSchema>;
export type Page = z.infer<typeof PageSchema>;
export type Issue = {
  kind: "json" | "markdown" | "missing" | "invalid" | "io";
  message: string;
  external?: string;
};
export type Entry = {
  page: Page;
  baseJson: string | null;
  baseMd: string | null;
  dirty: boolean;
  mdDirty: boolean;
  issue?: Issue;
  legacyMdPath?: string;
  legacyMdBase?: string | null;
};
export type Library = {
  taxonomy?: Taxonomy;
  taxonomyBase?: string | null;
  taxonomyDirty?: boolean;
  taxonomyIssue?: string;
  entries: Record<string, Entry>;
  lastColor: Color;
  status: string;
  errors: string[];
  directoryName?: string;
};
export type Taxon = { id: string; name: string; description?: string };
export type Taxonomy = { version: 1; revision: string; categories: Taxon[]; tags: Taxon[]; colorDescriptions?: Partial<Record<Color, string>> };
export const emptyLibrary = (): Library => ({
  entries: {},
  lastColor: "yellow",
  status: "尚未连接本地文件夹；标注暂存于浏览器",
  errors: [],
});
export function canonicalUrl(value: string) {
  const u = new URL(value);
  u.hash = u.hash.split(":~:")[0];
  if (!/^#(?:\/|!)/.test(u.hash)) u.hash = "";
  return u.href;
}
export async function pageId(url: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalUrl(url)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 16);
}
export function folderName(title: string, id: string) {
  let name =
    title
      .replace(/\p{Cf}/gu, "")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .trim()
      .slice(0, 70)
      .replace(/[. ]+$/, "") || "未命名网页";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = "_" + name;
  return `${name}--${id}`;
}
export function tagsFrom(value: string) {
  return [
    ...new Set(
      value
        .split(/[,，\n]/)
        .map((t) => t.trim().replace(/^#/, ""))
        .filter(Boolean),
    ),
  ].slice(0, 50);
}
const encode = (s: string) =>
  encodeURIComponent(s).replace(
    /[-!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
export function textLink(page: Pick<Page, "url">, a: Anchor) {
  const u = new URL(page.url);
  const prefix = a.prefix.trim(),
    suffix = a.suffix.trim();
  const selector =
    (prefix ? `${encode(prefix)}-,` : "") +
    encode(a.exact) +
    (suffix ? `,-${encode(suffix)}` : "");
  return u.href + `${u.hash ? "" : "#"}:~:text=${selector}`;
}
const md = (s: string) => s.replace(/[\\`*_[\]<>]/g, "\\$&");
export function previousMarkdown(p: Page, legacy = false) {
  return (
    `<!-- local-web-clipper:${p.id}:v1；自动生成，请在插件或 JSON 中编辑 -->\n# ${md(p.title.replace(/\s+/g, " "))}\n\n来源：[打开网页](<${p.url.replace(/>/g, "%3E")}>)\n\n创建：${p.createdAt}  \n更新：${p.updatedAt}\n\n` +
    (!legacy && p.tags?.length
      ? "网页标签：" +
        p.tags.map((t) => "`" + t.replace(/`/g, "") + "`").join(" ") +
        "\n\n"
      : "") +
    p.annotations
      .map(
        (m, i) =>
          `## ${i + 1}. 摘录\n\n${m.text
            .split("\n")
            .map((l) => "> " + md(l))
            .join("\n")}\n\n${
            m.note
              ? "批注：\n\n" +
                m.note
                  .split("\n")
                  .map((l) => md(l))
                  .join("  \n") +
                "\n\n"
              : ""
          }${legacy && m.tags.length ? "标签：" + m.tags.map((t) => "`" + t.replace(/`/g, "") + "`").join(" ") + "\n\n" : ""}创建：${m.createdAt}  \n更新：${m.updatedAt}\n\n[回到原文并高亮](<${textLink(p, m.anchor)}>)\n\n<!-- annotation:${m.id} -->\n`,
      )
      .join("\n---\n\n")
  );
}
export function markdownFileName(title: string, suffix = "") {
  let name =
    title
      .replace(/\p{Cf}/gu, "")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .trim()
      .slice(0, 170)
      .replace(/[. ]+$/, "") || "未命名网页";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = "_" + name;
  return `${name}${suffix}.md`;
}
// Retained only to recognize untouched exports from versions 1.0.3–1.0.4.
export function titledMarkdown(p: Page) {
  const header = previousMarkdown({ ...p, annotations: [] });
  return (
    header +
    p.annotations
      .map(
        (m, i) =>
          `## ${i + 1}. 摘录\n\n### 高亮原文\n\n${m.text
            .split("\n")
            .map((line) => "> " + md(line))
            .join(
              "\n",
            )}\n\n### 批注\n\n${m.note.trim() ? m.note.split("\n").map(md).join("  \n") : "未填写批注"}\n\n创建：${m.createdAt}  \n更新：${m.updatedAt}\n\n[回到原文并高亮](<${textLink(p, m.anchor)}>)\n\n<!-- annotation:${m.id} -->\n`,
      )
      .join("\n---\n\n")
  );
}
// Retained only to recognize untouched exports from versions 1.0.5–1.0.6.
export function compactMarkdown(p: Page) {
  const comment = p.comment?.trim()
    ? "## 网页评论\n\n" + p.comment.split("\n").map(md).join("  \n") + "\n\n"
    : "";
  return previousMarkdown({ ...p, annotations: [] }) + comment + p.annotations.map((m) => {
    const quote = m.text.split("\n").map((line) => "> " + md(line)).join("\n");
    const note = m.note.trim() ? m.note.split("\n").map(md).join("  \n") + "\n\n" : "";
    return `${quote}\n\n${note}[回到原文并高亮](<${textLink(p, m.anchor)}>)\n\n<!-- annotation:${m.id} -->\n`;
  }).join("\n---\n\n");
}
export function markdown(p: Page) {
  // JSON-quoted strings are valid YAML scalars, including quotes and newlines.
  const tags = p.tags?.length
    ? "tags:\n" + p.tags.map((tag) => `  - ${JSON.stringify(tag)}\n`).join("")
    : "tags: []\n";
  const header = `---\ncreated: ${p.createdAt}\nupdated: ${p.updatedAt}\ncategory: ${JSON.stringify(p.category ?? DEFAULT_CATEGORY)}\n${tags}source: ${JSON.stringify(p.url)}\n---\n\n`;
  const comment = p.comment?.trim()
    ? "## 网页评论\n\n" + p.comment.split("\n").map(md).join("  \n") + "\n\n"
    : "";
  const excerpts = p.annotations.map((m) => {
    const quote = m.text.split("\n").map((line) => "> " + md(line)).join("\n");
    const note = m.note.trim() ? m.note.split("\n").map(md).join("  \n") + "\n\n" : "";
    return `${quote}\n\n${note}[回到原文并高亮](<${textLink(p, m.anchor)}>)\n`;
  }).join("\n---\n\n");
  return header + comment + excerpts;
}
export function isGeneratedMarkdown(value: string, p: Page) {
  // A marker alone is not proof that a document has no manual edits.
  return value === markdown(p) || value === compactMarkdown(p) ||
    value === titledMarkdown(p) || value === previousMarkdown(p) ||
    value === previousMarkdown(p, true);
}
export async function parsePage(raw: string, expectedId?: string) {
  if (raw.length > 16_000_000) throw Error("JSON 文件过大");
  const p = PageSchema.parse(JSON.parse(raw));
  if (
    (p.schemaVersion === 1 && p.id !== (await pageId(p.url))) ||
    canonicalUrl(p.url) !== p.url ||
    (expectedId && p.id !== expectedId) ||
    !p.folderName.endsWith("--" + p.id)
  )
    throw Error("网页 ID、URL 或目录不匹配");
  return p;
}
