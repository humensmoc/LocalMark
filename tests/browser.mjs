import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const out = resolve("test-results");
await mkdir(out, { recursive: true });
const fixture = await readFile("tests/fixture.html", "utf8");
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(fixture);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "web-clipper-chrome-"));
await mkdir(join(profile, "Default"), { recursive: true });
await writeFile(
  join(profile, "Default", "Preferences"),
  JSON.stringify({ extensions: { ui: { developer_mode: true } } }),
);
const extensionPath = resolve("dist");
const launchOptions = {
  channel: "chromium",
  headless: true,
  args: ["--enable-unsafe-extension-debugging"],
  ignoreDefaultArgs: ["--disable-extensions"],
  viewport: { width: 1360, height: 960 },
};
let context = await chromium.launchPersistentContext(profile, launchOptions);
async function installExtension() {
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() =>
    chrome.developerPrivate.updateProfileConfiguration({
      inDeveloperMode: true,
    }),
  );
  await manager.close();
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send("Extensions.loadUnpacked", { path: extensionPath });
  await cdp.detach();
}
await installExtension();
const errors = [],
  checks = [];
const ok = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
async function inspectUI(page) {
  await page.locator("#local-web-clipper-root").waitFor();
  assert.equal(
    await page.evaluate(
      () => document.getElementById("local-web-clipper-root").shadowRoot,
    ),
    null,
    "production UI must use closed Shadow DOM",
  );
  // Inspector-only access for tests. Production code exposes no test hook or open shadow root.
  const cdp = await context.newCDPSession(page);
  const worlds = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) =>
    worlds.push(context),
  );
  await cdp.send("Runtime.enable");
  const { root } = await cdp.send("DOM.getDocument", {
    depth: -1,
    pierce: true,
  });
  function find(n) {
    if (n.attributes?.includes("local-web-clipper-root")) return n;
    for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
      const hit = find(c);
      if (hit) return hit;
    }
  }
  const node = find(root);
  for (const executionContextId of [
    undefined,
    worlds.find((c) => c.name.includes("playwright"))?.id,
  ]) {
    const { object } = await cdp.send("DOM.resolveNode", {
      backendNodeId: node.shadowRoots[0].backendNodeId,
      executionContextId,
    });
    await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration:
        'function(){const root=this;Object.defineProperty(this.host,"shadowRoot",{get:()=>root,configurable:true});}',
    });
  }
  await cdp.detach();
}
context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extId = new URL(worker.url()).host;
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extId}/settings.html`);
  await settings.getByRole("heading", { name: "连接你的本地文件夹" }).waitFor();
  ok("settings page loads in real extension context");
  const rpc = (m) => settings.evaluate((m) => chrome.runtime.sendMessage(m), m);
  const state = async () => {
    const response = await rpc({ type: "snapshot" });
    assert.equal(response.ok, true);
    return response.data;
  };
  async function eventually(fn, label) {
    let last;
    for (let i = 0; i < 60; i++) {
      try {
        const result = await fn();
        if (result) return result;
      } catch (e) {
        last = e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error(label + (last ? ": " + last.message : ""));
  }
  const page = await context.newPage();
  await page.goto(base + "/article");
  await inspectUI(page);
  const host = page.locator("#local-web-clipper-root");
  await page.keyboard.press("Control+b");
  await host.getByLabel("本地摘录侧栏").waitFor();
  await host.getByLabel("搜索摘录").focus();
  await page.keyboard.press("Control+b");
  assert.equal(await host.getByLabel("本地摘录侧栏").count(), 1);
  await host.getByLabel("搜索摘录").blur();
  await page.keyboard.press("Control+b");
  await host.getByLabel("本地摘录侧栏").waitFor({ state: "hidden" });
  await page.getByLabel("网页输入框").focus();
  await page.keyboard.press("Control+b");
  assert.equal(await host.getByLabel("本地摘录侧栏").count(), 0);
  await page.getByLabel("网页输入框").blur();
  ok(
    "Ctrl+B toggles sidebar while preserving page and extension input behavior",
  );
  async function select(selector, start, end, rebind = false) {
    const pointer = await page.evaluate(
      ({ selector, start, end }) => {
        const el = document.querySelector(selector);
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) nodes.push(n);
        let total = 0,
          s,
          e;
        for (const node of nodes) {
          if (!s && start < total + node.length)
            s = { node, offset: start - total };
          if (end <= total + node.length) {
            e = { node, offset: end - total };
            break;
          }
          total += node.length;
        }
        const range = document.createRange();
        range.setStart(s.node, s.offset);
        range.setEnd(e.node, e.offset);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const endRange = range.cloneRange();
        endRange.collapse(false);
        const bounds = endRange.getBoundingClientRect();
        const pointer = { x: bounds.x, y: bounds.bottom - 2 };
        el.dispatchEvent(
          new MouseEvent("mouseup", {
            bubbles: true,
            button: 0,
            clientX: pointer.x,
            clientY: pointer.y,
          }),
        );
        return pointer;
      },
      { selector, start, end },
    );
    await host
      .getByRole("button", { name: rebind ? "确认保存" : "高亮选中文字" })
      .waitFor();
    if (!rebind) {
      const quick = host.locator(".quick");
      const bounds = await quick.boundingBox();
      const viewport = page.viewportSize();
      assert.ok(
        Math.abs(
          bounds.x -
            Math.max(
              12,
              Math.min(
                Math.trunc(pointer.x) + 8,
                viewport.width - bounds.width - 12,
              ),
            ),
        ) < 1,
      );
      assert.ok(
        Math.abs(
          bounds.y -
            Math.max(
              12,
              Math.min(
                Math.trunc(pointer.y) + 8,
                viewport.height - bounds.height - 12,
              ),
            ),
        ) < 1,
      );
      assert.equal((await quick.textContent()).trim(), "");
      assert.ok(bounds.width <= 34 && bounds.height <= 34);
    }
  }
  await select("#first", 27, 49);
  await page.screenshot({ path: join(out, "quick-highlight.png") });
  await host.getByRole("button", { name: "高亮选中文字" }).click();
  await eventually(
    async () =>
      Object.values((await state()).entries)[0]?.page.annotations.length === 1,
    "quick highlight saved",
  );
  ok("quick highlight saves selected text");
  await select("#second", 0, 14);
  await host.getByRole("button", { name: "高亮选中文字" }).hover();
  await host.getByLabel("批注", { exact: true }).waitFor();
  await page.setViewportSize({ width: 400, height: 300 });
  await host.getByLabel("批注", { exact: true }).evaluate((el) => {
    el.style.height = "180px";
  });
  await eventually(async () => {
    const box = await host.locator(".editor").boundingBox();
    return (
      box.x >= 12 &&
      box.y >= 12 &&
      box.x + box.width <= 388 &&
      box.y + box.height <= 288
    );
  }, "editor respects all viewport margins after resize");
  await page.screenshot({ path: join(out, "editor-narrow.png") });
  await page.setViewportSize({ width: 1360, height: 960 });
  ok(
    "editor measures actual size, stays 12px inside all edges and scrolls in a short window",
  );
  await host.getByLabel("蓝色", { exact: true }).click();
  await host
    .getByLabel("批注", { exact: true })
    .fill("这是中文批注\n下一次阅读时再看。");
  assert.equal(await host.locator("#wc-tags").count(), 0);
  await host.getByRole("button", { name: "确认保存" }).click();
  await eventually(
    async () =>
      Object.values((await state()).entries)[0]?.page.annotations.length === 2,
    "note saved",
  );
  let lib = await state();
  let entry = Object.values(lib.entries)[0];
  assert.equal(entry.page.annotations[1].color, "blue");
  assert.deepEqual(entry.page.tags, []);
  ok("hover editor saves color and multiline note without annotation tags");
  await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url: url + "/*" });
    await chrome.tabs.sendMessage(tabs[0].id, { type: "toggle" });
  }, base);
  await host.getByLabel("本地摘录侧栏").waitFor();
  await host.getByRole("button", { name: "目录与同步设置" }).click();
  await eventually(
    async () =>
      settings.evaluate(async () => (await chrome.tabs.getCurrent())?.active),
    "sidebar settings opens the options tab",
  );
  await settings.getByRole("heading", { name: "连接你的本地文件夹" }).waitFor();
  await page.bringToFront();
  await host.getByRole("button", { name: "目录与同步设置" }).click();
  await eventually(
    async () =>
      settings.evaluate(async () => (await chrome.tabs.getCurrent())?.active),
    "directory setup action opens settings",
  );
  await page.bringToFront();
  ok("single sidebar settings button opens options for directory setup");
  await host.getByRole("button", { name: "添加网页标签" }).click();
  const tagInput = host.getByLabel("搜索或新建网页标签");
  await tagInput.fill("设计");
  await tagInput.press("Enter");
  await eventually(
    async () =>
      Object.values((await state()).entries)[0].page.tags.includes("设计"),
    "page tag saved",
  );
  await tagInput.fill("阅读");
  await host.getByRole("button", { name: "新建“阅读”", exact: false }).click();
  await eventually(
    async () =>
      Object.values((await state()).entries)[0].page.tags.length === 2,
    "second page tag saved",
  );
  await tagInput.fill("设计");
  assert.equal(await host.locator(".tag-options button").count(), 1);
  await host.getByRole("button", { name: "添加网页标签" }).click();
  assert.equal(await host.locator(".card .tag").count(), 0);
  ok(
    "page tags add with plus button, search existing tags and belong to the page",
  );
  await host.getByRole("button", { name: "标签", exact: true }).click();
  await host
    .getByRole("button", { name: "设计", exact: false })
    .first()
    .click();
  await host.locator(".result-annotations summary").click();
  await host.getByText("这是中文批注", { exact: false }).waitFor();
  ok("toolbar message opens left sidebar and tags filter notes");
  await host.getByRole("button", { name: "当前页面", exact: true }).click();
  assert.equal(
    await host
      .locator(".note")
      .first()
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(226, 232, 240)",
  );
  await page.screenshot({ path: join(out, "sidebar.png") });
  await page.reload();
  await inspectUI(page);
  await eventually(
    async () =>
      host
        .locator(".rail button")
        .count()
        .then((n) => n === 2),
    "restore highlights",
  );
  ok("reload restores highlights and navigation rail");
  await page.locator("#second").hover({ position: { x: 80, y: 14 } });
  await host.locator(".tooltip").waitFor();
  assert.match(await host.locator(".tooltip").innerText(), /这是中文批注/);
  await page.screenshot({ path: join(out, "hover-note.png") });
  ok("hover on original text displays annotation");
  await host.locator(".rail button").nth(1).hover();
  await host.locator(".tooltip .hover-quote").waitFor();
  assert.match(await host.locator(".tooltip").innerText(), /同一篇文章/);
  assert.match(await host.locator(".tooltip").innerText(), /这是中文批注/);
  await page.screenshot({ path: join(out, "rail-preview.png") });
  await host.locator(".tooltip").hover();
  assert.equal(await host.locator(".tooltip").count(), 1);
  await page.mouse.move(1200, 900);
  ok(
    "rail hover displays excerpt and note and permits moving into the preview",
  );
  await page.getByLabel("网页输入框").selectText();
  await page.getByLabel("网页输入框").dispatchEvent("mouseup", { button: 0 });
  assert.equal(
    await host.getByRole("button", { name: "高亮选中文字" }).count(),
    0,
  );
  await page.getByLabel("网页输入框").blur();
  await page.evaluate(() => getSelection().removeAllRanges());
  ok("editable fields do not trigger clipping");
  // OPFS is a real FileSystemDirectoryHandle. This exercises FSA + worker + IndexedDB,
  // but does not claim to automate the native Windows directory picker.
  const opfs = await settings.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    return {
      name: root.name,
      permission: await root.queryPermission({ mode: "readwrite" }),
    };
  });
  assert.equal(opfs.permission, "granted");
  await settings.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("local-web-clipper", 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(root, "pendingRoot");
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  });
  const connected = await rpc({ type: "directory-connected" });
  assert.equal(connected.ok, true);
  assert.equal(connected.data.status, "已保存到本地文件");
  ok("real browser File System Access handle writes from service worker");
  const files = await settings.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const result = {};
    for await (const [name, h] of root.entries())
      if (h.kind === "file") result[name] = await (await h.getFile()).text();
      else if (h.kind === "directory") {
        for await (const [file, f] of h.entries())
          if (f.kind === "file")
            result[name + "/" + file] = await (await f.getFile()).text();
      }
    return result;
  });
  assert.equal(Object.keys(files).length, 2);
  assert.match(
    Object.values(files).find((v) => v.startsWith("---\n")),
    /这是中文批注/,
  );
  ok("one Markdown and one JSON generated");
  // Simulate revoked permission at the API boundary; never imply a native dialog was automated.
  await worker.evaluate(() => {
    globalThis.originalQueryPermission =
      FileSystemHandle.prototype.queryPermission;
    FileSystemHandle.prototype.queryPermission = async () => "prompt";
  });
  const beforeDenied = Object.values((await state()).entries)[0];
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: url + "/*" });
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" });
  }, base);
  await host.getByRole("button", { name: "编辑", exact: true }).first().click();
  await host.getByLabel("批注", { exact: true }).fill("授权恢复后写入");
  await host.getByRole("button", { name: "确认保存" }).click();
  await eventually(
    async () =>
      Object.values((await state()).entries)[0].page.annotations[0].note ===
      "授权恢复后写入",
    "denied permission retains edit",
  );
  const pendingSave = await state();
  assert.match(pendingSave.status, /权限已失效/);
  assert.equal(Object.values(pendingSave.entries)[0].dirty, true);
  await host.getByRole("button", { name: "目录与同步设置" }).click();
  await eventually(
    () =>
      settings.evaluate(async () => (await chrome.tabs.getCurrent())?.active),
    "reauthorization action opens settings",
  );
  await settings.reload();
  await settings
    .getByRole("button", { name: "重新授权", exact: true })
    .waitFor();
  await worker.evaluate(() => {
    FileSystemHandle.prototype.queryPermission =
      globalThis.originalQueryPermission;
    delete globalThis.originalQueryPermission;
  });
  await settings.getByRole("button", { name: "重新授权", exact: true }).click();
  await eventually(
    async () => (await state()).status === "已保存到本地文件",
    "permission recovery flushes queued save",
  );
  const recovered = await settings.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("原始数据");
    return JSON.parse(
      await (await (await dir.getFileHandle(id + ".json")).getFile()).text(),
    );
  }, beforeDenied.page.id);
  assert.equal(recovered.annotations[0].note, "授权恢复后写入");
  assert.equal(Object.values((await state()).entries)[0].dirty, false);
  await page.bringToFront();
  await host.getByLabel("收起侧栏").click();
  ok(
    "permission loss retains pending edits; settings reauthorization flushes them to files (simulated permission)",
  );
  async function diskEdit(fn) {
    return settings.evaluate(
      async ({ id, source }) => {
        const root = await navigator.storage.getDirectory(),
          dir = await root.getDirectoryHandle("原始数据"),
          f = await dir.getFileHandle(id + ".json");
        const obj = JSON.parse(await (await f.getFile()).text());
        if (source === "external-note")
          obj.annotations[0].note = "从 JSON 读回的新批注";
        if (source === "rebind-case")
          obj.annotations[0].anchor.exact = obj.annotations[0].text =
            "missing original";
        const w = await f.createWritable();
        await w.write(JSON.stringify(obj));
        await w.close();
      },
      { id: entry.page.id, source: fn },
    );
  }
  await diskEdit("external-note");
  await rpc({ type: "snapshot", refresh: true });
  lib = await state();
  assert.equal(
    Object.values(lib.entries)[0].page.annotations[0].note,
    "从 JSON 读回的新批注",
  );
  ok("external JSON edits read back into extension");
  await settings.evaluate(async () => {
    const db = await new Promise((r) => {
      const q = indexedDB.open("local-web-clipper", 1);
      q.onsuccess = () => r(q.result);
    });
    await new Promise((r) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").delete("library");
      tx.oncomplete = r;
    });
    db.close();
  });
  await rpc({ type: "snapshot", refresh: true });
  assert.equal(
    Object.values((await state()).entries)[0].page.annotations.length,
    2,
  );
  ok("empty browser cache rebuilt from directory JSON");
  const page2 = await context.newPage();
  await page2.goto(base + "/article");
  await inspectUI(page2);
  // Competing edits carry revision stamps; exactly one succeeds, without lost updates.
  // UI edits in both tabs hold the original revision until saved.
  await worker.evaluate(async (url) => {
    for (const t of await chrome.tabs.query({ url: url + "/*" }))
      await chrome.tabs.sendMessage(t.id, { type: "toggle" });
  }, base);
  const h2 = page2.locator("#local-web-clipper-root");
  await h2.getByRole("button", { name: "编辑", exact: true }).first().click();
  await host.getByRole("button", { name: "编辑", exact: true }).first().click();
  await host.getByLabel("批注", { exact: true }).fill("标签页一修改");
  await host.getByRole("button", { name: "确认保存" }).click();
  await eventually(
    async () =>
      Object.values((await state()).entries)[0].page.annotations[0].note ===
      "标签页一修改",
    "first tab update",
  );
  await h2.getByLabel("批注", { exact: true }).fill("标签页二旧版本");
  await h2.getByRole("button", { name: "确认保存" }).click();
  await h2
    .getByText("此标注已在其他标签页或文件中修改", { exact: false })
    .waitFor();
  assert.equal(
    Object.values((await state()).entries)[0].page.annotations[0].note,
    "标签页一修改",
  );
  ok("two-tab stale update rejected without discarding editor input");
  await h2.getByRole("button", { name: "关闭编辑窗" }).click();
  await page2.close();
  await host.getByLabel("收起侧栏").click();
  await select("#second", 15, 28);
  await host.getByRole("button", { name: "高亮选中文字" }).hover();
  await host.getByLabel("批注", { exact: true }).fill("输入法未提交");
  await host.getByLabel("批注", { exact: true }).dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  assert.equal(await host.getByLabel("批注", { exact: true }).count(), 1);
  await host.getByLabel("批注", { exact: true }).press("Enter");
  await eventually(
    async () =>
      Object.values((await state()).entries)[0].page.annotations.length === 3,
    "Enter saves",
  );
  ok("IME Enter retained; ordinary Enter saves");
  await page.setViewportSize({ width: 500, height: 780 });
  await worker.evaluate(async (url) => {
    const ts = await chrome.tabs.query({ url: url + "/*" });
    await chrome.tabs.sendMessage(ts[0].id, { type: "toggle" });
  }, base);
  await host.getByLabel("本地摘录侧栏").waitFor();
  const panel = await host.locator(".panel").boundingBox();
  assert.ok(panel.width <= 464);
  await page.screenshot({ path: join(out, "narrow.png") });
  ok("narrow-window sidebar fits viewport");
  await page.setViewportSize({ width: 1360, height: 960 });
  await page.evaluate(() => document.body.classList.add("dark"));
  await page.screenshot({ path: join(out, "dark.png") });
  await diskEdit("rebind-case");
  await rpc({ type: "snapshot", refresh: true });
  await host.getByRole("button", { name: "未定位 · 重新绑定" }).waitFor();
  await host.getByRole("button", { name: "未定位 · 重新绑定" }).click();
  await select("#first", 27, 49, true);
  await host.getByRole("button", { name: "确认保存" }).click();
  await eventually(
    async () =>
      host
        .getByRole("button", { name: "未定位 · 重新绑定" })
        .count()
        .then((n) => n === 0),
    "rebound",
  );
  assert.equal(
    Object.values((await state()).entries)[0].page.annotations.length,
    3,
  );
  ok("unresolved annotation rebinds without losing note or duplicating ID");
  await host.getByLabel("收起侧栏").click();
  await select("#first", 27, 40);
  await host.getByRole("button", { name: "高亮选中文字" }).click();
  await eventually(
    async () =>
      Object.values((await state()).entries)[0].page.annotations.length === 4,
    "overlap saved",
  );
  await page.locator("#first b").click({ position: { x: 20, y: 10 } });
  await host.locator(".overlaps").waitFor();
  assert.match(await host.locator(".overlaps").innerText(), /2 条重叠标注/);
  await page.keyboard.press("Escape");
  ok("overlapping highlights offer explicit selection");
  await page.evaluate(() =>
    history.pushState({}, "", location.pathname + "#/different"),
  );
  await eventually(
    async () =>
      host
        .locator(".rail button")
        .count()
        .then((n) => n === 0),
    "SPA route cleared",
  );
  await page.evaluate(() => history.pushState({}, "", location.pathname));
  await eventually(
    async () =>
      host
        .locator(".rail button")
        .count()
        .then((n) => n === 4),
    "SPA route restored",
  );
  ok("SPA route changes switch annotation identity");
  await page.evaluate(
    () =>
      (document.querySelector("#first b").textContent = "temporarily missing"),
  );
  await eventually(
    async () =>
      host
        .locator(".rail button")
        .count()
        .then((n) => n === 2),
    "DOM removal detected",
  );
  await page.evaluate(
    () =>
      (document.querySelector("#first b").textContent =
        "Highlight this passage"),
  );
  await eventually(
    async () =>
      host
        .locator(".rail button")
        .count()
        .then((n) => n === 4),
    "DOM reappearance restored",
  );
  ok("dynamic text changes restore only matching ranges");
  const commentPage = await context.newPage();
  await commentPage.goto(base + "/comment-only");
  await inspectUI(commentPage);
  const commentHost = commentPage.locator("#local-web-clipper-root");
  await commentPage.keyboard.press("Control+b");
  const commentInput = commentHost.getByLabel("网页评论", { exact: true });
  const commentText = "这篇网页值得回顾\n独立评论 <script> **纯文本**";
  await commentInput.fill(commentText);
  await commentHost.getByLabel("收起侧栏").click();
  await commentPage.keyboard.press("Control+b");
  assert.equal(await commentInput.inputValue(), commentText);
  await commentHost.getByRole("button", { name: "最近网页", exact: true }).click();
  await commentHost.getByRole("button", { name: "当前页面", exact: true }).click();
  assert.equal(await commentInput.inputValue(), commentText);
  await commentHost.getByRole("button", { name: "保存评论", exact: true }).click();
  const commentEntry = await eventually(async () => Object.values((await state()).entries).find(e => e.page.url === commentPage.url() && e.page.comment === commentText), "standalone comment saves without a highlight or tag");
  assert.equal(commentEntry.page.annotations.length, 0);
  assert.deepEqual(commentEntry.page.tags, []);
  assert.equal(await commentHost.locator(".rail button").count(), 0);
  assert.equal(await commentPage.locator("body").innerText().then(t => t.includes(commentText)), false);
  await commentHost.getByLabel("添加网页标签").click();
  await commentHost.getByLabel("搜索或新建网页标签").fill("网页收藏");
  await commentHost.getByLabel("搜索或新建网页标签").press("Enter");
  await eventually(async () => (await state()).entries[commentEntry.page.id].page.tags.includes("网页收藏"), "tag added to comment-only page");
  await commentHost.getByLabel("添加网页标签").click();
  const commentExport = await settings.evaluate(async id => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("原始数据");
    const json = JSON.parse(await (await (await dir.getFileHandle(id + ".json")).getFile()).text());
    const md = await (await (await root.getFileHandle(json.markdownFile)).getFile()).text();
    return { json, md };
  }, commentEntry.page.id);
  assert.equal(commentExport.json.comment, commentText);
  assert.match(commentExport.md, /## 网页评论/);
  assert.ok(commentExport.md.startsWith("---\n"));
  assert.equal(commentExport.md.includes("<!--"), false);
  assert.equal(commentExport.md.includes("\n# "), false);
  assert.equal(commentExport.md.includes("回到原文并高亮"), false);
  ok("standalone page comment and existing tags persist to JSON and Markdown without page highlights");
  await commentHost.getByLabel("选择主分类", { exact: true }).click();
  await commentHost.getByRole("radio", { name: "游戏营销 0", exact: true }).click();
  await eventually(async () => (await state()).entries[commentEntry.page.id].page.category === "游戏营销", "single category saves");
  await commentHost.getByLabel("选择主分类", { exact: true }).click();
  assert.equal(await commentHost.getByRole("radio", { checked: true }).count(), 1);
  await commentPage.screenshot({ path: join(out, "page-category-picker.png") });
  await commentHost.getByLabel("搜索或新建主分类").fill("独立创作");
  await commentHost.getByLabel("搜索或新建主分类").press("Enter");
  await eventually(async () => (await state()).entries[commentEntry.page.id].page.category === "独立创作", "custom category replaces previous category");
  const categorized = (await state()).entries[commentEntry.page.id].page;
  assert.deepEqual(categorized.tags, ["网页收藏"]);
  assert.equal(categorized.comment, commentText);
  await commentHost.getByRole("button", { name: "查看同类网页", exact: true }).click();
  await commentHost.getByRole("button", { name: "独立创作 1", exact: true, pressed: true }).waitFor();
  assert.equal(await commentHost.locator(".tag-page-title").count(), 1);
  await commentHost.getByRole("button", { name: "当前页面", exact: true }).click();
  const categoryFile = await settings.evaluate(async id => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("原始数据");
    const json = JSON.parse(await (await (await dir.getFileHandle(id + ".json")).getFile()).text());
    return { json, md: await (await (await root.getFileHandle(json.markdownFile)).getFile()).text() };
  }, commentEntry.page.id);
  assert.equal(categoryFile.json.category, "独立创作");
  assert.match(categoryFile.md, /category: "独立创作"/);
  assert.match(categoryFile.md, /tags:\n  - "网页收藏"/);
  assert.match(categoryFile.md, /source: "http/);
  ok("category is single-select, searchable and creatable; small tags remain separate in JSON and Obsidian properties");
  await commentHost.getByRole("button", { name: "最近网页", exact: true }).click();
  await commentHost.getByLabel("搜索摘录").fill("这篇网页值得回顾");
  assert.equal(await commentHost.locator("article.card").count(), 1);
  await commentHost.getByLabel("搜索摘录").fill("");
  await commentHost.getByRole("button", { name: "当前页面", exact: true }).click();
  await commentInput.fill("当前输入保留");
  const secondCommentPage = await context.newPage();
  await secondCommentPage.goto(commentPage.url());
  await inspectUI(secondCommentPage);
  await secondCommentPage.keyboard.press("Control+b");
  await secondCommentPage.getByLabel("网页评论", { exact: true }).fill("另一个标签页修改");
  await secondCommentPage.getByRole("button", { name: "保存评论", exact: true }).click();
  await eventually(async () => (await state()).entries[commentEntry.page.id].page.comment === "另一个标签页修改", "other tab updates page comment");
  await secondCommentPage.close();
  await commentHost.getByRole("button", { name: "保存评论", exact: true }).click();
  await commentHost.getByRole("alert").filter({ hasText: "网页评论已在其他" }).waitFor();
  assert.equal(await commentInput.inputValue(), "当前输入保留");
  assert.equal((await state()).entries[commentEntry.page.id].page.comment, "另一个标签页修改");
  await commentHost.getByRole("button", { name: "读取最新评论" }).click();
  await eventually(async () => await commentInput.inputValue() === "另一个标签页修改", "load newest comment after conflict");
  await commentInput.fill("");
  await commentHost.getByRole("button", { name: "保存评论", exact: true }).click();
  await eventually(async () => (await state()).entries[commentEntry.page.id].page.comment === "", "clear saved comment");
  assert.equal((await state()).entries[commentEntry.page.id].page.tags[0], "网页收藏");
  await commentInput.fill(commentText);
  await commentInput.press("Control+Enter");
  await eventually(async () => (await state()).entries[commentEntry.page.id].page.comment === commentText, "keyboard saves multiline comment");
  await commentPage.reload();
  await inspectUI(commentPage);
  await commentPage.keyboard.press("Control+b");
  await eventually(async () => await commentInput.inputValue() === commentText, "reload restores standalone comment");
  assert.equal(await commentHost.getByLabel("选择主分类", { exact: true }).innerText(), "独立创作");
  await commentPage.screenshot({ path: join(out, "page-comment.png") });
  await commentPage.setViewportSize({ width: 390, height: 620 });
  const commentBounds = await commentInput.boundingBox();
  assert.ok(commentBounds.x >= 0 && commentBounds.x + commentBounds.width <= 390);
  assert.equal(await commentHost.locator(".panel").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await commentPage.screenshot({ path: join(out, "page-comment-narrow.png") });
  ok("page comments preserve drafts, search, reject stale edits, clear, reload and fit narrow windows");
  const recoveryPage = await context.newPage();
  await recoveryPage.goto(base + "/reload-check");
  await inspectUI(recoveryPage);
  let toolbarPage = settings;
  async function toolbarFor(url) {
    await toolbarPage.evaluate(async (url) => {
      const { handleToolbarClick } = await import(
        chrome.runtime.getURL("toolbar.js")
      );
      const [tab] = await chrome.tabs.query({ url });
      await handleToolbarClick(tab);
    }, url);
  }
  await toolbarFor(recoveryPage.url());
  await recoveryPage.getByLabel("本地摘录侧栏").waitFor();
  await toolbarFor(recoveryPage.url());
  await recoveryPage.getByLabel("本地摘录侧栏").waitFor({ state: "hidden" });
  ok("actual toolbar callback toggles the sidebar without opening settings");
  // Real extension reload invalidates its old content-script context without reloading the website.
  const nextWorker = context.waitForEvent("serviceworker").catch(() => null);
  const settingsClosed = settings.waitForEvent("close");
  await settings.evaluate(() => {
    setTimeout(() => chrome.runtime.reload(), 0);
  });
  await settingsClosed;
  toolbarPage = await context.newPage();
  await eventually(async () => {
    await toolbarPage.goto(`chrome-extension://${extId}/settings.html`);
    return true;
  }, "extension finishes reloading");
  worker = await nextWorker;
  assert.ok(worker, "extension service worker restarts");
  await recoveryPage.waitForFunction(
    () => !document.getElementById("local-web-clipper-root"),
  );
  // Reproduce the orphaned DOM left by the previous release as well.
  await recoveryPage.evaluate(() => {
    const stale = document.createElement("div");
    stale.id = "local-web-clipper-root";
    stale.dataset.stale = "true";
    document.documentElement.append(stale);
  });
  await toolbarFor(recoveryPage.url());
  await inspectUI(recoveryPage);
  const recoveryHost = recoveryPage.locator("#local-web-clipper-root");
  await recoveryHost.getByLabel("本地摘录侧栏").waitFor();
  assert.equal(await recoveryHost.getAttribute("data-stale"), null);
  assert.equal(await recoveryHost.count(), 1);
  await recoveryHost.getByLabel("收起侧栏").click();
  const rect = await recoveryPage.locator("#first b").boundingBox();
  await recoveryPage.mouse.move(rect.x + 1, rect.y + rect.height / 2);
  await recoveryPage.mouse.down();
  await recoveryPage.mouse.move(
    rect.x + rect.width - 1,
    rect.y + rect.height / 2,
    { steps: 10 },
  );
  await recoveryPage.mouse.up();
  await recoveryHost.getByRole("button", { name: "高亮选中文字" }).click();
  await eventually(
    async () => (await recoveryHost.locator(".rail button").count()) === 1,
    "real mouse quick highlight after extension reload",
  );
  await toolbarFor(recoveryPage.url());
  await recoveryHost
    .getByText("Highlight this passage", { exact: true })
    .waitFor();
  await recoveryPage.screenshot({ path: join(out, "reload-recovery.png") });
  ok(
    "extension reload plus stale DOM recovers sidebar and saves a real mouse selection without refreshing the website",
  );
  const version = context.browser().version();
  await context.close();
  context = await chromium.launchPersistentContext(profile, launchOptions);
  await installExtension();
  const restored = await context.newPage();
  await restored.goto(base + "/article");
  await inspectUI(restored);
  await eventually(
    async () =>
      restored
        .locator("#local-web-clipper-root .rail button")
        .count()
        .then((n) => n === 4),
    "browser restart persistence",
  );
  ok("browser restart preserves cached annotations and restores highlights");
  await restored.goto(base + "/comment-only");
  await inspectUI(restored);
  await restored.keyboard.press("Control+b");
  await eventually(async () => await restored.getByLabel("网页评论", { exact: true }).inputValue() === commentText, "browser restart preserves page comment");
  assert.equal(await restored.locator("#local-web-clipper-root .rail button").count(), 0);
  ok("browser restart restores page comment without rendering highlights");
  assert.equal(await restored.getByLabel("选择主分类", { exact: true }).innerText(), "独立创作");
  assert.deepEqual(errors, []);
  ok("no page JavaScript errors");
  await writeFile(
    join(out, "browser-report.json"),
    JSON.stringify(
      {
        browser: version,
        checks,
        nativeDirectoryPicker:
          "Not automated: OPFS handle used for browser FSA integration",
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks: checks.length, output: out }, null, 2));
} catch (error) {
  console.error("BROWSER TEST FAILURE", error.message, "page errors:", errors);
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  console.error(
    "EXTENSIONS",
    await manager.evaluate(() => {
      function text(root) {
        return Array.from(root.querySelectorAll("*"))
          .map((el) =>
            el.shadowRoot
              ? text(el.shadowRoot)
              : el.children.length
                ? ""
                : el.textContent,
          )
          .join(" ");
      }
      return text(document);
    }),
  );
  for (const [i, p] of context.pages().entries()) {
    await p.screenshot({ path: join(out, `failure-${i}.png`) }).catch(() => {});
    console.error(
      "PAGE",
      i,
      await p.title(),
      await p.locator("#local-web-clipper-root").count(),
      await p.locator("#local-web-clipper-root .editor").count(),
    );
  }
  throw error;
} finally {
  await context.close();
  server.close();
}
