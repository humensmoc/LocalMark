import { chromium } from "playwright";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const out = resolve("test-results");
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "localmark-filters-"));
await mkdir(join(profile, "Default"), { recursive: true });
await writeFile(join(profile, "Default", "Preferences"), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true, args: ["--enable-unsafe-extension-debugging"],
  ignoreDefaultArgs: ["--disable-extensions"], viewport: { width: 1920, height: 1080 },
});
context.setDefaultTimeout(12000);
const checks = [], errors = [];
context.on("page", page => {
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
});
const ok = text => { checks.push(text); console.log("PASS", text); };
try {
  // Keep fixture artwork deterministic and offline; real fallback handling is
  // covered by the dashboard regression suite.
  await context.route("https://example.com/favicon.ico", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#306e70"/><path d="M8 9h16v14H8z" fill="#a6e5d2"/></svg>' }));
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await manager.close();
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send("Extensions.loadUnpacked", { path: resolve("dist") });
  await cdp.detach();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/dashboard.html`);
  await page.getByRole("heading", { name: "选择一篇文章" }).waitFor();
  const fixture = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("local-web-clipper", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const counts = [99, 52, 16, 12, 7, 7, 6, 5, 5, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0];
    const names = ["前端设计", "游戏设计", "知识管理", "游戏分析", "游戏开发", "工具", "访谈", "AI技术", "AI", "开发日志", "网页游戏", "交互设计", "抖机灵", "漫画", "个人资料", "游戏行业", "软件开发", "文化研究", "文学", "笔记", "游戏资讯", "游戏资料", "游戏营销", "未分类", "视觉设计", "杂谈"];
    const categories = names.map((name, i) => ({ id: name === "未分类" ? "category:uncategorized" : `category:${i}`, name }));
    const tagNames = ["游戏设计", "开发复盘", "Roguelike", "AI游戏", "设计模式", "角色设计", "叙事设计", "玩家动机", "交互方法论", "游戏研究", "价值设计", "笔记方法", "网页设计", "学习方法", ...Array.from({ length: 62 }, (_, i) => `主题线索 ${i + 1}`)];
    const tags = tagNames.map((name, i) => ({ id: `tag:${i}`, name }));
    tags.push({ id: "empty-tag", name: "待整理的标签" });
    const taxonomy = { version: 1, revision: crypto.randomUUID(), categories, tags };
    const entries = {};
    let index = 0;
    for (const [categoryIndex, count] of counts.entries()) for (let j = 0; j < count; j++) {
      const id = index.toString(16).padStart(16, "0");
      const time = new Date(Date.now() - index * 1000).toISOString();
      const tagIndices = index === 0 ? [] : [...new Set([index % 76, ...(index < 120 ? [0] : []), ...(index % 2 ? [1] : []), ...(index % 3 ? [8] : [])])];
      const annotations = Array.from({ length: index === 0 ? 22 : index % 6 }, (_, markIndex) => ({
        id: crypto.randomUUID(), text: `摘录 ${markIndex + 1}：从清晰的目标与反馈理解设计。`, note: markIndex % 3 ? "结合项目验证这条观点。" : "", tags: [], color: "yellow",
        anchor: { exact: "设计", prefix: "", suffix: "", start: markIndex * 10, end: markIndex * 10 + 2 }, createdAt: time, updatedAt: time,
      }));
      if (index === 0) {
        annotations[0].text = "超长摘录，滚动正文时主分类应该保持可见。".repeat(200);
        annotations[0].note = "超长批注，标签应该保持在来源上方。".repeat(100);
      }
      entries[id] = { page: { schemaVersion: 2, id, url: `https://example.com/${index}`, originalUrl: `https://example.com/${index}`,
        title: `${names[categoryIndex]}参考 ${j + 1}：理解规则、结构与反馈`, categoryId: categories[categoryIndex].id, category: names[categoryIndex],
        tags: tagIndices.map(i => tags[i].name), tagIds: tagIndices.map(i => tags[i].id), annotations, comment: "围绕设计方法与实践案例，梳理值得长期积累的知识。".repeat(4),
        favicon: "", folderName: `文章--${id}`, rating: index % 5 + 1, createdAt: time, updatedAt: time }, baseJson: null, baseMd: null, dirty: true, mdDirty: true };
      index++;
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put({ entries, taxonomy, lastColor: "yellow", status: "未连接目录", errors: [] }, "library");
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { pageCount: index, tagTotal: Object.values(entries).reduce((sum, entry) => sum + entry.page.tagIds.length, 0) };
  });
  await page.evaluate(() => localStorage.setItem("localmark.filters.dashboard.highlights", JSON.stringify({ height: 320, collapsed: false })));
  await page.reload();
  const navigation = page.getByRole("navigation", { name: "资料库视图" });
  const view = name => navigation.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  const panel = page.locator(".resizable-filters");
  const tag = (surface, name) => surface.getByRole("group", { name: "小标签筛选" }).getByRole("button", { name: new RegExp(`^${name}\\s*\\d+$`) });
  const boxHeight = async surface => Math.round((await surface.locator(".resizable-filters").boundingBox()).height);
  const dragHeight = async (surface, delta) => {
    const handle = surface.getByRole("separator", { name: "调整标签区域高度" });
    const box = await handle.boundingBox();
    await surface.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await surface.mouse.down();
    await surface.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + delta, { steps: 10 });
    await surface.mouse.up();
  };
  await page.locator(".result-card").first().waitFor();
  const badgeStyle = locator => locator.evaluate(node => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, color: style.color, fontSize: style.fontSize };
  });
  const pageCategoryStyle = await badgeStyle(page.locator(".result-category").first());
  const pageTagStyle = await badgeStyle(page.locator(".result-tag").first());
  assert.notDeepEqual(pageCategoryStyle, pageTagStyle);
  assert.equal(await page.locator(".bulk-toolbar").count(), 0);
  const summaryBox = await page.locator(".result-heading > b").boundingBox();
  const toggleBox = await page.getByRole("button", { name: "多选", exact: true }).boundingBox();
  assert.ok(Math.abs(summaryBox.y + summaryBox.height / 2 - toggleBox.y - toggleBox.height / 2) < 2);
  await page.screenshot({ path: join(out, "taxonomy-inline-multiselect.png"), fullPage: true });
  const expected = await page.evaluate(async () => {
    const { data } = await chrome.runtime.sendMessage({ type: "snapshot" });
    return Object.values(data.entries).map(({ page }) => ({ tags: page.tagIds, category: page.categoryId,
      highlights: page.annotations.length, comments: page.annotations.filter(mark => mark.note.trim()).length }));
  });
  const count = (kind, tags = [], category = "") => expected.filter(p => (!category || p.category === category) && tags.every(t => p.tags.includes(t)))
    .reduce((total, p) => total + (kind === "pages" ? 1 : p[kind]), 0);

  await tag(page, "游戏设计").click();
  assert.equal(await page.locator(".result-card").count(), count("pages", ["tag:0"]));
  const before = await boxHeight(page);
  await dragHeight(page, 90);
  assert.equal(await boxHeight(page), before + 90);
  const resizedPages = await boxHeight(page);
  await page.getByRole("button", { name: "收起标签筛选" }).click();
  assert.ok(await boxHeight(page) < 70);
  assert.equal(await page.getByRole("group", { name: "小标签筛选" }).count(), 0);
  assert.equal(await page.locator(".result-card").count(), count("pages", ["tag:0"]));
  assert.match(await panel.textContent(), /已选 1 项/);
  await page.reload();
  await page.getByRole("button", { name: "展开标签筛选" }).waitFor();
  await page.getByRole("button", { name: "展开标签筛选" }).click();
  assert.equal(await boxHeight(page), resizedPages);
  ok("webpage filters resize by real mouse, collapse without clearing results, and remember layout on reload");

  await view("高亮内容");
  if (await page.getByRole("switch", { name: "按网页分组" }).getAttribute("aria-checked") === "true") await page.getByRole("switch", { name: "按网页分组" }).click();
  const verifyFixedTaxonomy = async () => {
    const first = page.locator(".content-card").first();
    assert.equal(await first.locator(".result-category").textContent(), "前端设计");
    assert.equal(await first.locator(".result-tag").count(), 0, "a page without child tags still displays its category");
    assert.equal(await page.locator(".content-card > .content-page-tags").count(), await page.locator(".content-card").count());
    assert.deepEqual(await badgeStyle(first.locator(".result-category")), pageCategoryStyle);
    assert.deepEqual(await badgeStyle(page.locator(".content-page-tags .result-tag").first()), pageTagStyle);
    const body = first.locator(".content-card-body");
    assert.ok(await body.evaluate(node => node.scrollHeight > node.clientHeight));
    const original = await first.locator(".content-page-tags").boundingBox();
    const cardBox = await first.boundingBox();
    const sourceBox = await first.locator(".content-source").boundingBox();
    assert.ok(original.y >= cardBox.y && original.y + original.height <= sourceBox.y);
    assert.ok(cardBox.height <= 481);
    await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
    assert.deepEqual(await first.locator(".content-page-tags").boundingBox(), original);
    await body.evaluate(node => { node.scrollTop = 0; });
  };
  await verifyFixedTaxonomy();
  await page.screenshot({ path: join(out, "taxonomy-fixed-highlights.png"), fullPage: true });
  assert.equal(await page.locator(".content-card").count(), count("highlights"));
  assert.ok(await page.getByLabel("所属网页标签", { exact: true }).count() > 0);
  assert.equal(await boxHeight(page), 180, "legacy large height adopts compact automatic layout independently from webpages");
  await tag(page, "Roguelike").click();
  await page.waitForFunction(() => document.querySelector(".resizable-filters").getBoundingClientRect().height < 120);
  const compactHeight = await boxHeight(page);
  assert.equal(await page.locator(".content-card").count(), count("highlights", ["tag:2"]));
  assert.ok(await page.locator(".filter-options").evaluate(node => node.scrollHeight <= node.clientHeight + 1), "sparse filters fit without a blank fixed-height tail");
  await page.screenshot({ path: join(out, "filters-compact-sparse.png"), fullPage: true });
  await dragHeight(page, 80);
  assert.equal(await boxHeight(page), compactHeight + 80, "explicit dragging still sets an exact height");
  await page.getByRole("separator", { name: "调整标签区域高度" }).dblclick();
  assert.equal(await boxHeight(page), compactHeight, "reset returns to automatic content height");
  await page.getByRole("button", { name: "清空筛选", exact: true }).click();
  await page.waitForFunction(() => Math.round(document.querySelector(".resizable-filters").getBoundingClientRect().height) === 180);
  ok(`sparse filters shrink to ${compactHeight}px, dense filters return to 180px, old height migrates and explicit drag/reset still work`);
  await tag(page, "游戏设计").click();
  await tag(page, "开发复盘").click();
  assert.equal(await page.locator(".content-card").count(), count("highlights", ["tag:0", "tag:1"]));
  await page.getByRole("group", { name: "主分类筛选" }).getByRole("button", { name: /^前端设计\s*\d+$/ }).click();
  assert.equal(await page.locator(".content-card").count(), count("highlights", ["tag:0", "tag:1"], "category:0"));
  await dragHeight(page, 100);
  const highHeight = await boxHeight(page);
  await page.getByRole("button", { name: "收起标签筛选" }).click();
  assert.equal(await page.locator(".content-card").count(), count("highlights", ["tag:0", "tag:1"], "category:0"));
  await page.screenshot({ path: join(out, "filters-highlights-collapsed.png"), fullPage: true });
  await page.getByRole("button", { name: "展开标签筛选" }).click();
  assert.equal(await boxHeight(page), highHeight);
  await page.getByRole("textbox", { name: "搜索高亮内容" }).fill("没有匹配的随机词");
  await page.getByRole("heading", { name: "没有匹配的内容" }).waitFor();
  assert.equal(await tag(page, "游戏设计").getAttribute("aria-pressed"), "true", "selected zero-count filters remain removable");
  await page.getByRole("button", { name: "清空筛选", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索高亮内容" }).fill("");
  assert.equal(await page.locator(".content-card").count(), count("highlights"));
  await page.screenshot({ path: join(out, "filters-highlights-wide.png"), fullPage: true });
  ok("highlights show webpage tags and combine category, AND tags and text search; empty selections can be cleared");

  assert.equal(await navigation.getByRole("button", { name: /^独立批注/ }).count(), 0);
  assert.equal(await page.locator(".content-note").count(), count("comments"));
  await verifyFixedTaxonomy();
  await page.getByRole("button", { name: "收起标签筛选" }).click();
  await view("网页");
  await view("高亮内容");
  await page.getByRole("button", { name: "展开标签筛选" }).click();
  assert.equal(await boxHeight(page), highHeight);
  assert.equal(await page.locator(".content-card").count(), count("highlights"));
  ok("group-first metadata remains fixed, notes remain inline, removed tab is absent and highlight filter layout survives switching");

  for (const width of [900, 480, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const name of ["高亮内容", "网页"]) {
      await view(name);
      const handle = page.getByRole("separator", { name: "调整标签区域高度" });
      await handle.focus(); await handle.press("Home");
      assert.equal(await boxHeight(page), 84);
      await handle.press("ArrowDown");
      assert.equal(await boxHeight(page), 94);
      await handle.press("End");
      assert.ok(await boxHeight(page) <= 520);
      await handle.press("Enter");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} fits ${width}px`);
      const result = page.locator(name === "网页" ? ".tag-results" : ".aggregate-content > .library-collection");
      assert.ok((await result.boundingBox()).height >= 150);
      if (width === 320) await page.screenshot({ path: join(out, `filters-${name}-320.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 500 });
  await view("高亮内容");
  await page.getByRole("separator", { name: "调整标签区域高度" }).press("End");
  assert.ok((await page.locator(".aggregate-content > .library-collection").boundingBox()).height >= 150);
  ok("900/480/320 widths, short windows, keyboard height bounds and independently scrollable results stay usable");

  const sidebar = await context.newPage();
  await sidebar.setViewportSize({ width: 380, height: 850 });
  await sidebar.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await sidebar.getByRole("button", { name: "标签", exact: true }).click();
  await sidebar.locator(".result-card").first().waitFor();
  await tag(sidebar, "游戏设计").click();
  assert.equal(await sidebar.locator(".result-card").count(), count("pages", ["tag:0"]));
  const sidebarHeight = await boxHeight(sidebar);
  await dragHeight(sidebar, 100);
  assert.equal(await boxHeight(sidebar), sidebarHeight + 100);
  await sidebar.getByRole("button", { name: "收起标签筛选" }).click();
  assert.ok(await boxHeight(sidebar) < 70);
  assert.equal(await sidebar.locator(".result-card").count(), count("pages", ["tag:0"]));
  await sidebar.reload();
  await sidebar.getByRole("button", { name: "标签", exact: true }).click();
  await sidebar.getByRole("button", { name: "展开标签筛选" }).click();
  assert.equal(await boxHeight(sidebar), sidebarHeight + 100);
  await sidebar.setViewportSize({ width: 320, height: 600 });
  assert.equal(await sidebar.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await sidebar.screenshot({ path: join(out, "filters-sidepanel-320.png"), fullPage: true });
  ok("sidepanel tag view supports mouse resizing, collapse, preserved filtering and persistent independent layout");

  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok((await page.locator(".library-sidebar-footer").textContent()).includes(version));
  assert.deepEqual(errors, []);
  ok(`script build version ${version} and no console/page errors`);
  await writeFile(join(out, "filter-panels-results.json"), JSON.stringify({ checks, errors, fixture }, null, 2));
} finally { await context.close(); }
