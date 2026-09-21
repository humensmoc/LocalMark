import { checkGroupedContent } from "./grouped-content-checks.mjs";
import { checkSharedPageCards } from "./shared-page-cards-checks.mjs";
import { chromium } from "playwright";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const out = resolve("test-results");
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "localmark-catalog-"));
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
let releaseArtwork;
const artworkReady = new Promise(resolve => { releaseArtwork = resolve; });
try {
  await context.route("https://example.com/delayed.svg", async route => {
    await artworkReady;
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#4095d0"/></svg>' });
  });
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
      const tagIndices = [...new Set([index % 76, ...(index < 120 ? [0] : []), ...(index % 2 ? [1] : []), ...(index % 3 ? [8] : [])])];
      const annotations = Array.from({ length: index === 0 ? 22 : index % 6 }, (_, markIndex) => ({
        id: crypto.randomUUID(), text: `摘录 ${markIndex + 1}：从清晰的目标与反馈理解设计。` + "长短内容混合，保留完整摘录。".repeat(markIndex % 4 === 0 ? 100 : markIndex % 4), note: markIndex % 3 ? "结合项目验证这条观点。".repeat(markIndex % 4 === 1 ? 100 : 1) : "", tags: [], color: "yellow",
        anchor: { exact: "设计", prefix: "", suffix: "", start: markIndex * 10, end: markIndex * 10 + 2 }, createdAt: time, updatedAt: new Date(Date.parse(time) - markIndex * 60000).toISOString(),
      }));
      entries[id] = { page: { schemaVersion: 2, id, url: `https://example.com/${index}`, originalUrl: `https://example.com/${index}`,
        title: `${names[categoryIndex]}参考 ${j + 1}：理解规则、结构与反馈`, categoryId: categories[categoryIndex].id, category: names[categoryIndex],
        tags: tagIndices.map(i => tags[i].name), tagIds: tagIndices.map(i => tags[i].id), annotations, comment: index === 6 ? "" : "围绕设计方法与实践案例，梳理值得长期积累的知识。".repeat(4),
        favicon: index === 6 ? "https://example.com/delayed.svg" : "", folderName: `文章--${id}`, rating: index % 5 + 1, createdAt: time, updatedAt: time }, baseJson: null, baseMd: null, dirty: true, mdDirty: true };
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
  await page.reload();
  const navigation = page.getByRole("navigation", { name: "资料库视图" });
  const view = name => navigation.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  const toggle = name => page.getByRole("group", { name: "展示方式" }).getByRole("button", { name, exact: true });
  await page.locator(".result-card").first().waitFor();
  assert.equal(await page.locator(".result-card details, .result-card summary").count(), 0);
  const card = page.locator(".result-card").first();
  assert.equal(await card.locator(".result-stats").getAttribute("aria-label"), "22 条高亮，14 条批注");
  assert.ok(await card.locator(".result-stats strong").first().evaluate(node => parseFloat(getComputedStyle(node).fontSize)) >= 24);
  await card.locator(".result-stats").click();
  assert.equal(await page.locator(".mark-preview").count(), 22);
  await page.screenshot({ path: join(out, "catalog-page-counts.png"), fullPage: true });
  ok("large accurate highlight/note counters replace both expanders; clicking still opens full details");

  await checkGroupedContent(page, view, out);
  ok("webpage groups, first-card metadata, complete notes, source links, search/filter promotion, responsive order and reload");
  await checkSharedPageCards({ page, context, view, out, releaseArtwork });
  ok("sidebar recent/tag cards match dashboard webpage cards in metadata, typography, colors, counters and rating placement; narrow layouts fit");

  await view("主分类");
  assert.equal(await toggle("卡片").getAttribute("aria-pressed"), "true");
  await toggle("占比图").click();
  await page.locator(".treemap-tile").first().waitFor();
  assert.equal(await page.locator(".treemap-tile").count(), 24);
  assert.equal(await page.locator(".treemap-zero button").count(), 2);
  assert.equal(await page.locator(".treemap-heading strong").textContent(), String(fixture.pageCount));
  const verifyGeometry = async () => {
    const geometry = await page.locator(".treemap-canvas").evaluate(node => ({
      width: node.clientWidth, height: node.clientHeight,
      tiles: [...node.querySelectorAll(".treemap-tile")].map(tile => ({ x: parseFloat(tile.style.left), y: parseFloat(tile.style.top), width: parseFloat(tile.style.width), height: parseFloat(tile.style.height), count: Number(tile.querySelector(".treemap-value strong").textContent) })),
    }));
    const sum = geometry.tiles.reduce((n, tile) => n + tile.count, 0);
    for (const [i, tile] of geometry.tiles.entries()) {
      assert.ok(Math.abs(tile.width * tile.height / (geometry.width * geometry.height) - tile.count / sum) < 0.00001);
      assert.ok(tile.x >= 0 && tile.y >= 0 && tile.x + tile.width <= geometry.width + 0.01 && tile.y + tile.height <= geometry.height + 0.01);
      for (const other of geometry.tiles.slice(i + 1)) assert.ok(Math.min(tile.x + tile.width, other.x + other.width) - Math.max(tile.x, other.x) < 0.01 || Math.min(tile.y + tile.height, other.y + other.height) - Math.max(tile.y, other.y) < 0.01);
    }
  };
  await verifyGeometry();
  const categoryColors = await page.locator(".treemap-tile").evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute("aria-label"), color: node.style.getPropertyValue("--tile-color") })));
  assert.equal(new Set(categoryColors.slice(0, 10).map(item => item.color)).size, 10, "largest categories have distinct hues");
  await page.screenshot({ path: join(out, "catalog-treemap-wide.png"), fullPage: true });
  await page.locator(".treemap-tile").filter({ hasText: "游戏设计" }).click();
  await page.locator(".catalog-detail h2").filter({ hasText: "游戏设计" }).waitFor();
  await page.getByRole("button", { name: "筛选网页", exact: true }).click();
  assert.match(await page.locator(".result-heading").textContent(), /52 个网页/);
  await view("主分类");
  assert.equal(await toggle("占比图").getAttribute("aria-pressed"), "true");
  await page.getByRole("textbox", { name: "搜索主分类" }).fill("前端设计");
  assert.equal(await page.locator(".treemap-tile").count(), 1);
  assert.equal(await page.locator(".treemap-tile").evaluate(el => el.style.getPropertyValue("--tile-color")), categoryColors.find(item => item.label.startsWith("前端设计 ·")).color, "search keeps the category color");
  assert.match(await page.locator(".treemap-tile").getAttribute("aria-label"), /100%/);
  await verifyGeometry();
  await page.getByRole("textbox", { name: "搜索主分类" }).fill("不存在的分类");
  await page.getByRole("heading", { name: "没有匹配的内容" }).waitFor();
  await page.getByRole("textbox", { name: "搜索主分类" }).fill("视觉设计");
  await page.locator(".treemap-empty").waitFor();
  await page.locator(".treemap-zero button").click();
  await page.locator(".catalog-detail h2").filter({ hasText: "视觉设计" }).waitFor();
  await page.getByRole("textbox", { name: "搜索主分类" }).fill("");
  ok("true category proportions, selection/filtering, zero entries, search percentages and empty states");

  const divider = page.getByRole("separator", { name: "调整内容列表与详情宽度" });
  const before = (await page.locator(".treemap-canvas").boundingBox()).width;
  await divider.focus();
  await divider.press("ArrowLeft");
  await page.waitForFunction(width => document.querySelector(".treemap-canvas").clientWidth !== width, Math.round(before));
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".treemap-canvas");
    const area = [...canvas.querySelectorAll(".treemap-tile")].reduce((sum, tile) => sum + parseFloat(tile.style.width) * parseFloat(tile.style.height), 0);
    return Math.abs(area - canvas.clientWidth * canvas.clientHeight) < 1;
  });
  await verifyGeometry();
  ok("treemap recomputes when dashboard column width changes");

  await view("子标签");
  assert.equal(await toggle("卡片").getAttribute("aria-pressed"), "true");
  await toggle("占比图").click();
  await page.locator(".treemap-tile").first().waitFor();
  assert.equal(await page.locator(".treemap-tile").count(), 76);
  const tagColors = await page.locator(".treemap-tile").evaluateAll(nodes => nodes.slice(0, 10).map(node => node.style.getPropertyValue("--tile-color")));
  assert.equal(new Set(tagColors).size, 10, "largest tags have distinct hues");
  assert.equal(await page.locator(".treemap-heading strong").textContent(), String(fixture.tagTotal));
  assert.match(await page.locator(".treemap-hint").textContent(), /同一网页可计入多个标签/);
  await verifyGeometry();
  await page.screenshot({ path: join(out, "catalog-tags-wide.png"), fullPage: true });
  await page.locator(".treemap-breakdown summary").click();
  assert.equal(await page.locator(".treemap-ranking button").count(), 76);
  const last = page.locator(".treemap-ranking button").last();
  await last.focus();
  await last.press("Enter");
  assert.equal(await last.getAttribute("aria-pressed"), "true");
  await page.locator(".treemap-breakdown summary").click();
  for (const width of [900, 480, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".treemap-canvas");
      const tiles = [...canvas.querySelectorAll(".treemap-tile")];
      return Math.abs(tiles.reduce((sum, tile) => sum + parseFloat(tile.style.width) * parseFloat(tile.style.height), 0) - canvas.clientWidth * canvas.clientHeight) < 1;
    });
    await verifyGeometry();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(out, `catalog-tags-${width}.png`), fullPage: true });
  }
  await page.reload();
  await view("子标签");
  assert.equal(await toggle("占比图").getAttribute("aria-pressed"), "true");
  await toggle("卡片").click();
  await page.waitForFunction(() => document.querySelectorAll(".catalog-card").length === 77);
  assert.equal(await page.locator(".catalog-card").count(), 77);
  await view("主分类");
  assert.equal(await toggle("占比图").getAttribute("aria-pressed"), "true");
  await view("颜色");
  assert.equal(await page.getByRole("group", { name: "展示方式" }).count(), 0);
  assert.equal(await page.locator(".catalog-card").count(), 5);
  ok("multi-tag denominator, accessible count list, 900/480/320 layouts, independent saved modes and color view unchanged");
  await view("网页");
  assert.equal(await page.locator(".result-card details, .result-card summary").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(out, "catalog-page-counts-320.png"), fullPage: true });
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(await page.locator(".library-sidebar-footer").textContent(), new RegExp(version.replaceAll(".", "\\.")));
  assert.deepEqual(errors, []);
  ok(`build version ${version}, narrow cards and no console/page errors`);
  await writeFile(join(out, "catalog-results.json"), JSON.stringify({ checks, errors, fixture }, null, 2));
} finally { await context.close(); }
