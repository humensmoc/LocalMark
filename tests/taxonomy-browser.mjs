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
  if (_req.url === "/site-icon.svg") {
    res.setHeader("Content-Type", "image/svg+xml");
    res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#6656ef"/><path d="M32 10 49 42 32 54 15 42Z" fill="#b7eaff"/></svg>');
    return;
  }
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
        favicon: i === 0 ? `${base}/site-icon.svg` : i === 1 ? `${base}/missing-icon.png` : "",
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
  const snapshot = async (refresh = false) => {
    const response = await rpc(page, { type: "snapshot", refresh });
    assert.equal(response.ok, true, response.error); return response.data;
  };
  await page.getByRole("button", { name: "Idle 游戏分类学", exact: true }).waitFor();
  const modeToolbar = page.getByLabel("批量整理", { exact: true });
  assert.equal(await page.locator(".article-checkbox").count(), 0);
  assert.equal(await modeToolbar.getByText(/已选/).count(), 0);
  assert.equal(await modeToolbar.getByRole("button", { name: /全选当前/ }).count(), 0);
  await page.screenshot({ path: join(out, "selection-default-wide.png"), fullPage: true });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 960 });
    const toolbarBox = await modeToolbar.boundingBox();
    const buttonBox = await modeToolbar.getByRole("button", { name: "多选", exact: true }).boundingBox();
    assert.ok(Math.abs(toolbarBox.x + toolbarBox.width - buttonBox.x - buttonBox.width - 12) <= 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.screenshot({ path: join(out, "selection-default-320.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await modeToolbar.getByRole("button", { name: "多选", exact: true }).click();
  await modeToolbar.getByText("已选 0 篇", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "选择文章：Idle 游戏分类学", exact: true }).check();
  await modeToolbar.getByText("已选 1 篇", { exact: true }).waitFor();
  await modeToolbar.getByRole("button", { name: "添加标签", exact: true }).click();
  await modeToolbar.getByRole("button", { name: "退出多选", exact: true }).click();
  assert.equal(await page.locator(".article-checkbox").count(), 0);
  assert.equal(await modeToolbar.locator("fieldset").count(), 0);
  assert.equal(await modeToolbar.getByText(/已选/).count(), 0);
  await modeToolbar.getByRole("button", { name: "多选", exact: true }).click();
  await modeToolbar.getByText("已选 0 篇", { exact: true }).waitFor();
  assert.equal(await page.locator(".article-checkbox input:checked").count(), 0);
  ok("selection is opt-in, toggle stays right aligned, and exiting clears selection and editor");
  const original = await snapshot(true);
  assert.ok(Object.values(original.entries).every(e => e.page.schemaVersion === 2));
  const catId = original.entries[seeded[0]].page.categoryId;
  const tagId = original.taxonomy.tags.find(t => t.name === "设计方法论").id;
  const dialog = page.getByRole("dialog", { name: "分类与标签管理" });
  await page.getByRole("button", { name: "分类与标签管理", exact: true }).click();
  await dialog.getByRole("button", { name: "管理“游戏设计”", exact: true }).click();
  await dialog.getByRole("textbox", { name: "分类或标签名称" }).fill("玩法研究");
  await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
  await dialog.getByRole("button", { name: "管理“玩法研究”", exact: true }).waitFor();
  let lib = await snapshot(true);
  assert.equal(lib.entries[seeded[0]].page.categoryId, catId);
  assert.equal(lib.entries[seeded[1]].page.categoryId, catId);
  assert.equal(lib.entries[seeded[0]].page.category, "玩法研究");
  assert.equal(await dialog.getByRole("button", { name: "管理“未分类”" }).isDisabled(), true);
  ok("category rename preserves relationships and protects uncategorized");

  await dialog.getByRole("button", { name: "标签", exact: true }).click();
  await dialog.getByRole("textbox", { name: "分类或标签名称" }).fill("待整理");
  await dialog.getByRole("button", { name: "新建", exact: true }).click();
  await dialog.getByRole("button", { name: "管理“待整理”", exact: true }).waitFor();
  const extraId = (await snapshot()).taxonomy.tags.find(t => t.name === "待整理").id;
  await dialog.getByRole("button", { name: "关闭管理" }).click();
  const search = page.getByRole("textbox", { name: "搜索文章", exact: true });
  await search.fill("游戏");
  const bulk = page.getByLabel("批量整理", { exact: true });
  await bulk.getByRole("button", { name: "全选当前筛选结果（2 篇）", exact: true }).click();
  await bulk.getByText("已选 2 篇", { exact: true }).waitFor();
  await bulk.getByRole("button", { name: "添加标签", exact: true }).click();
  await bulk.getByRole("checkbox", { name: /待整理/ }).check();
  await bulk.getByRole("button", { name: "应用到所选网页（2 篇有变化）", exact: true }).click();
  await bulk.getByText(/已修改 2 篇/).waitFor();
  lib = await snapshot(true);
  assert.ok(lib.entries[seeded[0]].page.tagIds.includes(extraId));
  assert.ok(lib.entries[seeded[1]].page.tagIds.includes(extraId));
  assert.deepEqual(lib.entries[seeded[2]].page.tagIds, original.entries[seeded[2]].page.tagIds);
  assert.deepEqual(lib.entries[seeded[0]].page.annotations, original.entries[seeded[0]].page.annotations);
  ok("filtered bulk additions preserve unselected pages, other tags and annotations");

  await bulk.getByRole("button", { name: "全选当前筛选结果（2 篇）", exact: true }).click();
  await bulk.getByRole("button", { name: "移除标签", exact: true }).click();
  await bulk.getByRole("checkbox", { name: /设计方法论/ }).check();
  await bulk.getByRole("button", { name: "应用到所选网页（2 篇有变化）", exact: true }).click();
  await bulk.getByText(/已修改 2 篇/).waitFor();
  lib = await snapshot(true);
  assert.ok(!lib.entries[seeded[0]].page.tagIds.includes(tagId));
  assert.ok(lib.entries[seeded[0]].page.tagIds.includes(extraId));
  assert.ok(lib.taxonomy.tags.some(x => x.id === tagId), "bulk remove must not delete the global tag");
  ok("bulk removal removes only the selected relationships and retains the global tag");

  await bulk.getByRole("button", { name: "全选当前筛选结果（2 篇）", exact: true }).click();
  await search.fill("");
  await page.getByLabel("批量整理", { exact: true }).getByText("已选 0 篇", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "选择文章：没有标签的收藏", exact: true }).check();
  await bulk.getByRole("button", { name: "更改主分类", exact: true }).click();
  await bulk.getByRole("radio", { name: "玩法研究", exact: true }).check();
  await bulk.getByRole("button", { name: "应用到所选网页（1 篇有变化）", exact: true }).click();
  await bulk.getByText(/已修改 1 篇/).waitFor();
  assert.equal((await snapshot(true)).entries[seeded[3]].page.categoryId, catId);
  ok("changing search clears selection and bulk category changes use IDs");

  const filter = page.getByRole("group", { name: "主分类筛选", exact: true });
  await filter.getByRole("button", { name: /玩法研究/ }).click();
  await page.getByRole("button", { name: "分类与标签管理", exact: true }).click();
  await dialog.getByRole("button", { name: "管理“玩法研究”", exact: true }).click();
  await dialog.getByRole("textbox", { name: "分类或标签名称" }).fill("游戏研究");
  await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
  await dialog.getByRole("button", { name: "管理“游戏研究”", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "关闭管理" }).click();
  await filter.getByRole("button", { name: /游戏研究/ }).waitFor();
  assert.equal(await filter.getByRole("button", { name: /游戏研究/ }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".result-card").count(), 3);
  ok("active category filters survive renaming by keeping their IDs");

  await page.getByRole("button", { name: "分类与标签管理", exact: true }).click();
  await dialog.getByRole("button", { name: "管理“游戏研究”", exact: true }).click();
  page.once("dialog", d => d.accept());
  await dialog.getByRole("button", { name: "删除主分类", exact: true }).click();
  await dialog.getByRole("button", { name: "管理“游戏研究”", exact: true }).waitFor({ state: "hidden" });
  await dialog.getByRole("button", { name: "关闭管理" }).click();
  lib = await snapshot(true);
  assert.equal(lib.entries[seeded[0]].page.categoryId, "category:uncategorized");
  assert.ok(!lib.taxonomy.categories.some(x => x.id === catId));
  await page.reload();
  await page.getByRole("button", { name: "分类与标签管理", exact: true }).click();
  assert.equal(await dialog.getByRole("button", { name: "管理“游戏设计”", exact: true }).count(), 0);
  await dialog.getByRole("button", { name: "标签", exact: true }).click();
  await dialog.getByRole("button", { name: "管理“设计方法论”", exact: true }).waitFor();
  ok("deleting an occupied category moves articles to uncategorized and does not resurrect defaults on reload");

  await dialog.getByRole("button", { name: "管理“待整理”", exact: true }).click();
  await dialog.getByRole("textbox", { name: "分类或标签名称" }).fill("成长系统");
  page.once("dialog", d => d.accept());
  await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
  await dialog.getByRole("button", { name: "管理“待整理”", exact: true }).waitFor({ state: "hidden" });
  lib = await snapshot(true);
  const growth = lib.taxonomy.tags.find(x => x.name === "成长系统").id;
  assert.equal(lib.entries[seeded[0]].page.tagIds.filter(id => id === growth).length, 1);
  assert.ok(lib.entries[seeded[1]].page.tagIds.includes(growth));
  ok("renaming to an existing tag offers an explicit merge and deduplicates references");

  await page.screenshot({ path: join(out, "taxonomy-management-wide.png"), fullPage: true });
  for (const width of [900, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await page.screenshot({ path: join(out, `taxonomy-management-${width}.png`), fullPage: true });
  }
  await dialog.getByRole("button", { name: "关闭管理" }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  assert.equal(await page.locator(".article-checkbox").count(), 0);
  await bulk.getByRole("button", { name: "多选", exact: true }).click();
  await bulk.getByRole("button", { name: "全选当前筛选结果（4 篇）", exact: true }).click();
  await bulk.getByRole("button", { name: "添加标签", exact: true }).click();
  await page.screenshot({ path: join(out, "taxonomy-bulk-wide.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 850 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(out, "taxonomy-bulk-320.png"), fullPage: true });
  ok("management dialog and bulk toolbar fit wide, medium, 390px and 320px layouts");
  assert.deepEqual(errors, []);
  ok("no uncaught browser errors");
  await writeFile(join(out, "taxonomy-results.json"), JSON.stringify({ checks, errors }, null, 2));
} finally {
  await context.close();
  server.close();
}
