import { chromium } from "playwright";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "localmark-legacy-")), {
  channel: process.env.LOCALMARK_TEST_BROWSER || "chrome", headless: true,
  args: ["--enable-unsafe-extension-debugging"], ignoreDefaultArgs: ["--disable-extensions"],
});
try {
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send("Extensions.loadUnpacked", { path: resolve("dist") });
  await cdp.detach();
  await manager.close();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const id = "0123456789abcdef", url = "https://example.com/legacy";
  await worker.evaluate(async ({ id, url }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("local-web-clipper", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = new Date().toISOString();
    const page = { schemaVersion: 1, id, url, originalUrl: url, title: "旧网页", favicon: "",
      folderName: "旧网页", createdAt: now, updatedAt: now, annotations: [],
      category: "游戏设计", tags: ["设计方法论"] };
    const library = { entries: { [id]: { page, baseJson: null, baseMd: null, dirty: false, mdDirty: false } },
      lastColor: "yellow", status: "旧资料", errors: [] };
    await new Promise((resolve, reject) => {
      const tx = database.transaction("kv", "readwrite");
      tx.objectStore("kv").put(library, "library");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }, { id, url });
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${new URL(worker.url()).host}/settings.html`);
  const response = await settings.evaluate(() => chrome.runtime.sendMessage({ type: "snapshot" }));
  assert.equal(response.ok, true, response.error);
  assert.equal(response.data.migrationVersion, 1);
  assert.equal(response.data.entries[id].page.schemaVersion, 2);
  assert.equal(response.data.entries[id].page.category, "游戏设计");
  assert.deepEqual(response.data.entries[id].page.tags, ["设计方法论"]);
  const records = await settings.evaluate(async ({ id, url }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("local-web-clipper", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = database.transaction("kv");
    const store = tx.objectStore("kv");
    const read = key => new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return { legacy: await read("library"), meta: await read("library:meta"),
      entry: await read("library:entry:" + id), byUrl: await read("library:url:" + url) };
  }, { id, url });
  assert.equal(records.legacy, undefined);
  assert.equal(records.meta.migrationVersion, 1);
  assert.equal(records.entry.page.title, "旧网页");
  assert.equal(records.byUrl, id);
  console.log("PASS legacy library migrated once into durable per-page records with category and tags preserved");
} finally {
  await context.close();
}
