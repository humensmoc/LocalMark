import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { elementChecks } from "./element-browser-checks.mjs";
import { hoverTrackingChecks } from "./hover-browser-checks.mjs";
const out = resolve("test-results");
await mkdir(out, { recursive: true });
const fixture = await readFile("tests/fixture.html", "utf8");
const elementFixture = await readFile("tests/elements-fixture.html", "utf8");
const server = createServer((req, res) => {
  if (req.url === "/site-icon.svg") {
    res.setHeader("Content-Type", "image/svg+xml");
    res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#6656ef"/><path d="M32 10 49 42 32 54 15 42Z" fill="#b7eaff"/></svg>');
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url?.startsWith("/elements")) { res.end(elementFixture); return; }
  res.end(
    fixture.replace("阅读测试 · 本地摘录", "LocalMark Native QA " + req.url).replace("</head>", '<link rel="icon" href="/site-icon.svg"></head>'),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "localmark-sidepanel-"));
// An explicit executable uses the Chrome 128-compatible startup flags and APIs.
// It always gets a fresh profile, never the user's normal browser profile.
const executablePath = process.env.LOCALMARK_CHROME_EXECUTABLE;
const extensionPath = resolve("dist");
const context = await chromium.launchPersistentContext(profile, {
  ...(executablePath ? { executablePath } : { channel: "chromium" }),
  headless: !executablePath && process.env.LOCALMARK_INTERACTIVE_QA !== "1",
  viewport: null,
  args: ["--window-size=1400,1000", ...(executablePath
    ? [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
        ...(process.env.LOCALMARK_INTERACTIVE_QA === "1" ? [] : ["--headless=new"])]
    : ["--enable-unsafe-extension-debugging"])],
  ignoreDefaultArgs: ["--disable-extensions"],
});
const checks = [],
  errors = [];
context.setDefaultTimeout(10000);
context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
const ok = (s) => {
  checks.push(s);
  console.log("PASS", s);
};
async function until(fn, label) {
  let last;
  for (let i = 0; i < 80; i++) {
    try {
      if (await fn()) return;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(label + ": " + (last?.message ?? "timed out"));
}
let panel;
try {
  // Open before installing: Ctrl+B/action must work without any preloaded script.
  const page = await context.newPage();
  await page.goto(base + "/first");
  const cdp = await context.browser().newBrowserCDPSession();
  if (!executablePath) {
    const manager = await context.newPage();
    await manager.goto("chrome://extensions");
    await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
    await cdp.send("Extensions.loadUnpacked", { path: extensionPath });
    await manager.close();
  }
  await page.bringToFront();
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const extId = new URL(worker.url()).host;
  const downloadDir = join(out, "metadata-downloads");
  await mkdir(downloadDir, { recursive: true });
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloadDir, eventsEnabled: true });
  async function downloadCurrentMetadata(expected) {
    let started, complete;
    const begin = event => { started = event; };
    const progress = event => { if (event.state === "completed") complete = event; };
    cdp.on("Browser.downloadWillBegin", begin);
    cdp.on("Browser.downloadProgress", progress);
    try {
      await panel.click(".metadata-download");
      await until(() => started && complete?.guid === started.guid, "JSON browser download");
      assert.ok(started.suggestedFilename.endsWith(`--${expected.id}.json`));
      assert.deepEqual(JSON.parse(await readFile(join(downloadDir, started.guid), "utf8")), expected);
    } finally {
      cdp.off("Browser.downloadWillBegin", begin);
      cdp.off("Browser.downloadProgress", progress);
    }
  }
  let controller;
  if (executablePath) {
    // Simulate a tab lacking a live content script, without modern loadUnpacked.
    await page.locator("#local-web-clipper-root").waitFor();
    await worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(t => t.url === url);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__localWebClipperDispose?.() });
    }, page.url());
    controller = await context.newPage();
    await controller.goto(`chrome-extension://${extId}/settings.html`);
    await page.bringToFront();
  }
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  const rpc = (m) => panel.evaluate((m) => chrome.runtime.sendMessage(m), m); // snapshots only; mutations are exercised in their real UIs.
  const state = async () => {
    const r = await rpc({ type: "snapshot" });
    assert.equal(r.ok, true);
    return r.data;
  };
  const entry = async (path) =>
    Object.values((await state()).entries).find(
      (e) => e.page.url === base + path,
    );
  assert.equal(
    (await worker.evaluate(() => chrome.commands.getAll())).find(
      (c) => c.name === "_execute_action",
    )?.shortcut,
    "Ctrl+B",
  );
  await until(
    async () =>
      (await worker.evaluate(() => chrome.sidePanel.getPanelBehavior()))
        .openPanelOnActionClick,
    "native action behavior",
  );
  ok("Ctrl+B is registered as the browser action; Chrome owns native toggling");
  const toggle = async (p) => {
    if (executablePath) {
      // Chrome 128 predates CDP Extensions.triggerAction. Exercise actual native
      // open + side-panel document close, and check shortcut registration separately.
      const open = (await cdp.send("Target.getTargets")).targetInfos.some(t => t.url === `chrome-extension://${extId}/sidepanel.html`);
      if (open) {
        const closing = await attachPanel();
        await closing.evaluate(() => { setTimeout(() => window.close(), 100); });
        await closing.detach();
      } else {
        await controller.evaluate(async url => {
          const tab = (await chrome.tabs.query({})).find(t => t.url === url);
          await chrome.sidePanel.open({ windowId: tab.windowId });
        }, p.url());
      }
      return;
    }
    const { targetInfos } = await cdp.send("Target.getTargets", {
      filter: [{ type: "tab" }],
    });
    const tab = targetInfos.find((t) => t.url === p.url());
    assert.ok(tab);
    await cdp.send("Extensions.triggerAction", {
      id: extId,
      targetId: tab.targetId,
    });
  };
  async function attachPanel() {
    let target;
    await until(async () => {
      target = (await cdp.send("Target.getTargets")).targetInfos.find(
        (t) => t.url === `chrome-extension://${extId}/sidepanel.html`,
      );
      return target;
    }, "native sidepanel target");
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    });
    let next = 0;
    const pending = new Map();
    const listener = (event) => {
      if (event.sessionId !== sessionId) return;
      const m = JSON.parse(event.message);
      if (m.method === "Runtime.exceptionThrown")
        errors.push(JSON.stringify(m.params.exceptionDetails));
      const task = pending.get(m.id);
      if (task) {
        pending.delete(m.id);
        clearTimeout(task.timer);
        m.error ? task.reject(Error(m.error.message)) : task.resolve(m.result);
      }
    };
    cdp.on("Target.receivedMessageFromTarget", listener);
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("CDP timeout " + method));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        void cdp
          .send("Target.sendMessageToTarget", {
            sessionId,
            message: JSON.stringify({ id, method, params }),
          })
          .catch(reject);
      });
    await send("Runtime.enable");
    const evaluate = async (fn, arg) => {
      const r = await send("Runtime.evaluate", {
        expression: `(${fn.toString()})(${JSON.stringify(arg) ?? ""})`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (r.exceptionDetails)
        throw Error(
          r.exceptionDetails.text +
            ": " +
            r.exceptionDetails.exception?.description,
        );
      return r.result.value;
    };
    const click = async (selector) =>
      evaluate((s) => {
        const e = document.querySelector(s);
        if (!e) throw Error("missing " + s);
        if (e.disabled) throw Error("disabled " + s);
        e.click();
      }, selector);
    const textClick = async (text) =>
      evaluate((t) => {
        const e = [...document.querySelectorAll("button")].find(
          (e) => e.textContent.trim() === t,
        );
        if (!e) throw Error("missing button " + t);
        if (e.disabled) throw Error("disabled " + t);
        e.click();
      }, text);
    const fill = async (selector, value) =>
      evaluate(
        ({ selector, value }) => {
          const e = document.querySelector(selector);
          if (!e) throw Error("missing " + selector);
          e.focus();
          Object.getOwnPropertyDescriptor(
            e.tagName === "TEXTAREA"
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype,
            "value",
          ).set.call(e, value);
          e.dispatchEvent(new Event("input", { bubbles: true }));
        },
        { selector, value },
      );
    const screenshot = async (name) => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(join(out, name), Buffer.from(r.data, "base64"));
    };
    await until(
      () => evaluate(() => !!document.querySelector(".panel")),
      "panel mounted",
    );
    return {
      evaluate,
      click,
      textClick,
      fill,
      screenshot,
      send,
      detach: async () => {
        cdp.off("Target.receivedMessageFromTarget", listener);
        await cdp
          .send("Target.detachFromTarget", { sessionId })
          .catch(() => {});
      },
    };
  }
  const before = await page.evaluate(() => innerWidth);
  assert.equal(await page.locator("#local-web-clipper-root").count(), 0);
  await toggle(page);
  panel = await attachPanel();
  await until(
    () =>
      panel.evaluate(
        (v) =>
          document
            .querySelector(".footer-version")
            ?.textContent === "版本 " + v,
        version,
      ),
    "bridge version",
  );
  await until(
    async () => (await page.evaluate(() => innerWidth)) < before - 250,
    "native viewport resized",
  );
  const during = await page.evaluate(() => innerWidth);
  assert.ok(during < before - 250, `${before} -> ${during}`);
  assert.equal(
    await page.evaluate(
      () => document.querySelector("#local-web-clipper-root")?.shadowRoot,
    ),
    null,
  );
  ok(
    `native panel shrinks the real page viewport ${before} -> ${during}; tab without a live page bridge is bootstrapped`,
  );
  assert.equal(
    await panel.evaluate(
      () => document.querySelector(".page-title-row h3")?.textContent,
    ),
    "LocalMark Native QA /first",
  );
  await panel.screenshot("native-sidepanel.png");
  assert.equal(await panel.evaluate(() => document.querySelector(".metadata-open")?.disabled), true);
  assert.match(await panel.evaluate(() => document.querySelector(".page-metadata-location").textContent), /保存评分、标签或评论/);
  await until(() => panel.evaluate(() => [...document.querySelectorAll(".page-head .site-icon img, .page-head .site-backdrop img")].length === 2 && [...document.querySelectorAll(".page-head img")].every(img => img.complete && img.naturalWidth > 0)), "current page icon and backdrop loaded");
  ok("current page shows its site icon and frosted backdrop");
  await page.screenshot({ path: join(out, "native-page-resized.png") });
  const ratingColors = new Set();
  for (let rating = 1; rating <= 5; rating++) {
    await panel.click(`.rating-stars button[aria-label="${rating} 星"]`);
    await until(async () => (await entry("/first"))?.page.rating === rating, "rating saved");
    await until(() => panel.evaluate(() => !document.querySelector(".rating-stars button").disabled), "rating idle");
    await panel.textClick("最近网页");
    await until(() => panel.evaluate(n => document.querySelectorAll(".webpage-card .rating-dots .filled").length === n, rating), "recent rating");
    ratingColors.add(await panel.evaluate(() => getComputedStyle(document.querySelector(".rating-dots")).color));
    assert.equal(await panel.evaluate(() => document.querySelectorAll(".webpage-card .rating-dots i").length), 5);
    const geometry = await panel.evaluate(() => {
      const card = document.querySelector(".webpage-card");
      const height = card.getBoundingClientRect().height;
      const dots = card.querySelector(".rating-dots");
      dots.style.display = "none";
      const without = card.getBoundingClientRect().height;
      dots.style.display = "";
      return { height, without, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(geometry.height, geometry.without);
    assert.equal(geometry.overflow, false);
    if (rating === 5) await panel.screenshot("rating-recent.png");
    await panel.textClick("标签");
    await until(() => panel.evaluate(n => document.querySelectorAll(".result-card .rating-dots .filled").length === n, rating), "tag rating");
    if (rating === 5) await panel.screenshot("rating-tags.png");
    await panel.textClick("当前页面");
  }
  assert.equal(ratingColors.size, 5);
  await panel.screenshot("rating-current.png");
  await until(() => panel.evaluate(() => document.querySelector(".page-metadata-location").textContent.includes("连接本地文件夹")), "metadata folder guidance");
  assert.equal(await panel.evaluate(() => document.querySelector(".metadata-open").disabled), true);
  ok("metadata location stays visible with useful guidance for unsaved pages and disconnected folders");
  await downloadCurrentMetadata((await entry("/first")).page);
  ok("browser downloads the current JSON before any local directory is connected");
  await panel.click(".rating-clear");
  await until(async () => (await entry("/first"))?.page.rating === undefined, "rating cleared");
  ok("current page independently saves and clears 1–5 stars; recent/tag cards show five dots with distinct colors and unchanged recent card height");
  await panel.click('[aria-label="添加网页标签"]');
  await panel.fill('[aria-label="搜索或新建网页标签"]', "原生侧栏测试");
  await panel.click(".create-tag");
  await until(
    async () => (await entry("/first"))?.page.tags.includes("原生侧栏测试"),
    "tag save",
  );
  await panel.fill("#wc-page-comment", "保存的网页评论");
  await panel.textClick("保存评论");
  await until(
    async () => (await entry("/first"))?.page.comment === "保存的网页评论",
    "comment save",
  );
  await panel.click('[aria-label="编辑标题"]');
  await panel.fill("#wc-page-title", "原生侧栏标题");
  await panel.textClick("保存标题");
  await until(
    async () => (await entry("/first"))?.page.title === "原生侧栏标题",
    "title save",
  );
  ok("native panel saves page tags, comments and title to the correct web URL");
  await panel.fill("#wc-page-comment", "关闭后仍在的评论草稿");
  await panel.click('[aria-label="编辑标题"]');
  await panel.fill("#wc-page-title", "关闭后仍在的标题草稿");
  await until(
    () =>
      panel.evaluate(async () =>
        Object.values(await chrome.storage.session.get(null)).some(
          (v) =>
            v?.comments &&
            Object.values(v.comments).some(
              (d) => d.value === "关闭后仍在的评论草稿",
            ),
        ),
      ),
    "draft storage",
  );
  await panel.detach();
  await toggle(page);
  await until(
    async () => (await page.evaluate(() => innerWidth)) === before,
    "page restored after close",
  );
  await toggle(page);
  panel = await attachPanel();
  await until(
    () =>
      panel.evaluate(
        () =>
          document.querySelector("#wc-page-comment")?.value ===
            "关闭后仍在的评论草稿" &&
          document.querySelector("#wc-page-title")?.value ===
            "关闭后仍在的标题草稿",
      ),
    "drafts restored",
  );
  ok(
    "native panel closes/reopens without page clicks; title/comment drafts survive destruction",
  );
  await panel.click(".page-title-editor button:not(.primary)");
  const second = await context.newPage();
  await second.goto(base + "/second");
  await second.bringToFront();
  await until(
    () =>
      panel.evaluate(
        () =>
          document.querySelector(".page-title-row h3")?.textContent ===
          "LocalMark Native QA /second",
      ),
    "active tab follows",
  );
  assert.equal(
    await panel.evaluate(
      () => document.querySelector("#wc-page-comment")?.value,
    ),
    "",
  );
  await page.bringToFront();
  await until(
    () =>
      panel.evaluate(
        () =>
          document.querySelector("#wc-page-comment")?.value ===
          "关闭后仍在的评论草稿",
      ),
    "draft belongs to first tab",
  );
  await page.evaluate(() => {
    history.pushState({}, "", "/spa");
    document.title = "SPA 页面";
  });
  await until(
    () =>
      panel.evaluate(
        () =>
          document.querySelector(".page-title-row h3")?.textContent ===
          "SPA 页面",
      ),
    "SPA follows",
  );
  await panel.fill("#wc-page-comment", "SPA 评论");
  await panel.textClick("保存评论");
  await until(
    async () => (await entry("/spa"))?.page.comment === "SPA 评论",
    "SPA writes correct URL",
  );
  ok(
    "tab changes and SPA navigation update the current page and isolate drafts",
  );
  // Inspector-only access to the page overlay for floating highlighter tests.
  const pageCDP = await context.newCDPSession(page);
  const worlds = [];
  pageCDP.on("Runtime.executionContextCreated", ({ context }) =>
    worlds.push(context),
  );
  await pageCDP.send("Runtime.enable");
  const { root } = await pageCDP.send("DOM.getDocument", {
    depth: -1,
    pierce: true,
  });
  function find(n) {
    if (n.attributes?.includes("local-web-clipper-root")) return n;
    for (const child of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
      const hit = find(child);
      if (hit) return hit;
    }
  }
  const hostNode = find(root);
  for (const executionContextId of [
    undefined,
    worlds.find((c) => c.name.includes("playwright"))?.id,
  ]) {
    const { object } = await pageCDP.send("DOM.resolveNode", {
      backendNodeId: hostNode.shadowRoots[0].backendNodeId,
      executionContextId,
    });
    await pageCDP.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration:
        'function(){const root=this;Object.defineProperty(this.host,"shadowRoot",{get:()=>root,configurable:true});}',
    });
  }
  const host = page.locator("#local-web-clipper-root");
  assert.equal(await host.locator(".panel").count(), 0);
  const editor = host.locator(".editor");
  const note = host.locator("#wc-note");
  const quick = editor.locator(".swatch").first();
  async function dragEditor(dx, dy) {
    const handle = await editor.locator(".composer-grip").boundingBox();
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 12 });
    await page.mouse.up();
  }
  const finishMotion = locator => locator.evaluate(async el => {
    const animation = el.getAnimations()[0];
    animation.play();
    await animation.finished;
  });
  async function inspectMidpoint(locator) {
    const frame = await locator.evaluate(el => {
      const animation = el.getAnimations()[0];
      animation.pause();
      animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
      return { opacity: Number(getComputedStyle(el).opacity), translate: getComputedStyle(el).translate, tooltip: el.classList.contains("tooltip") };
    });
    assert.ok(frame.opacity > 0 && frame.opacity < 1, "popup renders an intermediate opacity");
    if (!frame.tooltip) assert.notEqual(frame.translate, "0px", "editor also moves slightly");
  }
  // Pause only after production logic has started closing, so exit presence and
  // hit testing can be checked deterministically without racing a 180 ms fade.
  const pauseExit = locator => locator.evaluate(el => {
    const observer = new MutationObserver(() => {
      if (el.dataset.state !== "closing") return;
      const animation = el.getAnimations()[0];
      animation.pause();
      animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
      observer.disconnect();
    });
    observer.observe(el, { attributes: true, attributeFilter: ["data-state"] });
  });
  await page.locator("#first b").scrollIntoViewIfNeeded();
  const selectionBox = await page.locator("#first b").boundingBox();
  await page.mouse.move(
    selectionBox.x + 0.5,
    selectionBox.y + selectionBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    selectionBox.x + selectionBox.width - 0.5,
    selectionBox.y + selectionBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  assert.equal(
    await note.evaluate(el => el.getRootNode().activeElement === el),
    true,
  );
  await finishMotion(editor);
  const compactBefore = await editor.boundingBox();
  assert.equal(await editor.locator(".swatch").count(), 3);
  assert.equal(await host.locator(".quick").count(), 0);
  const scrollBeforeFocus = await page.evaluate(() => scrollY);
  await note.click();
  await note.waitFor();
  assert.equal(await note.evaluate(el => el.getRootNode().activeElement === el), true);
  assert.equal(await page.evaluate(() => scrollY), scrollBeforeFocus);
  await page.keyboard.insertText("悬停后直接输入的批注");
  assert.equal(await note.inputValue(), "悬停后直接输入的批注");
  await inspectMidpoint(editor);
  await page.screenshot({ path: join(out, "floating-editor-midpoint.png") });
  await finishMotion(editor);
  assert.ok((await editor.boundingBox()).width >= compactBefore.width);
  const editorBounds = await editor.boundingBox();
  assert.ok(editorBounds.y >= 12);
  await page.screenshot({ path: join(out, "floating-editor-focused.png") });
  await dragEditor(-240, -110);
  const draggedBounds = await editor.boundingBox();
  assert.ok(Math.abs(draggedBounds.x - (editorBounds.x - 240)) < 1);
  assert.ok(Math.abs(draggedBounds.y - (editorBounds.y - 110)) < 1);
  assert.equal(await note.evaluate(el => el.getRootNode().activeElement === el), true, "dragging preserves the input focus");
  assert.equal(await page.evaluate(() => scrollY), scrollBeforeFocus);
  await page.keyboard.insertText("。");
  await page.keyboard.press("Backspace");
  assert.equal(await note.inputValue(), "悬停后直接输入的批注");
  assert.deepEqual(await editor.boundingBox(), draggedBounds, "typing does not reset the dragged position");
  assert.equal(await editor.locator(".swatch").count(), 3);
  await page.screenshot({ path: join(out, "floating-editor-dragged.png") });
  ok("dragging the title bar moves the editor outside its starting bounds while preserving focus, text and the color row");
  await pauseExit(editor);
  await quick.click();
  await until(
    async () => (await entry("/spa"))?.page.annotations.length === 1,
    "highlight persisted",
  );
  await until(
    () =>
      panel.evaluate(
        () =>
          document.querySelector(".card.current .quote")?.textContent ===
          "Highlight this passage",
      ),
    "live highlight in panel",
  );
  assert.equal(await host.locator(".quick").count(), 0);
  assert.equal((await entry("/spa")).page.annotations[0].note, "悬停后直接输入的批注");
  await until(() => editor.getAttribute("data-state").then(s => s === "closing"), "editor exit starts");
  assert.equal(await editor.evaluate(el => el.inert && getComputedStyle(el).pointerEvents === "none"), true);
  await finishMotion(editor);
  await editor.waitFor({ state: "detached" });
  ok("the composer focuses the note without scrolling; typing, color save and animated exit work");

  // Both original text and the margin rail expose the same animated preview.
  await page.locator("#first b").hover();
  const tooltip = host.locator(".tooltip");
  await tooltip.waitFor();
  assert.equal(await tooltip.innerText(), "悬停后直接输入的批注", "text preview contains only its comment");
  assert.equal(await tooltip.locator(".hover-note").evaluate(el => getComputedStyle(el).borderTopWidth), "0px");
  await inspectMidpoint(tooltip);
  await page.screenshot({ path: join(out, "floating-tooltip-midpoint.png") });
  await finishMotion(tooltip);
  await page.screenshot({ path: join(out, "text-comment-hover.png") });
  await tooltip.hover();
  const retainedTooltip = await tooltip.elementHandle();
  await pauseExit(tooltip);
  await page.mouse.move(20, 950);
  await until(() => tooltip.getAttribute("data-state").then(s => s === "closing"), "tooltip exit starts");
  assert.equal(await tooltip.evaluate(el => el.inert && getComputedStyle(el).pointerEvents === "none"), true);
  await inspectMidpoint(tooltip);
  await page.screenshot({ path: join(out, "floating-tooltip-exit.png") });
  await host.locator(".rail button").hover();
  await until(() => tooltip.getAttribute("data-state").then(s => s === "open"), "hover reverses pending exit");
  assert.equal(await retainedTooltip.evaluate(el => el.isConnected && el === el.getRootNode().querySelector(".tooltip")), true);
  await finishMotion(tooltip);
  await tooltip.hover();
  await page.mouse.move(20, 950);
  await tooltip.waitFor({ state: "detached" });
  ok("text and rail previews fade in/out, disable interaction during exit and reuse the popup when an exit is reversed");
  await hoverTrackingChecks({ page, host, target: page.locator("#first b"), out, name: "text" });
  ok("text comments follow each pointer frame in white, keep a fixed right-side gap and disappear during continued movement away");

  await panel.click(".card.current .tools button:nth-child(2)");
  await host.locator('.editor[data-state="open"]').waitFor();
  await host.locator("#wc-note").fill("   \n  ");
  await host.getByRole("button", { name: "保存", exact: true }).click();
  await host.locator(".editor").waitFor({ state: "detached" });
  await until(async () => !(await entry("/spa")).page.annotations[0].note.trim(), "empty note persisted");
  await page.locator("#first b").hover();
  await until(async () => await host.locator('.tooltip[data-state="open"]').innerText() === "无评论", "blank note opens placeholder");
  await hoverTrackingChecks({ page, host, target: page.locator("#first b"), out, name: "text-empty" });
  await host.locator(".rail button").hover();
  await until(async () => await host.locator('.tooltip[data-state="open"]').innerText() === "无评论", "rail opens same placeholder");
  await page.screenshot({ path: join(out, "empty-comment-rail.png") });
  await page.mouse.move(20, 950);
  await tooltip.waitFor({ state: "detached" });
  ok("empty and whitespace-only text comments show 无评论 from the highlight and rail, track the mouse and dismiss normally");

  await panel.click(".card.current .tools button:nth-child(2)");
  await host.locator(".editor").waitFor();
  assert.equal(await note.evaluate(el => el.getRootNode().activeElement === el), true);
  await finishMotion(editor);
  const editBeforeDrag = await editor.boundingBox();
  await dragEditor(150, 80);
  const editAfterDrag = await editor.boundingBox();
  assert.ok(editAfterDrag.x > editBeforeDrag.x && editAfterDrag.y > editBeforeDrag.y);
  await host.locator("#wc-note").fill("来自侧栏编辑的批注");
  assert.deepEqual(await editor.boundingBox(), editAfterDrag);
  await host.getByRole("button", { name: "保存", exact: true }).click();
  await until(
    () =>
      panel.evaluate(
        () =>
          document.querySelector(".card.current .note")?.textContent ===
          "来自侧栏编辑的批注",
      ),
    "annotation sync",
  );
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await panel.click(".card.current .quote");
  await until(
    async () => (await page.evaluate(() => scrollY)) < 300,
    "jump to source",
  );
  ok(
    "page selection/highlighting, panel-to-page edit and jump, and live annotation updates work",
  );
  const mark = (await entry("/spa")).page.annotations[0];
  const stale = await panel.evaluate(
    async ({ url, id }) => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      return chrome.tabs.sendMessage(
        tab.id,
        { type: "page-action", action: "edit", url, id },
        { frameId: 0 },
      );
    },
    { url: base + "/wrong", id: mark.id },
  );
  assert.equal(stale.ok, false);
  await page.locator("#first").evaluate((e) => e.remove());
  await until(
    () =>
      panel.evaluate(() =>
        document.body.textContent.includes("未定位 · 重新绑定"),
      ),
    "missing anchor reported",
  );
  await panel.textClick("未定位 · 重新绑定");
  await host.getByText("请在原文重新选中这条标注对应的文字").waitFor();
  await page.evaluate(() => {
    const e = document.querySelector("#second");
    const r = document.createRange();
    r.selectNodeContents(e);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    e.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        button: 0,
        clientX: 400,
        clientY: 250,
      }),
    );
  });
  await host.getByRole("button", { name: "保存", exact: true }).click();
  await until(
    async () =>
      (await entry("/spa"))?.page.annotations[0].text.startsWith("同一篇文章"),
    "rebind persisted",
  );
  ok(
    "missing anchors rebind through the page bridge; stale-URL actions are rejected",
  );
  async function selectBottom() {
    await page.locator("#bottom").scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const element = document.querySelector("#bottom"), range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const bounds = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true, button: 0, clientX: bounds.right - 4, clientY: bounds.bottom - 4,
      }));
    });
    await quick.waitFor();
    await finishMotion(editor);
  }
  await editor.waitFor({ state: "detached" });
  await pageCDP.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 620, deviceScaleFactor: 1, mobile: false });
  await selectBottom();
  const narrowScroll = await page.evaluate(() => scrollY);
  await note.click();
  await note.waitFor();
  assert.equal(await note.evaluate(el => el.getRootNode().activeElement === el), true);
  assert.equal(await page.evaluate(() => scrollY), narrowScroll);
  await finishMotion(editor);
  const narrowBounds = await editor.boundingBox();
  assert.ok(narrowBounds.x >= 0 && narrowBounds.y >= 0 && narrowBounds.x + narrowBounds.width <= 390 && narrowBounds.y + narrowBounds.height <= 620);
  assert.equal(await editor.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: join(out, "floating-editor-narrow.png") });
  await dragEditor(-600, -800);
  const topLeftBounds = await editor.boundingBox();
  assert.equal(topLeftBounds.x, 12);
  assert.equal(topLeftBounds.y, 12);
  await dragEditor(900, 1000);
  const bottomRightBounds = await editor.boundingBox();
  assert.ok(bottomRightBounds.x + bottomRightBounds.width <= 378 && bottomRightBounds.y + bottomRightBounds.height <= 608);
  await pageCDP.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 480, deviceScaleFactor: 1, mobile: false });
  await until(async () => {
    const b = await editor.boundingBox();
    return b.x >= 12 && b.y >= 12 && b.x + b.width <= 308 && b.y + b.height <= 468;
  }, "dragged editor stays accessible after viewport shrink");
  assert.equal(await editor.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: join(out, "floating-editor-dragged-narrow.png") });
  const resizedBounds = await editor.boundingBox();
  await editor.getByRole("button", { name: "绿色", exact: true }).hover();
  assert.deepEqual(await editor.boundingBox(), resizedBounds, "color controls do not drag or reset the editor");
  await note.focus();
  await page.keyboard.insertText("直接输入第一行");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.insertText("第二行");
  assert.equal(await note.inputValue(), "直接输入第一行\n第二行");
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "detached" });
  assert.equal((await entry("/spa")).page.annotations.length, 1, "Escape only discards the draft");
  await pageCDP.send("Emulation.clearDeviceMetricsOverride");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await selectBottom();
  await note.click();
  await note.waitFor();
  assert.equal(await editor.evaluate(el => Number(getComputedStyle(el).opacity) === 1 && el.getAnimations().every(a => a.playState !== "running")), true);
  assert.equal(await note.evaluate(el => el.getRootNode().activeElement === el), true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  assert.equal(await editor.evaluate(el => Number(getComputedStyle(el).opacity) === 1 && el.getAnimations().every(a => a.playState !== "running")), true, "changing motion preference does not replay entry");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await host.getByLabel("关闭编辑窗", { exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  ok("near the page bottom, the focused editor fits a 390px viewport, supports multiline typing/Escape, and respects reduced motion");
  ok("new and existing editors drag, clamp to viewport edges and resize, while color and close buttons keep their normal actions");
  // Select in the same task as pushState, before React or the 500 ms URL poll.
  await page.evaluate(() => {
    history.pushState({}, "", "/instant");
    const e = document.querySelector("#second"),
      r = document.createRange();
    r.selectNodeContents(e);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(r);
    e.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        button: 0,
        clientX: 400,
        clientY: 250,
      }),
    );
  });
  await until(
    () =>
      panel.evaluate(() =>
        document
          .querySelector(".page-head .url")
          ?.textContent.endsWith("/instant"),
      ),
    "immediate SPA URL",
  );
  await editor.locator(".swatch").first().click();
  await until(
    async () => (await entry("/instant"))?.page.annotations.length === 1,
    "immediate SPA selection persisted",
  );
  assert.equal((await entry("/spa")).page.annotations.length, 1);
  ok(
    "selection immediately after pushState survives URL synchronization and saves only to the new page",
  );
  await editor.waitFor({ state: "detached" });
  await selectBottom();
  await note.click();
  await note.waitFor();
  await page.keyboard.insertText("自动聚焦后回车保存");
  await page.keyboard.press("Enter");
  await until(async () => (await entry("/instant"))?.page.annotations.some(mark => mark.note === "自动聚焦后回车保存"), "Enter saves immediately typed note");
  await editor.waitFor({ state: "detached" });
  ok("Enter saves a note typed after selection without ever clicking the comment input");
  // Restricted pages must not retain the previous article as an editable current page.
  await second.goto("chrome://version");
  await second.bringToFront();
  await until(
    () =>
      panel.evaluate(() =>
        document.body.textContent.includes("此页面无法摘录"),
      ),
    "restricted page",
  );
  assert.equal(
    await panel.evaluate(() => !!document.querySelector("#wc-page-comment")),
    false,
  );
  await panel.textClick("最近网页");
  await until(
    () => panel.evaluate(() => document.querySelectorAll(".webpage-card").length >= 2),
    "library remains available",
  );
  await until(() => panel.evaluate(() => [...document.querySelectorAll(".webpage-card .site-icon img")].length >= 2 && [...document.querySelectorAll(".webpage-card .site-icon img")].every(img => img.complete && img.naturalWidth > 0)), "recent icons loaded");
  await panel.screenshot("native-recent-icons.png");
  await panel.textClick("标签");
  await until(() => panel.evaluate(() => !!document.querySelector(".result-card .site-icon img")?.naturalWidth && !!document.querySelector(".result-card .site-backdrop img")?.naturalWidth), "tag icons loaded");
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot("native-tag-icons.png");
  ok("recent and tag cards show loaded site icons and backgrounds without horizontal overflow");
  await page.bringToFront();
  await panel.textClick("当前页面");
  await until(
    () => panel.evaluate(() => !!document.querySelector("#wc-page-comment")),
    "return to article",
  );
  ok(
    "restricted tabs show a clear message while the saved library remains usable",
  );
  await toggle(page);
  await panel.detach();
  await until(
    async () => (await page.evaluate(() => innerWidth)) === before,
    "browser action close",
  );
  await toggle(page);
  panel = await attachPanel();
  await until(
    () =>
      panel.evaluate(
        (v) =>
          document
            .querySelector(".footer-version")
            ?.textContent === "版本 " + v,
        version,
      ),
    "reopen after native close",
  );
  ok(
    "browser action close restores page width and the next action opens correctly",
  );
  // Isolated OPFS exercises real handle resolution and disk synchronization.
  // Only the OS picker and clipboard boundary are intercepted; a native Windows
  // dialog's initial folder still needs manual verification on a real directory.
  await panel.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("LocalMark QA", { create: true });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("local-web-clipper", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(root, "pendingRoot");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const reply = await chrome.runtime.sendMessage({ type: "directory-connected" });
    if (!reply.ok) throw Error(reply.error);
    window.__metadataPickerOriginal = window.showOpenFilePicker;
    window.__metadataCalls = [];
    window.showOpenFilePicker = async options => {
      window.__metadataCalls.push({ name: options.startIn.name, kind: options.startIn.kind,
        active: navigator.userActivation.isActive, text: await (await options.startIn.getFile()).text() });
      throw new DOMException("cancelled", "AbortError");
    };
    window.__metadataClipboardOriginal = navigator.clipboard.writeText;
    navigator.clipboard.writeText = async value => { window.__metadataCopied = value; };
  });
  await until(() => panel.evaluate(() => document.querySelector(".metadata-open")?.disabled === false), "metadata file synced");
  const metadataPath = new URL(page.url()).pathname;
  const metadataEntry = await entry(metadataPath);
  assert.ok(metadataEntry);
  const migratedNames = await panel.evaluate(async id => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("LocalMark QA");
    async function find(dir, prefix = "data") {
      const matches = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "directory") matches.push(...await find(handle, `${prefix}/${name}`));
        else if (name.endsWith(`--${id}.json`)) matches.push({ file: handle, dir, path: `${prefix}/${name}` });
      }
      return matches;
    }
    const matches = await find(await root.getDirectoryHandle("data"));
    if (matches.length !== 1) throw Error("Expected one named metadata file");
    const old = matches[0];
    const raw = await (await old.file.getFile()).text();
    const legacy = await root.getDirectoryHandle("原始数据", { create: true });
    const writer = await (await legacy.getFileHandle(`${id}.json`, { create: true })).createWritable();
    await writer.write(raw);
    await writer.close();
    await old.dir.removeEntry(old.file.name);
    const reply = await chrome.runtime.sendMessage({ type: "snapshot", refresh: true });
    if (!reply.ok) throw Error(reply.error);
    const result = await find(await root.getDirectoryHandle("data"));
    for (const item of result) {
      if (await (await item.file.getFile()).text() !== raw) throw Error("Migration changed article bytes");
      if (!/^data\/\d{4}-\d{2}\/\d{2}\//.test(item.path)) throw Error("Missing date folders");
    }
    try { await root.getDirectoryHandle("原始数据"); throw Error("Old directory remains"); }
    catch (error) { if (error.name !== "NotFoundError") throw error; }
    return result.map(item => item.file.name);
  }, metadataEntry.page.id);
  assert.deepEqual(migratedNames, [`${metadataEntry.page.title}--${metadataEntry.page.id}.json`]);
  await until(() => panel.evaluate(() => !document.querySelector(".metadata-open").disabled), "metadata migration refresh");
  ok("old ID-only JSON migrates to a readable title filename with identical bytes in real OPFS");
  await panel.click(".metadata-open");
  await until(() => panel.evaluate(() => window.__metadataCalls.length === 1 && !document.querySelector(".metadata-open").disabled), "metadata picker cancelled");
  const pickerCall = await panel.evaluate(() => window.__metadataCalls[0]);
  assert.equal(pickerCall.name, `${metadataEntry.page.title}--${metadataEntry.page.id}.json`);
  assert.equal(pickerCall.kind, "file");
  assert.equal(pickerCall.active, true);
  assert.equal(JSON.parse(pickerCall.text).url, page.url());
  assert.equal(await panel.evaluate(() => document.querySelector(".page-metadata-location [role=status]")?.textContent ?? ""), "");
  await panel.click(".metadata-copy");
  assert.equal(await panel.evaluate(() => window.__metadataCopied), pickerCall.name);
  assert.equal(await panel.evaluate(() => document.querySelector(".metadata-filename").textContent), pickerCall.name);
  assert.deepEqual((await entry(metadataPath)).page, metadataEntry.page);
  await downloadCurrentMetadata(metadataEntry.page);
  ok("downloaded JSON matches the active article stored in its month/day directory");
  await panel.click(".toast");
  await panel.screenshot("metadata-location.png");
  await panel.evaluate(() => {
    window.showOpenFilePicker = window.__metadataPickerOriginal;
    navigator.clipboard.writeText = window.__metadataClipboardOriginal;
  });
  ok("metadata button resolves the active article's real JSON handle, retains user activation, copies its filename and cancels without modifying article data (OS picker intercepted)");
  const { windowId } = await pageCDP.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: { width: 780, height: 800 },
  });
  await until(
    () => panel.evaluate(() => innerWidth < 450),
    "narrow native sidebar",
  );
  const geometry = await panel.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    panel: document.querySelector(".panel").getBoundingClientRect().width,
    footer: document.querySelector(".footer").getBoundingClientRect().bottom,
    height: innerHeight,
  }));
  assert.ok(geometry.scroll <= geometry.width);
  assert.ok(geometry.footer <= geometry.height + 1);
  await panel.screenshot("native-sidepanel-narrow.png");
  ok(
    "narrow native sidebar has no horizontal overflow and retains its version footer",
  );
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: { width: 1400, height: 1000 },
  });
  assert.equal(
    await panel.evaluate(() => {
      const e = document.querySelector('[aria-label="打开文章管理"]');
      return (
        !!e.closest("footer") &&
        e.nextElementSibling?.getAttribute("aria-label") === "目录与同步设置"
      );
    }),
    true,
  );
  await panel.click('[aria-label="打开文章管理"]');
  let dashboard;
  await until(() => {
    dashboard = context
      .pages()
      .find((p) => p.url().endsWith("/dashboard.html"));
    return dashboard;
  }, "dashboard opens from native panel");
  await dashboard
    .getByRole("heading", { name: "本地摘录", exact: true })
    .waitFor();
  await panel.click('[aria-label="打开文章管理"]');
  assert.equal(
    context.pages().filter((p) => p.url().endsWith("/dashboard.html")).length,
    1,
  );
  await dashboard.close();
  await page.bringToFront();
  ok("native footer management entry opens and reuses the dashboard window");
  const idleImportLayout = await panel.evaluate(() => ({
    entry: !!document.querySelector(".metadata-import-entry"),
    overlay: !!document.querySelector(".metadata-drop-overlay"),
    tabsTop: document.querySelector(".tabs").getBoundingClientRect().top,
  }));
  assert.deepEqual(idleImportLayout, { entry: false, overlay: false, tabsTop: 0 });
  await panel.screenshot("import-native-idle.png");
  const dragHint = (type, selector = ".panel", files = true) => panel.evaluate(({ type, selector, files }) => {
    const transfer = new DataTransfer();
    if (files) transfer.items.add(new File(["{}"], "示例.json", { type: "application/json" }));
    else transfer.setData("text/plain", "普通文字");
    const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
    document.querySelector(selector).dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, selector, files });
  assert.equal(await dragHint("dragenter", ".panel", false), false);
  assert.equal(await panel.evaluate(() => !!document.querySelector(".metadata-drop-overlay")), false);
  assert.equal(await dragHint("dragenter"), true);
  await until(() => panel.evaluate(() => document.querySelector(".metadata-drop-overlay")?.textContent.includes("支持拖入一个或多个 JSON")), "drag-only JSON hint");
  assert.equal(await panel.evaluate(() => document.querySelector(".tabs").getBoundingClientRect().top), 0);
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot("import-native-drag-hint.png");
  await dragHint("dragenter", ".tabs");
  await dragHint("dragleave", ".tabs");
  assert.equal(await panel.evaluate(() => !!document.querySelector(".metadata-drop-overlay")), true, "moving between children keeps the hint visible");
  await dragHint("dragleave");
  await until(() => panel.evaluate(() => !document.querySelector(".metadata-drop-overlay")), "leaving hides the hint");
  await dragHint("dragenter");
  await panel.evaluate(() => window.dispatchEvent(new Event("dragend")));
  await until(() => panel.evaluate(() => !document.querySelector(".metadata-drop-overlay")), "cancelling hides the hint");
  ok("sidebar import takes no idle space; only file drags show the overlay, without layout movement, and leave/cancel clears it");
  await panel.evaluate(base => {
    const transfer = new DataTransfer();
    for (const [id, title] of [["5555555555555555", "侧栏拖入一"], ["6666666666666666", "侧栏拖入二"]]) {
      const source = { schemaVersion: 2, id, title, url: base + "/" + id, originalUrl: base + "/" + id,
        favicon: "", folderName: title + "--" + id, createdAt: "2024-12-05T02:00:00.000Z", updatedAt: "2026-09-20T02:00:00.000Z",
        category: "侧栏导入分类", categoryId: "foreign-category", tags: ["侧栏导入标签"], tagIds: ["foreign-tag"], annotations: [], comment: "来自拖放" };
      transfer.items.add(new File([JSON.stringify(source)], title + ".json", { type: "application/json" }));
    }
    const target = document.querySelector(".panel");
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, base);
  await until(() => panel.evaluate(() => document.querySelector(".metadata-import-summary")?.textContent === "已导入 2 · 待同步 0 · 已跳过 0 · 失败 0"), "native sidebar import");
  assert.equal(await panel.evaluate(() => !!document.querySelector(".metadata-drop-overlay")), false);
  await panel.screenshot("import-native-result.png");
  await panel.click(".metadata-import-report header button");
  await until(() => panel.evaluate(() => document.querySelector(".tabs button.active")?.textContent.includes("最近网页")), "imported recent list");
  const imported = await entry("/5555555555555555");
  assert.equal(imported.page.comment, "来自拖放");
  assert.equal(imported.page.category, "侧栏导入分类");
  assert.deepEqual(imported.page.tags, ["侧栏导入标签"]);
  const storedImport = await panel.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("LocalMark QA");
    const dir = await (await (await root.getDirectoryHandle("data")).getDirectoryHandle("2024-12")).getDirectoryHandle("05");
    return JSON.parse(await (await (await dir.getFileHandle("侧栏拖入一--5555555555555555.json")).getFile()).text());
  });
  assert.deepEqual(storedImport, imported.page);
  ok("native sidebar accepts multiple dropped JSON files, writes dated metadata, and shows the imported records");
  const { expose: exposeElements } = await elementChecks({ page, panel, context, base, out, until, ok, state });
  const edgeToggle = page.locator("#local-web-clipper-root .element-pick-toggle");
  const sideToggle = page.locator("#local-web-clipper-root .sidepanel-toggle");
  await until(async () => await sideToggle.getAttribute("aria-expanded") === "true", "page button knows native sidebar is open");
  await panel.detach();
  await sideToggle.click();
  await until(async () => await sideToggle.getAttribute("aria-expanded") === "false", "page button closes the real native sidebar");
  await sideToggle.click();
  panel = await attachPanel();
  await until(async () => await sideToggle.getAttribute("aria-expanded") === "true", "page button reopens the real native sidebar");
  await page.screenshot({ path: join(out, "page-tools-sidebar-open.png") });
  ok("real page button closes and opens the native sidebar from a click, with the active state following its actual lifecycle");
  await edgeToggle.click();
  await page.locator("#local-web-clipper-root .element-picker").waitFor();
  await panel.detach();
  await toggle(page);
  await edgeToggle.waitFor();
  await page.locator("#local-web-clipper-root .element-picker").waitFor();
  await edgeToggle.click();
  await page.locator("#local-web-clipper-root .element-picker").waitFor({ state: "hidden" });
  await page.reload();
  await exposeElements();
  await edgeToggle.waitFor();
  await edgeToggle.click();
  await page.locator("#card-heading").click();
  const standaloneEditor = page.locator('#local-web-clipper-root .editor[data-state="open"]');
  await standaloneEditor.waitFor();
  await standaloneEditor.getByRole("button", { name: "关闭编辑窗", exact: true }).click();
  await standaloneEditor.waitFor({ state: "hidden" });
  await page.locator("#local-web-clipper-root .editor").waitFor({ state: "hidden" });
  await page.screenshot({ path: join(out, "element-edge-sidebar-closed.png") });
  await toggle(page);
  panel = await attachPanel();
  await edgeToggle.waitFor();
  assert.equal(await edgeToggle.getAttribute("aria-pressed"), "false");
  const alternate = await context.newPage();
  await alternate.goto(base + "/element-alternate");
  await alternate.bringToFront();
  await until(() => panel.evaluate(() => document.querySelector(".page-title-row h3")?.textContent.includes("element-alternate")), "sidebar follows the other tab");
  assert.equal(await edgeToggle.count(), 1, "tools remain mounted independently of the sidebar's active tab");
  await page.bringToFront();
  await edgeToggle.waitFor();
  await alternate.close();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const edgeAfterScroll = await edgeToggle.boundingBox();
  assert.ok(Math.abs(edgeAfterScroll.y + edgeAfterScroll.height / 2 - await page.evaluate(() => innerHeight / 2)) <= 1);
  await page.evaluate(() => scrollTo(0, 0));
  ok("page tools and element editing work with the native sidebar closed; reopening and tab switching keep tools available and centered after scroll");
  if (process.env.LOCALMARK_INTERACTIVE_QA === "1") {
    await panel.detach();
    await toggle(page);
    await page.goto(base + "/keyboard");
    await page.bringToFront();
    console.log("INTERACTIVE_READY");
    await writeFile(
      join(out, "native-interactive.json"),
      JSON.stringify({ profile, base, extId, before }),
    );
    await new Promise((resolve) => {
      process.stdin.once("data", resolve);
    });
  }
  assert.deepEqual(errors, []);
  ok("no uncaught page or native-panel errors");
  await writeFile(
    join(out, executablePath ? "native-sidepanel-chrome128-results.json" : "native-sidepanel-results.json"),
    JSON.stringify(
      { version, browser: context.browser().version(), driver: executablePath ? "native open API and document close; browser shortcut registration checked separately" : "CDP Extensions.triggerAction", checks, errors },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(e);
  for (const p of context.pages()) {
    console.error(
      "PAGE",
      p.url(),
      await p
        .evaluate(
          () =>
            document
              .querySelector("#local-web-clipper-root")
              ?.shadowRoot?.querySelector("style")?.nextSibling?.textContent,
        )
        .catch(() => ""),
    );
  }
  if (panel) {
    console.error(
      await panel.evaluate(() => document.body.innerText).catch(() => ""),
    );
    await panel.screenshot("native-sidepanel-failure.png").catch(() => {});
  }
  throw e;
} finally {
  await context.close();
  server.close();
}
