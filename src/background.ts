import * as db from "./db";
import {
  emptyLibrary,
  canonicalUrl,
  pageId,
  folderName,
  MarkSchema,
  PageSchema,
  PageTagsSchema,
  PageCommentSchema,
  PageCategorySchema,
  DEFAULT_CATEGORY,
  type Library,
  type Page,
} from "./model";
import { DirectoryFiles } from "./files";
import { SyncEngine } from "./sync";
import { mergeSyncResult } from "./sync-state";
import type { Request } from "./protocol";
import { migrateTaxonomy, manageTaxonomy, bulkTaxonomy, ensureTaxon, projectPage, taxonomyToken } from "./taxonomy";
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};
async function library() {
  const lib = (await db.get<Library>("library")) ?? emptyLibrary();
  const beforeMigration = JSON.stringify(lib);
  let changed = false;
  for (const e of Object.values(lib.entries)) {
    if (!Array.isArray(e.page.tags) || e.page.category === undefined) {
      e.page = PageSchema.parse(e.page);
      e.dirty = e.mdDirty = true;
      changed = true;
    }
  }
  migrateTaxonomy(lib);
  if (changed || JSON.stringify(lib) !== beforeMigration) await db.set("library", lib);
  return lib;
}
// Files are serialized separately: a slow disk must not hold the browser-save queue.
let fileQueue: Promise<unknown> = Promise.resolve();
const serialFiles = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = fileQueue.then(fn, fn);
  fileQueue = next.catch(() => {});
  return next;
};
async function sync(ids?: ReadonlySet<string>, resolution?: { pageId?: string; choice: "local" | "disk" }) {
  const before = await serial(library);
  const lib = structuredClone(before);
  const persist = () => serial(async () => {
    const latest = mergeSyncResult(await library(), before, lib);
    await db.set("library", latest);
  });
  const root = await db.get<FileSystemDirectoryHandle>("root");
  if (!root) {
    if (resolution) throw Error("请先在设置中连接并授权文件夹");
    delete lib.directoryName;
    lib.status = "尚未连接文件夹；已暂存浏览器，待同步";
    await persist();
    return;
  }
  try {
    lib.directoryName = root.name || "已授权目录";
    if ((await root.queryPermission({ mode: "readwrite" })) !== "granted") {
      if (resolution) throw Error("请先在设置中连接并授权文件夹");
      lib.status = "文件夹权限已失效；已暂存浏览器，请在设置中重新授权";
      await persist();
      return;
    }
    const engine = new SyncEngine(lib, new DirectoryFiles(root), persist);
    if (resolution) {
      if (resolution.pageId) await engine.resolve(resolution.pageId, resolution.choice);
      else await engine.resolveTaxonomy(resolution.choice);
    }
    else await engine.run(ids);
  } catch (e) {
    if (resolution) throw e;
    lib.status =
      "无法同步本地文件：" + (e instanceof Error ? e.message : String(e));
    await persist();
  }
}
async function notify() {
  // Extension pages do not receive tabs.sendMessage (only content scripts do).
  void chrome.runtime.sendMessage({ type: "changed" }).catch(() => {});
  for (const tab of await chrome.tabs.query({}))
    if (tab.id)
      chrome.tabs.sendMessage(tab.id, { type: "changed" }).catch(() => {});
}
const pendingPages = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushQueued = false;
function scheduleSync(id = "") {
  pendingPages.add(id);
  if (flushTimer || flushQueued) return;
  // Combine a short burst into one writer job. Durable dirty flags survive worker exit.
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushQueued = true;
    void serialFiles(async () => {
      const ids = new Set([...pendingPages].filter(Boolean));
      pendingPages.clear();
      try {
        await sync(ids);
        await notify();
      } finally {
        flushQueued = false;
        const next = pendingPages.values().next().value;
        if (pendingPages.size) scheduleSync(next);
      }
    }).catch(() => {});
  }, 75);
}
function isLibraryUI(sender: chrome.runtime.MessageSender) {
  return ["dashboard.html", "sidepanel.html"].some(path => sender.url === chrome.runtime.getURL(path));
}
async function handle(m: Request, sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id) throw Error("来源不受信任");
  if (m.type === "dashboard") {
    const url = chrome.runtime.getURL("dashboard.html");
    const { dashboardWindowId } = await chrome.storage.session.get("dashboardWindowId");
    if (typeof dashboardWindowId === "number") {
      try {
        await chrome.windows.update(dashboardWindowId, { focused: true });
        return library();
      } catch { /* The previous window was closed. */ }
    }
    const opened = await chrome.windows.create({ url, type: "popup", width: 1440, height: 920 });
    await chrome.storage.session.set({ dashboardWindowId: opened.id });
    return library();
  }
  if (m.type === "settings") {
    await chrome.runtime.openOptionsPage();
    return library();
  }
  if (m.type === "open") {
    const u = new URL(m.url);
    if (!["http:", "https:"].includes(u.protocol)) throw Error("不支持此链接");
    await chrome.tabs.create({ url: u.href });
    return library();
  }
  const lib = await library();
  if (m.type === "snapshot") return lib;
  if (m.type === "taxonomy" || m.type === "bulk-taxonomy") {
    if (sender.url !== chrome.runtime.getURL("dashboard.html")) throw Error("请在仪表盘管理分类和标签。");
    const next = structuredClone(lib);
    const changed = m.type === "taxonomy"
      ? manageTaxonomy(next, m.action, m.expected)
      : bulkTaxonomy(next, m.selected, m.action, m.expected);
    next.status = `已修改 ${changed.length} 篇网页；已暂存浏览器，等待文件同步`;
    await db.set("library", next);
    for (const id of changed) scheduleSync(id);
    scheduleSync();
    void notify().catch(() => {});
    return next;
  }
  if (m.type === "directory-connected") {
    if (!sender.url?.startsWith(chrome.runtime.getURL("")))
      throw Error("只能从插件设置连接目录");
    const next = await db.get<FileSystemDirectoryHandle>("pendingRoot"),
      old = await db.get<FileSystemDirectoryHandle>("root");
    if (!next) throw Error("请重新选择文件夹");
    if (old && !(await next.isSameEntry(old))) {
      delete lib.taxonomyBase;
      delete lib.taxonomyIssue;
      lib.taxonomyDirty = true;
      for (const e of Object.values(lib.entries)) {
        e.baseJson = null;
        e.baseMd = null;
        e.dirty = true;
        e.mdDirty = true;
        delete e.issue;
      }
      await db.set("library", lib);
    }
    await db.set("root", next);
    return lib;
  }
  let changedId: string;
  if (m.type === "save" || m.type === "page-tag" || m.type === "page-comment" || m.type === "page-category" || m.type === "page-title") {
    const dashboard = sender.url === chrome.runtime.getURL("dashboard.html");
    const url = canonicalUrl(m.url);
    if (!/^https?:\/\//.test(url)) throw Error("仅支持 HTTP/HTTPS 网页");
    if (!dashboard && sender.tab?.url && canonicalUrl(sender.tab.url) !== url)
      throw Error("网页已切换，请重新选择文字");
    const id = Object.values(lib.entries).find(e => e.page.url === url)?.page.id ?? await pageId(url),
      now = new Date().toISOString();
    changedId = id;
    let e = lib.entries[id];
    if ((dashboard && !e) || (isLibraryUI(sender) && e?.issue))
      throw Error(e?.issue?.message ?? "该网页已不存在，请刷新列表。");
    if (m.type === "page-title") {
      if ((e?.page.title ?? null) !== m.expectedTitle)
        throw Error("标题已在其他标签页或文件中修改，当前输入尚未保存。请复制输入后取消编辑，核对最新标题。");
      if (typeof m.title !== "string" || !m.title.trim() || m.title.trim().length > 1000)
        throw Error("标题不能为空，且不能超过 1000 个字符。");
    }
    if (!e) {
      const title = ((m.type === "page-title" ? m.title.trim() : m.title) || new URL(url).hostname).slice(0, 1000);
      const p: Page = {
        schemaVersion: 1,
        id,
        url,
        originalUrl: m.url,
        title,
        favicon: /^https?:\/\//.test(m.favicon) ? m.favicon : "",
        folderName: folderName(title, id),
        createdAt: now,
        updatedAt: now,
        annotations: [],
        tags: [],
        category: DEFAULT_CATEGORY,
      };
      e = lib.entries[id] = {
        page: p,
        baseJson: null,
        baseMd: null,
        dirty: true,
        mdDirty: true,
      };
    }
    migrateTaxonomy(lib);
    if (m.type === "page-title") {
      e.page.title = m.title.trim();
      e.page.updatedAt = now;
      e.dirty = e.mdDirty = true;
    } else if (m.type === "page-category") {
      if (lib.taxonomyIssue) throw Error(lib.taxonomyIssue);
      if (m.expectedTaxonomy && m.expectedTaxonomy !== taxonomyToken(lib)) throw Error("分类已改变，请刷新后重试。");
      if (e.page.category !== m.expectedCategory)
        throw Error("主分类已在其他标签页或文件中修改，请刷新后重新选择。");
      const name = PageCategorySchema.parse(m.category);
      const category = m.categoryId ? lib.taxonomy!.categories.find(x => x.id === m.categoryId) : ensureTaxon(lib, "categories", name);
      if (!category) throw Error("主分类已不存在。");
      e.page.categoryId = category.id;
      projectPage(lib, e.page);
      e.page.updatedAt = now;
      e.dirty = e.mdDirty = true;
    } else if (m.type === "page-comment") {
      if ((e.page.comment ?? "") !== m.expectedComment)
        throw Error("网页评论已在其他标签页或文件中修改，当前输入尚未保存。请复制当前输入后，点击“读取最新评论”核对。");
      e.page.comment = PageCommentSchema.parse(m.comment);
      e.page.updatedAt = now;
      e.dirty = e.mdDirty = true;
    } else if (m.type === "page-tag") {
      if (lib.taxonomyIssue) throw Error(lib.taxonomyIssue);
      if (m.expectedTaxonomy && m.expectedTaxonomy !== taxonomyToken(lib)) throw Error("标签已改变，请刷新后重试。");
      const [tag] = PageTagsSchema.parse([m.tag]);
      const target = m.tagId ? lib.taxonomy!.tags.find(x => x.id === m.tagId)
        : m.action === "add" ? ensureTaxon(lib, "tags", tag) : lib.taxonomy!.tags.find(x => x.name === tag);
      if (!target) throw Error("标签已不存在。");
      e.page.tagIds = m.action === "add" ? [...new Set([...e.page.tagIds!, target.id])] : e.page.tagIds!.filter(id => id !== target.id);
      if (e.page.tagIds.length > 500) throw Error("每篇网页最多允许 500 个标签。");
      projectPage(lib, e.page);
      e.page.updatedAt = now;
      e.dirty = e.mdDirty = true;
    } else {
      const old = m.mark.id
        ? e.page.annotations.find((a) => a.id === m.mark.id)
        : undefined;
      if (
        m.mark.id &&
        (!old ||
          old.updatedAt !== m.mark.expectedUpdatedAt ||
          JSON.stringify(old) !== m.mark.expectedMark)
      )
        throw Error(
          "此标注已在其他标签页或文件中修改，请刷新后再编辑。当前输入尚未保存。",
        );
      const time =
        old && now <= old.updatedAt
          ? new Date(Date.parse(old.updatedAt) + 1).toISOString()
          : now;
      const mark = MarkSchema.parse({
        ...m.mark,
        id: old?.id ?? crypto.randomUUID(),
        createdAt: old?.createdAt ?? time,
        updatedAt: time,
        tags: old?.tags ?? [],
      });
      if (old) e.page.annotations[e.page.annotations.indexOf(old)] = mark;
      else e.page.annotations.push(mark);
      e.page.updatedAt = time;
      e.dirty = true;
      e.mdDirty = true;
      lib.lastColor = mark.color;
    }
  } else if (m.type === "delete") {
    if (isLibraryUI(sender)) {
      if (lib.entries[m.pageId]?.issue) throw Error(lib.entries[m.pageId].issue!.message);
    }
    changedId = m.pageId;
    const e = lib.entries[m.pageId],
      old = e?.page.annotations.find((a) => a.id === m.id);
    if (
      !e ||
      !old ||
      old.updatedAt !== m.expectedUpdatedAt ||
      JSON.stringify(old) !== m.expectedMark
    )
      throw Error("标注已改变，请刷新后重试");
    e.page.annotations = e.page.annotations.filter((a) => a.id !== m.id);
    e.page.updatedAt = new Date().toISOString();
    e.dirty = true;
    e.mdDirty = true;
  } else throw Error("未知操作");
  lib.status = "已暂存浏览器，正在写入文件";
  await db.set("library", lib);
  scheduleSync(changedId);
  void notify().catch(() => {});
  return lib;
}
async function dispatch(m: Request, sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id) throw Error("来源不受信任");
  if (["taxonomy", "bulk-taxonomy", "resolve-taxonomy"].includes(m.type) && sender.url !== chrome.runtime.getURL("dashboard.html"))
    throw Error("请在仪表盘管理分类和标签。");
  if (m.type === "taxonomy" || m.type === "bulk-taxonomy") {
    return serialFiles(async () => {
      await sync();
      return serial(() => handle(m, sender));
    });
  }
  if (m.type === "directory-connected" || m.type === "resolve" ||
      m.type === "resolve-taxonomy" ||
      (m.type === "snapshot" && m.refresh)) {
    return serialFiles(async () => {
      if (m.type === "directory-connected") await serial(() => handle(m, sender));
      await sync(undefined, m.type === "resolve" || m.type === "resolve-taxonomy" ? m : undefined);
      await notify();
      return serial(library);
    });
  }
  // Keep dashboard compare-before-edit behavior for fields with expected versions.
  // Tags are set operations and can be saved immediately; the writer checks disk conflicts.
  if (isLibraryUI(sender) &&
      ["save", "delete", "page-comment", "page-category", "page-title"].includes(m.type)) {
    const id = m.type === "delete" ? m.pageId : "url" in m ? await pageId(canonicalUrl(m.url)) : "";
    return serialFiles(async () => {
      await sync(new Set([id]));
      return serial(() => handle(m, sender));
    });
  }
  return serial(() => handle(m, sender));
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (["changed", "page-updated"].includes(message?.type)) return false;
  // Opening settings must not wait behind a slow or stalled filesystem operation.
  const task =
    message?.type === "settings"
      ? handle(message, sender)
      : dispatch(message, sender);
  task.then(
    (data) => reply({ ok: true, data }),
    (e) =>
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});
// Chrome owns action/shortcut toggling, including focus and the native close button.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
// Recreate the retry alarm on worker startup too; alarms are not guaranteed across restarts.
void chrome.alarms.create("retry-sync", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "retry-sync")
    void serialFiles(async () => {
      const lib = await serial(library);
      const ids = new Set(Object.entries(lib.entries)
        .filter(([, e]) => e.dirty || e.mdDirty || e.issue?.kind === "io")
        .map(([id]) => id));
      if (ids.size || lib.taxonomyDirty || lib.taxonomyIssue) {
        await sync(ids);
        await notify();
      }
    }).catch(() => {});
});
