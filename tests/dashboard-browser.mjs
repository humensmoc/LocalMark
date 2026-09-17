import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const out = resolve("test-results");
await mkdir(out, { recursive: true });
const fixture = await readFile("tests/fixture.html", "utf8");
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(fixture);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "clipper-dashboard-"));
await mkdir(join(profile, "Default"), { recursive: true });
await writeFile(
  join(profile, "Default", "Preferences"),
  JSON.stringify({ extensions: { ui: { developer_mode: true } } }),
);
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: ["--enable-unsafe-extension-debugging"],
  ignoreDefaultArgs: ["--disable-extensions"],
  viewport: { width: 1440, height: 960 },
});
const checks = [],
  errors = [];
const ok = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
try {
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() =>
    chrome.developerPrivate.updateProfileConfiguration({
      inDeveloperMode: true,
    }),
  );
  await manager.close();
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send("Extensions.loadUnpacked", { path: resolve("dist") });
  await cdp.detach();
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const origin =
    new URL(worker.url()).origin === "null"
      ? `chrome-extension://${new URL(worker.url()).host}`
      : new URL(worker.url()).origin;
  const settings = await context.newPage();
  await settings.goto(`${origin}/settings.html`);
  const windowEvent = context.waitForEvent("page", (p) =>
    p.url().includes("dashboard.html"),
  );
  await settings
    .getByRole("button", { name: "打开文章管理", exact: true })
    .click();
  const page = await windowEvent;
  await page.waitForLoadState();
  await page.getByRole("heading", { name: "选择一篇文章" }).waitFor();
  ok("settings opens the large management window with empty state");
  const windowInfo = await page.evaluate(() => chrome.windows.getCurrent());
  assert.equal(windowInfo.type, "popup");
  assert.ok(windowInfo.width >= 1000);
  await settings
    .getByRole("button", { name: "打开文章管理", exact: true })
    .click();
  assert.equal(
    context.pages().filter((p) => p.url() === `${origin}/dashboard.html`)
      .length,
    1,
  );
  ok("reopening focuses the existing popup");

  const seeded = await page.evaluate(async (base) => {
    const database = await new Promise((resolve, reject) => {
      const r = indexedDB.open("local-web-clipper", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const root = await navigator.storage.getDirectory();
    const entries = {};
    const data = [
      [
        "游戏的驱动力：目标、反馈与长期成长",
        "游戏设计",
        ["设计方法论", "成长系统"],
        "从玩家目标出发，整理核心循环与长期成长之间的关系。",
      ],
      [
        "Idle 游戏分类学",
        "游戏设计",
        ["设计方法论"],
        "通过循环和时间投入理解放置游戏。",
      ],
      [
        "交互反馈设计参考",
        "交互设计",
        ["交互反馈"],
        "让每次操作都获得明确反馈。",
      ],
      ["没有标签的收藏", "未分类", [], ""],
    ];
    const ids = [];
    for (const [i, [title, category, tags, comment]] of data.entries()) {
      const url = `${base}/article-${i}`;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(url),
      );
      const id = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16);
      ids.push(id);
      const time = new Date(Date.now() - i * 1000).toISOString();
      const text = "玩家需要清晰的目标和及时的反馈。";
      const annotations =
        i === 0
          ? [
              {
                id: crypto.randomUUID(),
                text,
                note: "反馈应当帮助玩家理解下一步行动。",
                tags: [],
                color: "yellow",
                anchor: {
                  exact: text,
                  prefix: "",
                  suffix: "",
                  start: 0,
                  end: text.length,
                },
                createdAt: time,
                updatedAt: time,
              },
            ]
          : [];
      const p = {
        schemaVersion: 1,
        id,
        url,
        originalUrl: url,
        title,
        category,
        tags,
        comment,
        favicon: "",
        folderName: `文章--${id}`,
        createdAt: time,
        updatedAt: time,
        annotations,
      };
      entries[id] = {
        page: p,
        baseJson: null,
        baseMd: null,
        dirty: true,
        mdDirty: true,
      };
    }
    await new Promise((resolve, reject) => {
      const tx = database.transaction("kv", "readwrite");
      tx.objectStore("kv").put(
        { entries, lastColor: "yellow", status: "待同步", errors: [] },
        "library",
      );
      tx.objectStore("kv").put(root, "root");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    database.close();
    return ids;
  }, base);
  const rpc = (target, value) =>
    target.evaluate((m) => chrome.runtime.sendMessage(m), value);
  await page.getByRole("button", { name: "刷新本地数据" }).click();
  const detail = page.getByRole("region", { name: "文章详情", exact: true });
  const list = page.getByRole("region", { name: "筛选与文章列表" });
  const first = "游戏的驱动力：目标、反馈与长期成长";
  const firstCard = list.locator(".result-card").filter({ has: page.getByRole("button", { name: first, exact: true }) });
  const secondCard = list.locator(".result-card").filter({ has: page.getByRole("button", { name: "Idle 游戏分类学", exact: true }) });
  await firstCard.click({ position: { x: 8, y: 8 } });
  await detail.getByRole("heading", { name: first }).waitFor();
  await secondCard.locator(".result-comment p").click();
  await detail.getByRole("heading", { name: "Idle 游戏分类学" }).waitFor();
  await firstCard.locator(".result-taxonomy").click();
  await detail.getByRole("heading", { name: first }).waitFor();
  await secondCard.click({ position: { x: 8, y: 8 } });
  await firstCard.locator("summary").click();
  assert.equal(await firstCard.locator("details").getAttribute("open"), "");
  await detail.getByRole("heading", { name: "Idle 游戏分类学" }).waitFor();
  await firstCard.locator("summary").click();
  await firstCard.getByRole("button", { name: first, exact: true }).focus();
  await firstCard.getByRole("button", { name: first, exact: true }).press("Enter");
  await detail.getByRole("heading", { name: first }).waitFor();
  ok("whole card padding, comment and tags select details; summary and keyboard controls retain their behavior");
  assert.equal(
    context.pages().filter((p) => p.url().startsWith(base)).length,
    0,
  );
  ok("selecting an article opens its detail without navigating to its website");
  const bounds = await page
    .locator(".filter-panel, .tag-results, .dashboard-detail")
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      }),
    );
  assert.ok(
    bounds[0].right <= bounds[1].left + 2 &&
      bounds[1].right <= bounds[2].left + 2,
  );
  ok("wide window has three adjacent columns");
  await page.screenshot({
    path: join(out, "dashboard-wide.png"),
    fullPage: true,
  });

  await detail.getByRole("button", { name: "添加网页标签" }).click();
  await detail
    .getByRole("textbox", { name: "搜索或新建网页标签" })
    .fill("待复核");
  await detail
    .getByRole("textbox", { name: "搜索或新建网页标签" })
    .press("Enter");
  await detail.getByRole("button", { name: "移除网页标签：待复核" }).waitFor();
  await detail.getByRole("button", { name: "移除网页标签：成长系统" }).click();
  await detail
    .getByRole("button", { name: "移除网页标签：成长系统" })
    .waitFor({ state: "detached" });
  await detail.getByRole("button", { name: "选择主分类" }).click();
  await detail.getByRole("radio", { name: /交互设计/ }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.dashboard-detail [aria-label="选择主分类"]')
        ?.textContent === "交互设计",
  );
  ok("article tags and main category are editable in place");
  const filterPanel = page.getByRole("region", { name: "标签筛选条件" });
  await filterPanel.getByRole("button", { name: /待复核/ }).click();
  assert.equal(await list.locator(".result-card").count(), 1);
  await filterPanel.getByRole("button", { name: "清空筛选" }).click();
  await detail
    .getByRole("textbox", { name: "网页评论", exact: true })
    .fill("草稿：集中检查 AI 标注");
  await detail
    .getByRole("textbox", { name: "批注", exact: true })
    .fill("高亮草稿也应保留");
  await list
    .getByRole("button", { name: "Idle 游戏分类学", exact: true })
    .click();
  await list.getByRole("button", { name: first, exact: true }).click();
  assert.equal(
    await detail
      .getByRole("textbox", { name: "网页评论", exact: true })
      .inputValue(),
    "草稿：集中检查 AI 标注",
  );
  assert.equal(
    await detail
      .getByRole("textbox", { name: "批注", exact: true })
      .inputValue(),
    "高亮草稿也应保留",
  );
  ok("comment and annotation drafts survive article switches");
  await detail.getByRole("button", { name: "保存评论", exact: true }).click();
  await detail.getByRole("button", { name: "蓝色", exact: true }).click();
  assert.equal(
    await detail
      .getByRole("button", { name: "蓝色", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await detail
      .getByRole("button", { name: "蓝色", exact: true })
      .evaluate((b) => getComputedStyle(b).outlineWidth),
    "2px",
  );
  await detail
    .getByRole("textbox", { name: "高亮原文", exact: true })
    .fill("玩家需要及时的反馈。");
  await detail.getByText(/原网页中没有修改后的文字时/).waitFor();
  await detail.getByRole("button", { name: "保存高亮", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".dashboard-detail button")].some(
      (b) => b.textContent === "保存高亮" && b.disabled,
    ),
  );
  const snapshot = async () => {
    const r = await rpc(page, { type: "snapshot" });
    assert.equal(r.ok, true, r.error);
    return r.data;
  };
  let lib = await snapshot();
  let saved = lib.entries[seeded[0]].page;
  assert.equal(saved.comment, "草稿：集中检查 AI 标注");
  assert.equal(saved.category, "交互设计");
  assert.ok(saved.tags.includes("待复核") && !saved.tags.includes("成长系统"));
  assert.equal(saved.annotations[0].color, "blue");
  assert.equal(saved.annotations[0].text, saved.annotations[0].anchor.exact);
  assert.equal(
    saved.annotations[0].anchor.end - saved.annotations[0].anchor.start,
    saved.annotations[0].text.length,
  );
  const disk = await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const raw = await (
      await (
        await root.getDirectoryHandle("原始数据")
      ).getFileHandle(`${id}.json`)
    ).getFile();
    const p = JSON.parse(await raw.text());
    const md = await (await root.getFileHandle(p.markdownFile)).getFile();
    return { p, md: await md.text() };
  }, seeded[0]);
  assert.equal(disk.p.comment, saved.comment);
  assert.ok(
    disk.md.includes("草稿：集中检查 AI 标注") &&
      disk.md.includes("高亮草稿也应保留") &&
      disk.md.includes("待复核"),
  );
  ok(
    "edits persist through the real background to JSON and Markdown in isolated OPFS",
  );

  const second = await context.newPage();
  await second.goto(`${origin}/dashboard.html`);
  const common = { url: saved.url, title: saved.title, favicon: "" };
  await detail
    .getByRole("textbox", { name: "网页评论", exact: true })
    .fill("不能被并发更新丢弃的草稿");
  const update = await rpc(second, {
    type: "page-comment",
    ...common,
    comment: "另一窗口更新",
    expectedComment: saved.comment,
  });
  assert.equal(update.ok, true, update.error);
  await detail.getByText(/评论已有更新/).waitFor();
  await detail.getByRole("button", { name: "保存评论", exact: true }).click();
  await detail.getByText(/评论已在其他标签页或文件中修改/).waitFor();
  assert.equal(
    (await snapshot()).entries[seeded[0]].page.comment,
    "另一窗口更新",
  );
  assert.equal(
    await detail
      .getByRole("textbox", { name: "网页评论", exact: true })
      .inputValue(),
    "不能被并发更新丢弃的草稿",
  );
  ok(
    "cross-window notification and stale comment protection preserve the draft",
  );
  await detail.getByRole("button", { name: "读取最新评论" }).click();

  await detail
    .getByRole("textbox", { name: "批注", exact: true })
    .fill("过期高亮草稿");
  const prior = (await snapshot()).entries[seeded[0]].page.annotations[0];
  const updateMark = await rpc(second, {
    type: "save",
    ...common,
    mark: {
      ...prior,
      note: "另一窗口的批注",
      expectedUpdatedAt: prior.updatedAt,
      expectedMark: JSON.stringify(prior),
    },
  });
  assert.equal(updateMark.ok, true, updateMark.error);
  await detail.getByText(/这条高亮已有更新/).waitFor();
  await detail.getByRole("button", { name: "保存高亮", exact: true }).click();
  await detail.getByText(/此标注已在其他标签页或文件中修改/).waitFor();
  assert.equal(
    (await snapshot()).entries[seeded[0]].page.annotations[0].note,
    "另一窗口的批注",
  );
  page.once("dialog", (d) => d.accept());
  await detail.getByRole("button", { name: "删除高亮", exact: true }).click();
  await detail.getByText("标注已改变，请刷新后重试").waitFor();
  assert.equal(
    (await snapshot()).entries[seeded[0]].page.annotations.length,
    1,
  );
  ok("stale annotation save and delete cannot overwrite newer edits");
  await detail.getByRole("button", { name: "放弃修改" }).click();
  await second.close();

  // The dashboard may edit other pages; a normal webpage must retain the URL check.
  const website = await context.newPage();
  await website.goto(base + "/article-0");
  await website.locator("#local-web-clipper-root").waitFor();
  const siteCdp = await context.newCDPSession(website);
  const worlds = [];
  siteCdp.on("Runtime.executionContextCreated", ({ context }) =>
    worlds.push(context),
  );
  await siteCdp.send("Runtime.enable");
  const world = worlds.find(
    (w) => w.origin === origin || w.name.includes(new URL(worker.url()).host),
  );
  assert.ok(world);
  const denied = await siteCdp.send("Runtime.evaluate", {
    contextId: world.id,
    expression: `chrome.runtime.sendMessage(${JSON.stringify({ type: "page-tag", url: base + "/article-1", title: "other", favicon: "", tag: "错误跨页", action: "add" })})`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(denied.result.value.ok, false);
  ok("ordinary website content scripts still cannot edit a different URL");
  await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
    await chrome.tabs.sendMessage(tab.id, { type: "show" });
  }, base + "/article-0");
  await website.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const { root: dom } = await siteCdp.send("DOM.getDocument", {
    depth: -1,
    pierce: true,
  });
  const findButton = (n) => {
    if (n.nodeName === "BUTTON" && n.attributes?.includes("打开文章管理"))
      return n;
    for (const child of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
      const found = findButton(child);
      if (found) return found;
    }
  };
  const button = findButton(dom);
  assert.ok(button, "sidebar has a dashboard entry in its closed Shadow DOM");
  const { object } = await siteCdp.send("DOM.resolveNode", {
    backendNodeId: button.backendNodeId,
  });
  const placement = await siteCdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: 'function(){return !!this.closest("footer") && this.nextElementSibling?.getAttribute("aria-label") === "目录与同步设置";}',
    returnByValue: true,
  });
  assert.equal(placement.result.value, true, "dashboard entry is beside Settings in the footer");
  await siteCdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: "function(){this.click();}",
  });
  await page.waitForFunction(
    async () => (await chrome.windows.getCurrent()).focused,
  );
  assert.equal(
    context.pages().filter((p) => p.url() === `${origin}/dashboard.html`)
      .length,
    1,
  );
  ok("sidebar management button focuses the large window");
  await siteCdp.detach();
  await website.close();

  // Simulate an AI changing a local JSON file, then reread it without visiting the website.
  await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const handle = await (
      await root.getDirectoryHandle("原始数据")
    ).getFileHandle(`${id}.json`);
    const p = JSON.parse(await (await handle.getFile()).text());
    p.tags.push("AI新增标签");
    const writer = await handle.createWritable();
    await writer.write(JSON.stringify(p, null, 2) + "\n");
    await writer.close();
  }, seeded[0]);
  await page.getByRole("button", { name: "刷新本地数据" }).click();
  await detail
    .getByRole("button", { name: "移除网页标签：AI新增标签" })
    .waitFor();
  ok("external JSON changes refresh into editable article details");
  await page.reload();
  await list.getByRole("button", { name: first, exact: true }).click();
  await detail
    .getByRole("button", { name: "移除网页标签：AI新增标签" })
    .waitFor();
  assert.equal(
    await detail
      .getByRole("textbox", { name: "网页评论", exact: true })
      .inputValue(),
    "另一窗口更新",
  );
  assert.equal(
    await detail
      .getByRole("textbox", { name: "批注", exact: true })
      .inputValue(),
    "另一窗口的批注",
  );
  ok("reloading the manager restores saved tags, comments and highlights");
  await page.screenshot({
    path: join(out, "dashboard-edited.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 900, height: 850 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(out, "dashboard-medium.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 480, height: 850 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await detail
    .getByRole("textbox", { name: "网页评论", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(out, "dashboard-narrow.png"),
    fullPage: true,
  });
  ok("medium and narrow layouts have no horizontal overflow");
  page.once("dialog", (d) => d.accept());
  await detail.getByRole("button", { name: "删除高亮", exact: true }).click();
  await detail
    .getByText("暂无高亮。需要新增摘录时，打开原网页选择文字。")
    .waitFor();
  assert.equal(
    (await snapshot()).entries[seeded[0]].page.annotations.length,
    0,
  );
  ok("deleting an unchanged annotation persists correctly");
  await page.close();
  const reopenedEvent = context.waitForEvent("page", (p) =>
    p.url().includes("dashboard.html"),
  );
  await settings
    .getByRole("button", { name: "打开文章管理", exact: true })
    .click();
  const reopened = await reopenedEvent;
  await reopened.getByRole("button", { name: first, exact: true }).waitFor();
  ok("closing and reopening recreates the window with the saved library");
  assert.deepEqual(errors, []);
  ok("no uncaught browser errors");
  await writeFile(
    join(out, "dashboard-results.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await context.close();
  server.close();
}
