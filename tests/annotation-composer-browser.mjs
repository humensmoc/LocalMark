import { chromium } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";

const out = resolve("test-results/annotation-composer");
await mkdir(out, { recursive: true });
const fixture = await readFile("tests/fixture.html", "utf8");
const server = createServer((req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(fixture); });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/article`;
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "localmark-composer-")), {
  channel: "chromium", headless: true, viewport: { width: 1200, height: 850 },
  args: ["--enable-unsafe-extension-debugging"], ignoreDefaultArgs: ["--disable-extensions"],
});
const errors = [], checks = [];
context.on("page", page => {
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
});
const ok = name => { checks.push(name); console.log("PASS", name); };
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 60)); } throw Error("condition timed out"); }
async function reveal(page) {
  const cdp = await context.newCDPSession(page), worlds = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => worlds.push(context));
  await cdp.send("Runtime.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  function find(n) {
    if (n.attributes?.includes("local-web-clipper-root")) return n;
    for (const child of [...n.children ?? [], ...n.shadowRoots ?? []]) { const hit = find(child); if (hit) return hit; }
  }
  const host = find(root);
  for (const executionContextId of [undefined, worlds.find(c => c.name.includes("playwright"))?.id]) {
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: host.shadowRoots[0].backendNodeId, executionContextId });
    await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: 'function(){const root=this;Object.defineProperty(this.host,"shadowRoot",{get:()=>root,configurable:true});}' });
  }
  await cdp.detach();
}
try {
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send("Extensions.loadUnpacked", { path: resolve("dist") });
  await cdp.detach(); await manager.close();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const settings = await context.newPage(); await settings.goto(origin + "/settings.html");
  const state = async () => (await settings.evaluate(() => chrome.runtime.sendMessage({ type: "snapshot" }))).data;
  const marks = async () => Object.values((await state()).entries).find(e => e.page.url === url)?.page.annotations ?? [];
  const page = await context.newPage(); await page.goto(url);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
  await page.locator("#local-web-clipper-root").waitFor(); await reveal(page);
  const host = page.locator("#local-web-clipper-root"), editor = host.locator(".editor"), note = host.locator("#wc-note");
  const finish = async () => editor.evaluate(el => el.getAnimations().forEach(a => a.finish()));
  async function select(selector = "#first b") {
    await page.locator(selector).scrollIntoViewIfNeeded();
    const b = await page.locator(selector).boundingBox();
    await page.mouse.move(b.x + 1, b.y + b.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 8 }); await page.mouse.up();
    await editor.waitFor(); await finish();
    return { x: b.x + b.width - 1, y: b.y + b.height / 2 };
  }
  const point = await select();
  assert.equal(await host.locator(".quick").count(), 0);
  assert.equal(await editor.locator(".swatch").count(), 3);
  assert.equal(await note.evaluate(el => el.getRootNode().activeElement === el), false);
  assert.equal(await page.evaluate(() => getSelection()?.toString()), "Highlight this passage");
  await page.keyboard.press("ControlOrMeta+C");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Highlight this passage");
  assert.equal((await note.boundingBox()).height, 36);
  const assertSaveOverlay = async () => {
    assert.equal(await editor.locator(".composer-help, .composer-excerpt").count(), 0);
    assert.equal(await editor.getByRole("button", { name: "取消", exact: true }).count(), 0);
    const button = editor.getByRole("button", { name: "保存", exact: true });
    await until(async () => {
      const a = await note.boundingBox(), b = await button.boundingBox();
      const p = await note.evaluate(el => parseFloat(getComputedStyle(el).paddingRight));
      return a && b && a.x + a.width - p <= b.x + 1;
    });
    const area = await note.boundingBox(), box = await button.boundingBox();
    assert.ok(box.x > area.x && box.y >= area.y && box.x + box.width < area.x + area.width && box.y + box.height < area.y + area.height);
    assert.ok(area.y + area.height - box.y - box.height <= 10, "save stays in the textarea bottom-right corner");
    assert.equal(await button.evaluate(el => { const r = el.getBoundingClientRect(); return el.getRootNode().elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("button") === el; }), true);
    const padding = await note.evaluate(el => parseFloat(getComputedStyle(el).paddingRight));
    assert.ok(area.x + area.width - padding <= box.x, "text leaves room for the overlaid button");
  };
  assert.equal(await editor.getByRole("button", { name: "保存", exact: true }).count(), 0);
  const compact = await editor.boundingBox();
  assert.ok(Math.abs(compact.x - point.x - 8) < 2 && Math.abs(compact.y - point.y - 8) < 2);
  await page.screenshot({ path: join(out, "compact.png") });
  ok("real text drag leaves the page selection available for Ctrl+C while showing the compact composer");
  await page.keyboard.type("x");
  assert.equal(await note.evaluate(el => el.getRootNode().activeElement === el), true);
  assert.equal(await note.inputValue(), "x");
  await note.fill("");
  await page.keyboard.insertText("直接输入的批注");
  assert.ok((await note.boundingBox()).height >= 100);
  await page.keyboard.press("Shift+Enter"); await page.keyboard.insertText("第二行");
  const expected = "直接输入的批注\n第二行";
  assert.equal(await note.inputValue(), expected);
  await note.dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true });
  assert.equal((await marks()).length, 0);
  const before = await editor.boundingBox(), grip = await editor.locator(".composer-grip").boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 130, grip.y + grip.height / 2 + 90, { steps: 10 }); await page.mouse.up();
  const after = await editor.boundingBox();
  assert.ok(Math.abs(after.x - before.x + 130) < 2 && Math.abs(after.y - before.y - 90) < 2);
  assert.equal(await note.evaluate(el => el.getRootNode().activeElement === el), true);
  await page.keyboard.insertText("。"); await page.keyboard.press("Backspace");
  assert.deepEqual(await editor.boundingBox(), after);
  await assertSaveOverlay();
  await page.screenshot({ path: join(out, "expanded-dragged.png") });
  await editor.getByRole("button", { name: "保存", exact: true }).click(); await until(async () => (await marks()).length === 1);
  await editor.waitFor({ state: "detached" });
  assert.equal((await marks())[0].note, expected);
  ok("typing expands, Chinese composition does not submit, multiline save-button and dragging preserve focus and text");
  await page.locator("#first b").click(); await editor.waitFor(); await finish();
  assert.equal(await note.inputValue(), expected);
  const deletion = editor.getByRole("button", { name: "删除", exact: true });
  assert.equal(await deletion.evaluate(el => !!el.closest(".editor-header")), true);
  assert.equal(await editor.locator(".editor-foot").count(), 0);
  const header = await editor.locator(".editor-header").boundingBox(), del = await deletion.boundingBox();
  assert.ok(del.y >= header.y && del.y + del.height <= header.y + header.height);
  await page.screenshot({ path: join(out, "existing-top-delete.png") });
  await editor.getByLabel("粉色", { exact: true }).click(); await until(async () => (await marks())[0].color === "pink");
  await editor.waitFor({ state: "detached" });
  assert.equal((await marks()).length, 1);
  ok("clicking an existing highlight uses the same composer; choosing a color updates it without duplicating or losing the note");

  await settings.bringToFront();
  const palette = settings.locator(".highlight-settings");
  await palette.locator('input[type="color"]').first().fill("#123456");
  await palette.getByRole("button", { name: "移除颜色 3", exact: true }).click();
  await palette.getByRole("button", { name: "移除颜色 2", exact: true }).click();
  await palette.getByRole("button", { name: "保存浮窗设置", exact: true }).click();
  await until(async () => (await state()).highlightPalette?.join() === "#123456");
  await page.bringToFront(); await select("#repeat-a");
  await until(async () => await editor.locator(".swatch").count() === 1);
  await note.click(); assert.ok((await note.boundingBox()).height >= 100);
  await editor.getByLabel("#123456", { exact: true }).click();
  await until(async () => (await marks()).length === 2); await editor.waitFor({ state: "detached" });
  assert.equal((await marks())[1].color, "#123456");
  await page.reload(); await page.locator("#local-web-clipper-root").waitFor(); await reveal(page);
  await until(() => page.evaluate(() => CSS.highlights.has("wc-hex-123456")));
  assert.equal(await page.locator("#repeat-a").evaluate(el => getComputedStyle(el, "::highlight(wc-hex-123456)").backgroundColor), "rgb(18, 52, 86)");
  assert.equal(await page.locator("#repeat-a").evaluate(el => getComputedStyle(el, "::highlight(wc-note-hex-123456)").textDecorationStyle), "wavy");
  assert.equal(await page.evaluate(() => [...CSS.highlights.get("wc-note-hex-123456")].length), 0);
  assert.equal((await marks())[0].color, "pink");
  ok("custom color and one-color palette apply live, persist after reload, and render without changing older highlights");

  await settings.bringToFront(); await settings.reload();
  await until(async () => await palette.locator('input[type="color"]').count() === 1);
  assert.equal(await palette.locator('input[type="color"]').inputValue(), "#123456");
  for (let i = 1; i < 8; i++) await palette.getByRole("button", { name: "添加颜色", exact: true }).click();
  assert.equal(await palette.getByRole("button", { name: "添加颜色", exact: true }).isDisabled(), true);
  await palette.getByRole("button", { name: "保存浮窗设置", exact: true }).click();
  await until(async () => (await state()).highlightPalette?.length === 8);
  await settings.setViewportSize({ width: 320, height: 850 });
  await palette.scrollIntoViewIfNeeded();
  assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await settings.screenshot({ path: join(out, "settings-320.png") });
  await page.bringToFront(); await page.setViewportSize({ width: 320, height: 450 });
  // Real single-line selection near the bottom-right corner of a short viewport.
  await page.evaluate(() => { const p = document.createElement("p"); p.id = "edge"; p.textContent = "Edge selection"; p.style.cssText = "position:fixed;right:3px;bottom:10px;white-space:nowrap"; document.body.append(p); });
  await select("#edge");
  await until(async () => await editor.locator(".swatch").count() === 8);
  await note.click();
  await page.keyboard.insertText("窄屏也可以输入很长的批注。".repeat(15));
  await until(async () => { const b = await editor.boundingBox(); return b.x >= 11 && b.y >= 11 && b.x + b.width <= 309 && b.y + b.height <= 439; });
  const edge = await editor.boundingBox();
  assert.ok(edge.x >= 11 && edge.y >= 11 && edge.x + edge.width <= 309 && edge.y + edge.height <= 439);
  assert.equal(await editor.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await editor.locator(".swatch").last().scrollIntoViewIfNeeded();
  assert.equal(await editor.getByLabel("关闭编辑窗").evaluate(el => { const r = el.getBoundingClientRect(); return el.getRootNode().elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("button") === el; }), true, "page tools must not cover the composer close button");
  await assertSaveOverlay();
  await page.screenshot({ path: join(out, "expanded-320.png") });
  await page.keyboard.press("Escape"); await editor.waitFor({ state: "detached" });
  assert.equal((await marks()).length, 2);
  ok("eight-color palette scrolls within narrow layouts; bottom/right positioning, long input and Escape cancellation work");

  const dashboard = await context.newPage(); await dashboard.goto(origin + "/dashboard.html");
  await dashboard.getByRole("button", { name: /^颜色/ }).click();
  await dashboard.getByRole("button", { name: /#123456/ }).click();
  assert.ok((await dashboard.locator(".catalog-detail").innerText()).includes("#123456"));
  assert.equal(await dashboard.locator(".catalog-color").last().evaluate(el => getComputedStyle(el).backgroundColor), "rgb(18, 52, 86)");
  ok("custom saved colors remain available in the library color view");
  await page.bringToFront();
  await page.locator("#repeat-a").scrollIntoViewIfNeeded();
  const highlightedPoint = await page.locator("#repeat-a").evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const rect = range.getClientRects()[0];
    return { x: rect.x + 12, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(highlightedPoint.x, highlightedPoint.y); await editor.waitFor(); await finish();
  assert.equal(await editor.getByRole("button", { name: "保存", exact: true }).count(), 0, "an empty existing note is compact too");
  assert.equal(await editor.locator(".editor-header .composer-delete").count(), 1);
  assert.equal(await editor.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: join(out, "existing-compact-320.png") });
  await note.click(); await assertSaveOverlay();
  await editor.getByRole("button", { name: "删除", exact: true }).click();
  await until(async () => (await marks()).length === 1);
  assert.equal((await marks())[0].note, expected);
  await editor.waitFor({ state: "detached" });
  ok("top-row deletion works at 320px; compact new/existing notes hide save until expansion");
  assert.deepEqual(errors, []);
  await writeFile(join(out, "results.json"), JSON.stringify({ version: JSON.parse(await readFile("package.json", "utf8")).version, checks, errors }, null, 2));
} finally { await context.close(); await new Promise(r => server.close(r)); }
