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
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const settings = await context.newPage();
  await settings.goto(
    `chrome-extension://${new URL(worker.url()).host}/settings.html`,
  );
  const seedPage = await context.newPage();
  const seedCDP = await context.newCDPSession(seedPage);
  let seedWorld;
  seedCDP.on("Runtime.executionContextCreated", ({ context }) => {
    if (
      context.origin === `chrome-extension://${new URL(worker.url()).host}` ||
      context.name.includes(new URL(worker.url()).host)
    )
      seedWorld = context.id;
  });
  await seedCDP.send("Runtime.enable");
  const rpc = async (m) => {
    if (seedPage.url() !== m.url) {
      seedWorld = undefined;
      await seedPage.goto(m.url);
      await seedPage.locator("#local-web-clipper-root").waitFor();
    }
    assert.ok(seedWorld, "extension isolated world is available");
    const response = await seedCDP.send("Runtime.evaluate", {
      contextId: seedWorld,
      expression: `chrome.runtime.sendMessage(${JSON.stringify(m)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = response.result.value;
    assert.equal(value?.ok, true, value?.error ?? JSON.stringify(response));
    return value.data;
  };
  const fixtures = [
    [
      "Game Design Patterns Wiki 主页与完整设计模式参考资料",
      "游戏设计",
      ["设计方法论", "模式"],
      "整理常见设计模式，帮助分析规则如何影响玩家的决策。\n".repeat(8),
    ],
    [
      "Idle 游戏分类学",
      "游戏设计",
      ["设计方法论"],
      "从核心循环和成长目标理解放置游戏。",
    ],
    ["交互反馈设计参考", "交互设计", ["模式"], "反馈与可读性。"],
    ["仅收藏的网页", "未分类", [], ""],
  ];
  for (const [i, [title, category, tags, comment]] of fixtures.entries()) {
    const common = { url: base + "/filter-" + i, title, favicon: "" };
    await rpc({
      ...common,
      type: "page-category",
      category,
      expectedCategory: "未分类",
    });
    for (const tag of tags)
      await rpc({ ...common, type: "page-tag", tag, action: "add" });
    if (comment)
      await rpc({
        ...common,
        type: "page-comment",
        comment,
        expectedComment: "",
      });
    if (i === 0)
      await rpc({
        ...common,
        type: "save",
        mark: {
          text: "Highlight this passage",
          note: "独特摘录检索词",
          color: "yellow",
          anchor: {
            exact: "Highlight this passage",
            prefix: "",
            suffix: "",
            start: 0,
            end: 22,
          },
        },
      });
  }
  const page = await context.newPage();
  await page.goto(base + "/filter-0");
  await inspectUI(page);
  const host = page.locator("#local-web-clipper-root");
  await page.keyboard.press("Control+b");
  await host.getByRole("button", { name: "标签", exact: true }).click();
  const cards = host.locator(".result-card");
  const categories = host.getByRole("group", { name: "主分类筛选" });
  const tags = host.getByRole("group", { name: "小标签筛选" });
  const count = async (n) => {
    await host
      .locator(".result-heading")
      .getByText(`${n} 个网页`, { exact: true })
      .waitFor();
    assert.equal(await cards.count(), n);
  };
  await count(4);
  await categories
    .getByRole("button", { name: "游戏设计 2", exact: true })
    .click();
  await count(2);
  assert.equal(await tags.getByRole("button", { name: / 0$/ }).count(), 0);
  await tags.getByRole("button", { name: "模式 1", exact: true }).click();
  await count(1);
  await tags.getByRole("button", { name: "设计方法论 1", exact: true }).click();
  await count(1);
  assert.equal(
    await host.locator(".filter-chip[aria-pressed=true]").count(),
    3,
  );
  assert.equal(
    await categories.getByRole("button", { name: /^交互设计 / }).count(),
    0,
  );
  assert.ok(
    (await host.locator(".filter-chip small").allTextContents()).every(
      (value) => Number(value) > 0,
    ),
  );
  await host.getByLabel("搜索摘录").fill("不存在的筛选内容");
  await count(0);
  assert.equal(await host.locator(".filter-chip small").count(), 0);
  await host.getByText("没有符合条件的网页", { exact: true }).waitFor();
  await host.getByLabel("搜索摘录").fill("");
  await count(1);
  await categories
    .getByRole("button", { name: "游戏设计 1", exact: true })
    .click();
  await tags.getByRole("button", { name: "设计方法论 1", exact: true }).click();
  await count(2);
  await host.getByRole("button", { name: "清空筛选", exact: true }).click();
  await count(4);
  ok(
    "category and tag zero counts hidden; search recovery, deselection and clearing",
  );
  await host.getByLabel("搜索摘录").fill("独特摘录检索词");
  await count(1);
  await cards.locator(".result-annotations summary").click();
  await cards.getByText("独特摘录检索词", { exact: true }).waitFor();
  await cards.getByText("查看完整评论", { exact: true }).click();
  assert.equal(
    await cards.locator(".result-comment details > div").innerText(),
    fixtures[0][3],
  );
  await host.getByLabel("搜索摘录").fill("不存在的文字");
  await count(0);
  await host.getByLabel("搜索摘录").fill("");
  await count(4);
  const shortCommentCard = cards.filter({ hasText: "交互反馈设计参考" });
  assert.equal(
    await shortCommentCard.locator(".result-comment summary").count(),
    0,
  );
  assert.equal(
    await host
      .locator(".result-source, .preview-label, .result-card time")
      .count(),
    0,
  );
  const longCommentCard = cards.filter({ hasText: fixtures[0][0] });
  const previewStyle = await longCommentCard
    .locator(".result-comment > p")
    .evaluate((el) => ({
      whiteSpace: getComputedStyle(el).whiteSpace,
      overflow: getComputedStyle(el).textOverflow,
      clipped: el.scrollWidth > el.clientWidth,
    }));
  assert.deepEqual(previewStyle, {
    whiteSpace: "nowrap",
    overflow: "ellipsis",
    clipped: true,
  });
  await longCommentCard.locator(".result-comment summary").click();
  await longCommentCard.locator(".result-comment details > div").waitFor();
  await page.setViewportSize({ width: 320, height: 620 });
  await longCommentCard.locator(".result-comment details[open]").waitFor();
  await longCommentCard.locator(".result-comment summary").click();
  assert.equal(
    await shortCommentCard.locator(".result-comment summary").count(),
    0,
  );
  ok(
    "single-line ellipsis, expand only for truncated comments, full text survives resize, no source/date/label",
  );
  await page.setViewportSize({ width: 390, height: 840 });
  await page.screenshot({ path: join(out, "tag-result-cards.png") });
  const openedPromise = context.waitForEvent("page");
  await cards
    .getByRole("button", { name: fixtures[0][0], exact: true })
    .click();
  const opened = await openedPromise;
  await opened.waitForURL(base + "/filter-0");
  await opened.close();
  ok(
    "search includes annotation text, comments and highlights expand, title opens correct page",
  );
  for (let i = 0; i < 18; i++) {
    const common = {
      url: base + "/extra-" + i,
      title: "游戏设计案例 " + (i + 1),
      favicon: "",
    };
    await rpc({
      ...common,
      type: "page-category",
      category: ["游戏分析", "访谈", "游戏开发"][i % 3],
      expectedCategory: "未分类",
    });
    await rpc({
      ...common,
      type: "page-tag",
      tag: "主题标签" + (i + 1),
      action: "add",
    });
  }
  await count(22);
  for (const width of [1360, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1360 ? 960 : 620 });
    const dimensions = await host.locator(".tag-browser").evaluate((el) => {
      const chips = [...el.querySelectorAll(".filter-chip")].map((x) =>
        x.getBoundingClientRect(),
      );
      const filter = el.querySelector(".filter-panel").getBoundingClientRect();
      const results = el.querySelector(".tag-results").getBoundingClientRect();
      return {
        overflow: [...el.querySelectorAll("*")]
          .filter(
            (x) =>
              x.clientWidth &&
              x.scrollWidth > x.clientWidth + 1 &&
              !["hidden", "auto"].includes(getComputedStyle(x).overflowX),
          )
          .map((x) => x.className),
        filterBottom: filter.bottom,
        resultsTop: results.top,
        filterHeight: filter.height,
        resultsHeight: results.height,
        sharedRow: chips.some((a, i) =>
          chips.some((b, j) => i !== j && Math.abs(a.top - b.top) < 1),
        ),
      };
    });
    const chromeLayout = await host.locator(".panel").evaluate(el => {
      const footer = el.querySelector(".footer");
      const nav = el.querySelector(".tabs");
      return {
        footerHeight: footer.getBoundingClientRect().height,
        headerHeight: nav.getBoundingClientRect().height,
        footerButtons: footer.querySelectorAll("button").length,
        oldBrand: el.querySelectorAll(".brand, .logo").length,
        overflowing: [footer, nav].some(x => x.scrollWidth > x.clientWidth),
        closeWidth: el.querySelector(".sidebar-close").getBoundingClientRect().width,
      };
    });
    assert.ok(chromeLayout.footerHeight <= 40);
    assert.ok(chromeLayout.headerHeight <= 50);
    assert.equal(chromeLayout.footerButtons, 2);
    assert.equal(chromeLayout.oldBrand, 0);
    assert.equal(chromeLayout.overflowing, false);
    assert.equal(chromeLayout.closeWidth, 24);
    assert.deepEqual(dimensions.overflow, []);
    assert.ok(dimensions.sharedRow);
    assert.ok(dimensions.resultsTop >= dimensions.filterBottom);
    assert.ok(dimensions.resultsHeight > 95);
    const filterBefore = await host.locator(".filter-panel").boundingBox();
    await host
      .locator(".tag-results")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    assert.deepEqual(
      await host.locator(".filter-panel").boundingBox(),
      filterBefore,
    );
    await host.locator(".tag-results").evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({ path: join(out, `tag-filters-${width}.png`) });
  }
  await host.getByRole("button", { name: "当前页面", exact: true }).click();
  await host.getByRole("button", { name: "查看同类网页", exact: true }).click();
  await count(2);
  await categories
    .getByRole("button", { name: "游戏设计 2", exact: true, pressed: true })
    .waitFor();
  await page.screenshot({ path: join(out, "tag-filter-selected.png") });
  assert.deepEqual(errors, []);
  ok(
    "dense chips, independent scrolling and no overflow at 1360/390/320; category shortcut preserves filter view",
  );
} catch (error) {
  for (const [i, page] of context.pages().entries())
    await page.screenshot({ path: join(out, `tag-failure-${i}.png`) });
  throw error;
} finally {
  await context.close();
  server.close();
}
