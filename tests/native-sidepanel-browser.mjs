import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const out = resolve("test-results");
await mkdir(out, { recursive: true });
const fixture = await readFile("tests/fixture.html", "utf8");
const server = createServer((req, res) => {
  if (req.url === "/site-icon.svg") {
    res.setHeader("Content-Type", "image/svg+xml");
    res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#6656ef"/><path d="M32 10 49 42 32 54 15 42Z" fill="#b7eaff"/></svg>');
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
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
  await until(() => panel.evaluate(() => [...document.querySelectorAll(".page-head .site-icon img, .page-head .site-backdrop img")].length === 2 && [...document.querySelectorAll(".page-head img")].every(img => img.complete && img.naturalWidth > 0)), "current page icon and backdrop loaded");
  ok("current page shows its site icon and frosted backdrop");
  await page.screenshot({ path: join(out, "native-page-resized.png") });
  const ratingColors = new Set();
  for (let rating = 1; rating <= 5; rating++) {
    await panel.click(`.rating-stars button[aria-label="${rating} 星"]`);
    await until(async () => (await entry("/first"))?.page.rating === rating, "rating saved");
    await until(() => panel.evaluate(() => !document.querySelector(".rating-stars button").disabled), "rating idle");
    await panel.textClick("最近网页");
    await until(() => panel.evaluate(n => document.querySelectorAll(".card .rating-dots .filled").length === n, rating), "recent rating");
    ratingColors.add(await panel.evaluate(() => getComputedStyle(document.querySelector(".rating-dots")).color));
    assert.equal(await panel.evaluate(() => document.querySelectorAll(".card .rating-dots i").length), 5);
    const geometry = await panel.evaluate(() => {
      const card = document.querySelector(".card");
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
    await page.evaluate(() => getSelection().toString()),
    "Highlight this passage",
  );
  await host.getByLabel("高亮选中文字", { exact: true }).click();
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
  await host.locator(".quick").waitFor({ state: "hidden" });
  await panel.click(".card.current .tools button:nth-child(2)");
  await host.locator(".editor").waitFor();
  await host.locator("#wc-note").fill("来自侧栏编辑的批注");
  await host.getByRole("button", { name: "确认保存", exact: true }).click();
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
  await host.getByRole("button", { name: "确认保存", exact: true }).click();
  await until(
    async () =>
      (await entry("/spa"))?.page.annotations[0].text.startsWith("同一篇文章"),
    "rebind persisted",
  );
  ok(
    "missing anchors rebind through the page bridge; stale-URL actions are rejected",
  );
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
  await host.getByLabel("高亮选中文字", { exact: true }).click();
  await until(
    async () => (await entry("/instant"))?.page.annotations.length === 1,
    "immediate SPA selection persisted",
  );
  assert.equal((await entry("/spa")).page.annotations.length, 1);
  ok(
    "selection immediately after pushState survives URL synchronization and saves only to the new page",
  );
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
    () => panel.evaluate(() => document.querySelectorAll(".card").length >= 2),
    "library remains available",
  );
  await until(() => panel.evaluate(() => [...document.querySelectorAll(".card .site-icon img")].length >= 2 && [...document.querySelectorAll(".card .site-icon img")].every(img => img.complete && img.naturalWidth > 0)), "recent icons loaded");
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
