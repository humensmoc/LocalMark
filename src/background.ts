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
import type { Request } from "./protocol";
import { handleToolbarClick } from "./toolbar";
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};
async function library() {
  const lib = (await db.get<Library>("library")) ?? emptyLibrary();
  let changed = false;
  for (const e of Object.values(lib.entries)) {
    if (!Array.isArray(e.page.tags) || e.page.category === undefined) {
      e.page = PageSchema.parse(e.page);
      e.dirty = e.mdDirty = true;
      changed = true;
    }
  }
  if (changed) await db.set("library", lib);
  return lib;
}
async function sync(lib: Library) {
  const root = await db.get<FileSystemDirectoryHandle>("root");
  if (!root) {
    delete lib.directoryName;
    lib.status = "尚未连接文件夹；已暂存浏览器，待同步";
    await db.set("library", lib);
    return;
  }
  try {
    lib.directoryName = root.name || "已授权目录";
    if ((await root.queryPermission({ mode: "readwrite" })) !== "granted") {
      lib.status = "文件夹权限已失效；已暂存浏览器，请在设置中重新授权";
      await db.set("library", lib);
      return;
    }
    await new SyncEngine(lib, new DirectoryFiles(root), () =>
      db.set("library", lib),
    ).run();
  } catch (e) {
    lib.status =
      "无法同步本地文件：" + (e instanceof Error ? e.message : String(e));
    await db.set("library", lib);
  }
}
async function notify() {
  // Extension pages do not receive tabs.sendMessage (only content scripts do).
  void chrome.runtime.sendMessage({ type: "changed" }).catch(() => {});
  for (const tab of await chrome.tabs.query({}))
    if (tab.id)
      chrome.tabs.sendMessage(tab.id, { type: "changed" }).catch(() => {});
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
  if (m.type === "snapshot") {
    if (m.refresh) {
      await sync(lib);
      await notify();
    }
    return lib;
  }
  if (m.type === "directory-connected") {
    if (!sender.url?.startsWith(chrome.runtime.getURL("")))
      throw Error("只能从插件设置连接目录");
    const next = await db.get<FileSystemDirectoryHandle>("pendingRoot"),
      old = await db.get<FileSystemDirectoryHandle>("root");
    if (!next) throw Error("请重新选择文件夹");
    if (old && !(await next.isSameEntry(old))) {
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
    await sync(lib);
    await notify();
    return lib;
  }
  if (m.type === "resolve") {
    const root = await db.get<FileSystemDirectoryHandle>("root");
    if (
      !root ||
      (await root.queryPermission({ mode: "readwrite" })) !== "granted"
    )
      throw Error("请先在设置中连接并授权文件夹");
    await new SyncEngine(lib, new DirectoryFiles(root), () =>
      db.set("library", lib),
    ).resolve(m.pageId, m.choice);
    await notify();
    return lib;
  }
  if (m.type === "save" || m.type === "page-tag" || m.type === "page-comment" || m.type === "page-category") {
    const dashboard = sender.url === chrome.runtime.getURL("dashboard.html");
    if (dashboard) await sync(lib);
    const url = canonicalUrl(m.url);
    if (!/^https?:\/\//.test(url)) throw Error("仅支持 HTTP/HTTPS 网页");
    if (!dashboard && sender.tab?.url && canonicalUrl(sender.tab.url) !== url)
      throw Error("网页已切换，请重新选择文字");
    const id = await pageId(url),
      now = new Date().toISOString();
    let e = lib.entries[id];
    if (dashboard && (!e || e.issue))
      throw Error(e?.issue?.message ?? "该网页已不存在，请刷新列表。");
    if (!e) {
      const title = (m.title || new URL(url).hostname).slice(0, 1000);
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
    if (m.type === "page-category") {
      if (e.page.category !== m.expectedCategory)
        throw Error("主分类已在其他标签页或文件中修改，请刷新后重新选择。");
      e.page.category = PageCategorySchema.parse(m.category);
      e.page.updatedAt = now;
      e.dirty = e.mdDirty = true;
    } else if (m.type === "page-comment") {
      if ((e.page.comment ?? "") !== m.expectedComment)
        throw Error("网页评论已在其他标签页或文件中修改，当前输入尚未保存。请复制当前输入后，点击“读取最新评论”核对。");
      e.page.comment = PageCommentSchema.parse(m.comment);
      e.page.updatedAt = now;
      e.dirty = e.mdDirty = true;
    } else if (m.type === "page-tag") {
      const [tag] = PageTagsSchema.parse([m.tag]);
      e.page.tags = PageTagsSchema.parse(
        m.action === "add"
          ? [...new Set([...e.page.tags, tag])]
          : e.page.tags.filter((t) => t !== tag),
      );
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
    if (sender.url === chrome.runtime.getURL("dashboard.html")) {
      await sync(lib);
      if (lib.entries[m.pageId]?.issue) throw Error(lib.entries[m.pageId].issue!.message);
    }
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
  await sync(lib);
  await notify();
  return lib;
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === "changed") return false;
  // Opening settings must not wait behind a slow or stalled filesystem operation.
  const task =
    message?.type === "settings"
      ? handle(message, sender)
      : serial(() => handle(message, sender));
  task.then(
    (data) => reply({ ok: true, data }),
    (e) =>
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});
chrome.action.onClicked.addListener(handleToolbarClick);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("retry-sync", { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "retry-sync")
    void serial(async () => {
      const lib = await library();
      if (
        Object.values(lib.entries).some(
          (e) => e.dirty || e.mdDirty || e.issue?.kind === "io",
        )
      ) {
        await sync(lib);
        await notify();
      }
    });
});
