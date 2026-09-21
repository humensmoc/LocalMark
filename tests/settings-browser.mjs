import { chromium } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const out = resolve("test-results");
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "localmark-settings-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true,
  args: ["--enable-unsafe-extension-debugging"],
  ignoreDefaultArgs: ["--disable-extensions"],
  viewport: { width: 1280, height: 1000 },
});
const errors = [], checks = [];
context.setDefaultTimeout(10000);
context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
const ok = name => { checks.push(name); console.log("PASS", name); };
try {
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send("Extensions.loadUnpacked", { path: resolve("dist") });
  await cdp.detach();
  await manager.close();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const page = await context.newPage();
  await page.goto(`${origin}/settings.html`);
  const toggle = page.getByRole("switch", { name: "自动生成 Markdown 文档" });
  await page.waitForFunction(() => document.querySelector('#auto-generate-markdown')?.disabled === false);
  assert.equal(await toggle.isChecked(), false);
  const rpc = async message => {
    const result = await page.evaluate(message => chrome.runtime.sendMessage(message), message);
    assert.equal(result.ok, true, result.error);
    return result.data;
  };
  const settle = () => rpc({ type: "snapshot", refresh: true });
  const toggleTo = async enabled => {
    await page.waitForFunction(() => document.querySelector('#auto-generate-markdown')?.disabled === false);
    assert.notEqual(await toggle.isChecked(), enabled);
    await toggle.click();
    await page.waitForFunction(enabled => {
      const input = document.querySelector('#auto-generate-markdown');
      return input?.checked === enabled && !input.disabled;
    }, enabled);
  };
  const files = () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const result = {};
    async function walk(dir, prefix = "") {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "directory") await walk(handle, prefix + name + "/");
        else result[prefix + name] = await (await handle.getFile()).text();
      }
    }
    await walk(root);
    return result;
  });
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("local-web-clipper", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = database.transaction("kv", "readwrite");
      tx.objectStore("kv").put(root, "pendingRoot");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  });
  await rpc({ type: "directory-connected" });
  const url = "https://example.com/markdown-setting";
  const article = await context.newPage();
  await article.route(url, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>开关验证</title><p>测试高亮</p>" }));
  await article.goto(url);
  const contentRpc = async message => {
    const result = await worker.evaluate(async ({ url, message }) => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      const [response] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
        func: message => chrome.runtime.sendMessage(message), args: [message] });
      return response.result;
    }, { url, message });
    assert.equal(result.ok, true, result.error);
    return result.data;
  };
  await contentRpc({ type: "save", url, title: "开关验证", favicon: "", mark: {
    text: "测试高亮", note: "测试批注", color: "yellow",
    anchor: { exact: "测试高亮", prefix: "", suffix: "", start: 0, end: 4 },
  } });
  let lib = await settle();
  let disk = await files();
  assert.equal(lib.autoGenerateMarkdown, false);
  assert.equal(Object.keys(disk).some(name => name.endsWith(".md")), false);
  const jsonPath = Object.keys(disk).find(name => name.startsWith("data/"));
  assert.equal(JSON.parse(disk[jsonPath]).annotations[0].note, "测试批注");
  ok("default off saves real JSON and annotations without creating Markdown");

  await toggleTo(true);
  lib = await settle();
  assert.equal(lib.autoGenerateMarkdown, true);
  disk = await files();
  const mdPath = Object.keys(disk).find(name => name.endsWith(".md"));
  assert.ok(disk[mdPath].includes("测试批注"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#auto-generate-markdown')?.disabled === false);
  assert.equal(await toggle.isChecked(), true);
  ok("settings switch generates existing annotations and persists after reloading");

  await toggleTo(false);
  await settle();
  const previous = (await files())[mdPath];
  await contentRpc({ type: "page-comment", url, title: "开关验证", favicon: "", comment: "关闭期间的网页评论", expectedComment: "" });
  await settle();
  disk = await files();
  assert.equal(disk[mdPath], previous);
  assert.equal(JSON.parse(disk[jsonPath]).comment, "关闭期间的网页评论");
  const second = await context.newPage();
  await second.goto(`${origin}/settings.html`);
  await second.waitForFunction(() => document.querySelector('#auto-generate-markdown')?.disabled === false);
  assert.equal(await second.getByRole("switch", { name: "自动生成 Markdown 文档" }).isChecked(), false);
  await toggleTo(true);
  await settle();
  await second.waitForFunction(() => document.querySelector('#auto-generate-markdown')?.checked === true);
  assert.ok((await files())[mdPath].includes("关闭期间的网页评论"));
  ok("disabling preserves existing Markdown, JSON stays current, and enabling catches up across settings tabs");

  await page.evaluate(async mdPath => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle(mdPath);
    const writer = await handle.createWritable();
    await writer.write("用户手改内容");
    await writer.close();
  }, mdPath);
  lib = await settle();
  assert.equal(Object.values(lib.entries)[0].issue.kind, "markdown");
  await toggleTo(false);
  lib = await settle();
  assert.equal(Object.values(lib.entries)[0].issue, undefined);
  assert.equal((await files())[mdPath], "用户手改内容");
  await toggle.focus();
  await page.keyboard.press("Space");
  lib = await settle();
  assert.equal(lib.autoGenerateMarkdown, true);
  assert.equal(Object.values(lib.entries)[0].issue.kind, "markdown");
  assert.equal((await files())[mdPath], "用户手改内容");
  await toggleTo(false);
  await settle();
  ok("manual Markdown remains protected when toggled off and on; keyboard switching works");

  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  assert.ok((await page.locator(".version").innerText()).includes(version));
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await toggle.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await toggle.isVisible(), true);
    await page.screenshot({ path: join(out, `settings-markdown-${width}.png`) });
  }
  ok("desktop and narrow settings layouts fit with a visible switch and current version");
  assert.deepEqual(errors, []);
  await writeFile(join(out, "settings-markdown-report.json"), JSON.stringify({ browser: context.browser().version(), checks, errors, fileSystem: "isolated OPFS; no user files" }, null, 2));
} finally {
  await context.close();
}
