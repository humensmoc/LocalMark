import { chromium } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const out = resolve("test-results");
await mkdir(out, { recursive: true });
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "localmark-import-")), {
  channel: "chromium", headless: true, args: ["--enable-unsafe-extension-debugging"],
  ignoreDefaultArgs: ["--disable-extensions"], viewport: { width: 1440, height: 960 },
});
const checks = [], errors = [];
context.setDefaultTimeout(10000);
context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
const ok = name => { checks.push(name); console.log("PASS", name); };
const source = (id, title, createdAt = "2024-12-05T02:00:00.000Z") => ({
  schemaVersion: 2, id, url: `https://example.com/${id}`, originalUrl: `https://example.com/${id}`,
  title, favicon: "", folderName: `${title}--${id}`, markdownFile: "外国目录.md", createdAt,
  updatedAt: "2026-09-20T02:00:00.000Z", categoryId: "foreign-category", category: "导入分类",
  tagIds: ["foreign-tag"], tags: ["导入标签"], rating: 4, comment: "导入网页评论",
  annotations: [{ id: "12b942f7-841f-4f5d-bdd5-8d404706125c", text: "导入高亮", note: "导入批注", color: "green", tags: [],
    createdAt, updatedAt: "2026-09-20T02:00:00.000Z", anchor: { exact: "导入高亮", start: 0, end: 4, prefix: "", suffix: "" } }],
});
const asFile = (p, name = `${p.title}.json`) => ({ name, text: JSON.stringify(p) });
try {
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send("Extensions.loadUnpacked", { path: resolve("dist") }); await cdp.detach();
  await manager.close();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const page = await context.newPage(); await page.goto(`${origin}/dashboard.html`);
  await page.getByRole("button", { name: "导入 JSON", exact: true }).waitFor();
  const rpc = async message => {
    const reply = await page.evaluate(message => chrome.runtime.sendMessage(message), message);
    assert.equal(reply.ok, true, reply.error); return reply.data;
  };
  const drop = async (files, type = "drop") => page.evaluate(({ files, type }) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([file.text], file.name, { type: "application/json" }));
    const event = new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true });
    document.querySelector("main").dispatchEvent(event);
    return event.defaultPrevented;
  }, { files, type });
  const dialog = page.getByRole("dialog", { name: "导入结果" });
  const close = async () => { await dialog.getByRole("button", { name: "关闭", exact: true }).click(); await dialog.waitFor({ state: "hidden" }); };
  const a = source("1111111111111111", "导入文章一"), b = source("2222222222222222", "导入文章二", "2026-09-20T02:00:00.000Z");
  assert.equal(await drop([asFile(a)]), true);
  await dialog.getByText(/请先在设置中连接本地文件夹/).waitFor();
  assert.equal(Object.keys((await rpc({ type: "snapshot" })).entries).length, 0);
  await close();
  ok("file drops are intercepted and disconnected directories show guidance without importing");

  const settings = await context.newPage(); await settings.goto(`${origin}/settings.html`);
  await settings.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("Import QA", { create: true });
    const database = await new Promise((resolve, reject) => {
      const r = indexedDB.open("local-web-clipper", 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    await new Promise((resolve, reject) => {
      const tx = database.transaction("kv", "readwrite"); tx.objectStore("kv").put(root, "pendingRoot");
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    database.close();
    const result = await chrome.runtime.sendMessage({ type: "directory-connected" });
    if (!result.ok) throw Error(result.error);
  });
  await page.bringToFront();
  const files = [asFile(a), asFile(b), { name: "错误.json", text: "{" }, { name: "图片.png", text: "abc" }];
  await drop(files, "dragenter"); await page.getByText("松开以导入 JSON").waitFor();
  await page.screenshot({ path: join(out, "import-dashboard-drag.png") });
  await drop(files, "dragleave"); await page.getByText("松开以导入 JSON").waitFor({ state: "hidden" });
  await drop(files);
  await dialog.getByText("已导入 2 · 待同步 0 · 已跳过 0 · 失败 2").waitFor();
  assert.equal(page.url(), `${origin}/dashboard.html`);
  await page.screenshot({ path: join(out, "import-dashboard-result.png") });
  let lib = await rpc({ type: "snapshot" });
  assert.equal(lib.entries[a.id].page.category, a.category);
  assert.deepEqual(lib.entries[a.id].page.tags, a.tags);
  assert.deepEqual(lib.entries[a.id].page.annotations, a.annotations);
  assert.notEqual(lib.entries[a.id].page.categoryId, a.categoryId);
  assert.equal(lib.entries[a.id].page.markdownFile, undefined);
  const disk = await settings.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("Import QA");
    const entries = {};
    async function walk(dir, prefix = "") {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "directory") await walk(handle, prefix + name + "/");
        else entries[prefix + name] = await (await handle.getFile()).text();
      }
    }
    await walk(root); return entries;
  });
  assert.deepEqual(JSON.parse(disk[`data/2024-12/05/${a.title}--${a.id}.json`]), lib.entries[a.id].page);
  assert.deepEqual(JSON.parse(disk[`data/2026-09/20/${b.title}--${b.id}.json`]), lib.entries[b.id].page);
  assert.ok(disk["分类标签.json"]);
  assert.equal(Object.keys(disk).some(path => path.endsWith(".md")), false);
  await close();
  await page.getByRole("heading", { name: a.title, exact: true }).waitFor();
  ok("multiple dropped exports import into dated files; invalid files report separately and foreign catalog IDs map by name");

  await drop([asFile({ ...a, comment: "不能覆盖" }, "重复.json")]);
  await dialog.getByText("已导入 0 · 待同步 0 · 已跳过 1 · 失败 0").waitFor();
  assert.equal((await rpc({ type: "snapshot" })).entries[a.id].page.comment, a.comment);
  await close();
  await page.reload(); await page.getByRole("button", { name: "导入 JSON", exact: true }).waitFor();
  assert.equal(Object.keys((await rpc({ type: "snapshot" })).entries).length, 2);
  ok("duplicate drops preserve the stored version and imported records survive reload");

  const c = source("3333333333333333", "文件选择导入一"), d = source("4444444444444444", "文件选择导入二");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入 JSON", exact: true }).click();
  await (await chooser).setFiles([c, d].map(p => ({ name: `${p.title}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(p)) })));
  await dialog.getByText("已导入 2 · 待同步 0 · 已跳过 0 · 失败 0").waitFor();
  await close();
  const prevented = await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", "普通文字");
    const event = new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
    document.querySelector("main").dispatchEvent(event); return event.defaultPrevented;
  });
  assert.equal(prevented, false);
  ok("file chooser imports multiple JSON files and ordinary text drag/drop is left alone");

  for (const width of [900, 480, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await drop([{ name: "较长文件名".repeat(20) + ".json", text: "{}" }]);
    await dialog.getByText("已导入 0 · 待同步 0 · 已跳过 0 · 失败 1").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
    await page.screenshot({ path: join(out, `import-dashboard-${width}.png`) });
    await close();
  }
  assert.deepEqual(errors, []);
  ok("narrow import dialogs wrap long filenames without horizontal overflow or browser errors");
  await writeFile(join(out, "import-browser-report.json"), JSON.stringify({ checks, errors, browser: context.browser().version() }, null, 2));
} finally { await context.close(); }
