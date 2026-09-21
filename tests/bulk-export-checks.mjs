import assert from "node:assert/strict";
import { join } from "node:path";

export async function checkBulkExport(page, out, ok) {
  const consoleErrors = [];
  const onConsole = message => { if (message.type() === "error") consoleErrors.push(message.text()); };
  page.on("console", onConsole);
  const cards = page.locator(".tag-results .result-card");
  const toolbar = page.getByLabel("批量整理", { exact: true });
  const detail = page.getByRole("region", { name: "文章详情", exact: true });
  const first = cards.filter({ has: page.getByRole("button", { name: "游戏的驱动力：目标、反馈与长期成长", exact: true }) });
  const second = cards.filter({ has: page.getByRole("button", { name: "Idle 游戏分类学", exact: true }) });
  const count = n => toolbar.getByText(`已选 ${n} 篇`, { exact: true }).waitFor();
  await page.getByRole("button", { name: "退出多选", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".article-checkbox").length === 0);
  await first.click({ position: { x: 8, y: 8 } });
  const title = await detail.locator(".page-title-row h3").innerText();
  await page.getByRole("button", { name: "多选", exact: true }).click();
  await count(0);
  assert.equal(await page.locator(".tag-results .selected-article").count(), 0);
  assert.equal(await toolbar.getByRole("button", { name: "导出所选网页", exact: true }).count(), 0);
  await first.click({ position: { x: 8, y: 8 } }); await count(1);
  assert.ok((await first.getAttribute("class")).includes("selected-article"));
  await first.locator(".result-category").click(); await count(0);
  await first.locator(".result-comment").click(); await count(1);
  await first.locator(".result-stats").click(); await count(0);
  await first.locator(".article-checkbox").click({ position: { x: 42, y: 8 } }); await count(1);
  await first.getByRole("checkbox").uncheck(); await count(0);
  await first.getByRole("checkbox").focus(); await page.keyboard.press("Space"); await count(1);
  await second.locator(".tag-page-title").click(); await count(2);
  assert.equal(await detail.locator(".page-title-row h3").innerText(), title);
  await second.locator(".tag-page-title").focus(); await page.keyboard.press("Enter"); await count(1);
  await page.keyboard.press("Space"); await count(2);
  assert.equal(await detail.locator(".page-title-row h3").innerText(), title);
  ok("whole-card multi-select toggles body, title, tags, comment and counts once; checkbox/label/keyboard work without changing detail");

  const ids = await page.locator(".tag-results .article-checkbox input:checked").evaluateAll(nodes => nodes.map(n => n.closest("article").dataset.pageId));
  const before = (await page.evaluate(() => chrome.runtime.sendMessage({ type: "snapshot" }))).data;
  await page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    window.__exportRoot = await opfs.getDirectoryHandle(`bulk-export-${crypto.randomUUID()}`, { create: true });
    window.__pickerCalls = [];
    window.showDirectoryPicker = async options => {
      window.__pickerCalls.push({ options, active: navigator.userActivation.isActive });
      return window.__exportRoot;
    };
  });
  const exportButton = () => toolbar.getByRole("button", { name: "导出所选网页", exact: true });
  await exportButton().click();
  await toolbar.getByRole("status").filter({ hasText: "新增 2 个文件" }).waitFor();
  const exported = await page.evaluate(async () => {
    const result = {};
    async function walk(dir, prefix = "") {
      for await (const [name, handle] of dir.entries()) {
        const path = `${prefix}${name}`;
        if (handle.kind === "directory") await walk(handle, `${path}/`);
        else result[path] = await (await handle.getFile()).text();
      }
    }
    await walk(window.__exportRoot);
    return { files: result, calls: window.__pickerCalls };
  });
  assert.equal(exported.calls[0].options.mode, "readwrite");
  assert.equal(exported.calls[0].active, true);
  assert.equal(Object.keys(exported.files).length, 2);
  for (const id of ids) {
    const expected = before.entries[id].page;
    const [path, value] = Object.entries(exported.files).find(([path]) => path.endsWith(`--${id}.json`));
    const prefix = await page.evaluate(createdAt => {
      const d = new Date(createdAt);
      return `data/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/`;
    }, expected.createdAt);
    assert.ok(path.startsWith(prefix));
    assert.equal(value, JSON.stringify(expected, null, 2) + "\n");
  }
  const after = await page.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open("local-web-clipper", 1); r.onsuccess = () => resolve(r.result); });
    const root = await new Promise(resolve => { const r = db.transaction("kv").objectStore("kv").get("root"); r.onsuccess = () => resolve(r.result); });
    db.close();
    return { sameRoot: await root.isSameEntry(await navigator.storage.getDirectory()), library: (await chrome.runtime.sendMessage({ type: "snapshot" })).data };
  });
  assert.equal(after.sameRoot, true);
  assert.deepEqual(after.library.entries, before.entries);
  ok("selected JSON exports use real OPFS files in creation-date directories, preserve all metadata bytes and leave source entries/root unchanged");

  await exportButton().click();
  await toolbar.getByRole("status").filter({ hasText: "内容相同跳过 2 个" }).waitFor();
  assert.equal(await page.getByRole("dialog", { name: "处理导出冲突" }).count(), 0);
  ok("re-exporting identical metadata skips both files without a conflict prompt");
  await checkExportConflicts(page, toolbar, cards, before, ids, exported.files, out, ok);
  await page.evaluate(() => { window.showDirectoryPicker = async () => { throw new DOMException("Cancelled", "AbortError"); }; });
  await exportButton().click(); await toolbar.getByText("已取消导出。", { exact: true }).waitFor();
  assert.equal(await toolbar.getByRole("alert").count(), 0);
  await count(2);
  await page.evaluate(() => { window.showDirectoryPicker = async () => { throw new DOMException("访问被拒绝", "NotAllowedError"); }; });
  await exportButton().click(); await toolbar.getByRole("alert").filter({ hasText: "访问被拒绝" }).waitFor();
  await page.evaluate(() => { window.showDirectoryPicker = () => new Promise((_resolve, reject) => { window.__cancelExport = reject; }); });
  await exportButton().click();
  assert.equal(await toolbar.getByRole("button", { name: "正在导出…" }).isDisabled(), true);
  assert.equal(await toolbar.getByRole("button", { name: "更改主分类", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "退出多选", exact: true }).isDisabled(), true);
  await page.evaluate(() => window.__cancelExport(new DOMException("Cancelled", "AbortError")));
  await toolbar.getByText("已取消导出。", { exact: true }).waitFor();
  ok("picker cancellation, access denial and busy state show accurate results while preserving selection");

  for (const width of [1440, 720, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await exportButton().scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await toolbar.evaluate(n => n.scrollWidth <= n.clientWidth), true);
    await page.screenshot({ path: join(out, `bulk-export-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "退出多选", exact: true }).click();
  await second.locator(".tag-page-title").click();
  await detail.getByRole("heading", { name: "Idle 游戏分类学", exact: true }).waitFor();
  await page.getByRole("button", { name: "多选", exact: true }).click(); await count(0);
  assert.deepEqual(consoleErrors, []);
  page.off("console", onConsole);
  ok("export toolbar fits wide and 320px layouts; exiting multi-select restores normal detail navigation and clears checks");
}

async function checkExportConflicts(page, toolbar, cards, source, selectedIds, originals, out, ok) {
  const firstPath = Object.keys(originals).find(path => path.endsWith(`--${selectedIds[0]}.json`));
  const secondPath = Object.keys(originals).find(path => path.endsWith(`--${selectedIds[1]}.json`));
  const extraId = Object.keys(source.entries).find(id => !selectedIds.includes(id));
  const extraCard = cards.filter({ has: page.getByRole("checkbox", { name: `选择文章：${source.entries[extraId].page.title}`, exact: true }) });
  await extraCard.getByRole("checkbox").check();
  await page.evaluate(async ({ firstPath, secondPath, originals }) => {
    const write = async (path, text) => {
      const parts = path.split("/"); let dir = window.__exportRoot;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const stream = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await stream.write(text); await stream.close();
    };
    window.__writeExport = write;
    const first = JSON.parse(originals[firstPath]), second = JSON.parse(originals[secondPath]);
    first.comment = "旧文件评论，需要人工核对";
    if (first.annotations.length) first.annotations[0].note = "旧批注与新批注不同";
    second.rating = 1; second.comment = "另一个旧文件评论";
    await write(firstPath, JSON.stringify(first)); await write(secondPath, JSON.stringify(second));
    await write("历史副本/duplicate.json", JSON.stringify({ ...first, comment: "第三份旧文件" }));
    await write("identical.JSON", "\uFEFF" + JSON.stringify(JSON.parse(originals[firstPath])));
    await write("keep.txt", "不相关文件保持原样");
    window.__readExport = async () => {
      const files = {};
      async function walk(dir, prefix = "") {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === "directory") await walk(handle, `${prefix}${name}/`);
          else files[`${prefix}${name}`] = await (await handle.getFile()).text();
        }
      }
      await walk(window.__exportRoot); return files;
    };
  }, { firstPath, secondPath, originals });
  const before = await page.evaluate(() => window.__readExport());
  const exportButton = () => toolbar.getByRole("button", { name: "导出所选网页", exact: true });
  const dialog = page.getByRole("dialog", { name: "处理导出冲突", exact: true });
  const conflict = path => dialog.locator(".export-conflict").filter({ has: page.getByRole("checkbox", { name: `批量选择冲突：${path}`, exact: true }) });
  await exportButton().click(); await dialog.waitFor();
  assert.equal(await dialog.locator(".export-conflict").count(), 3);
  await dialog.getByText("1 个新文件 · 1 个内容相同，自动跳过 · 3 个冲突", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "确认并导出", exact: true }).isDisabled(), true);
  if (!(await conflict(firstPath).locator("details").evaluate(node => node.open))) await conflict(firstPath).locator("summary").click();
  await conflict(firstPath).getByText("旧文件评论，需要人工核对", { exact: true }).waitFor();
  await conflict(firstPath).getByText("旧批注与新批注不同", { exact: true }).waitFor();
  await conflict(firstPath).getByRole("radio", { name: "用旧文件", exact: true }).check();
  await conflict(secondPath).getByRole("checkbox").check();
  await conflict("历史副本/duplicate.json").getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "勾选项用新文件", exact: true }).click();
  assert.equal(await conflict(firstPath).getByRole("radio", { name: "用旧文件", exact: true }).isChecked(), true);
  assert.equal(await conflict(secondPath).getByRole("radio", { name: "用新文件", exact: true }).isChecked(), true);
  assert.equal(await dialog.getByRole("button", { name: "确认并导出", exact: true }).isEnabled(), true);
  await dialog.getByRole("button", { name: "全部用新文件", exact: true }).click();
  assert.equal(await dialog.locator('input[type="radio"]:checked').evaluateAll(nodes => nodes.every(n => n.parentElement.textContent === "用新文件")), true);
  await dialog.getByRole("button", { name: "全部用旧文件", exact: true }).click();
  assert.equal(await dialog.locator('input[type="radio"]:checked').evaluateAll(nodes => nodes.every(n => n.parentElement.textContent === "用旧文件")), true);
  for (const width of [1440, 720, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await dialog.locator("h2").scrollIntoViewIfNeeded();
    assert.equal(await dialog.evaluate(n => n.scrollWidth <= n.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(out, `export-conflicts-${width}.png`), fullPage: true });
  }
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__readExport()), before);
  await page.setViewportSize({ width: 1440, height: 960 });
  ok("conflict dialog shows field/note differences, per-file and selected/all decisions, cancellation without writes and 320px layout");

  await exportButton().click(); await dialog.waitFor();
  await dialog.getByRole("button", { name: "全部用旧文件", exact: true }).click();
  await conflict(firstPath).getByRole("checkbox").check();
  await conflict("历史副本/duplicate.json").getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "勾选项用新文件", exact: true }).click();
  await dialog.getByRole("button", { name: "确认并导出", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await toolbar.getByRole("status").filter({ hasText: "新增 1 个文件，替换 2 个文件，内容相同跳过 1 个，保留旧文件 1 个" }).waitFor();
  const result = await page.evaluate(() => window.__readExport());
  assert.equal(result[firstPath], originals[firstPath]);
  assert.equal(result[secondPath], before[secondPath]);
  assert.equal(result["历史副本/duplicate.json"], originals[firstPath]);
  assert.equal(result["identical.JSON"], before["identical.JSON"]);
  assert.equal(result["keep.txt"], before["keep.txt"]);
  assert.equal(Object.keys(result).length, Object.keys(before).length + 1);
  assert.ok(Object.keys(result).some(path => path.endsWith(`--${extraId}.json`)));
  const current = (await page.evaluate(() => chrome.runtime.sendMessage({ type: "snapshot" }))).data;
  assert.deepEqual(current.entries, source.entries);
  ok("mixed decisions write new files, replace only chosen old files, skip equal bytes and preserve source library plus unrelated files");

  await exportButton().click(); await dialog.waitFor();
  assert.equal(await dialog.locator(".export-conflict").count(), 1);
  await page.evaluate(async ({ path, raw }) => { await window.__writeExport(path, JSON.stringify({ ...JSON.parse(raw), comment: "弹窗期间外部修改" })); }, { path: secondPath, raw: before[secondPath] });
  const changed = await page.evaluate(() => window.__readExport());
  await dialog.getByRole("button", { name: "全部用新文件", exact: true }).click();
  await dialog.getByRole("button", { name: "确认并导出", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "相关文件已变化" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__readExport()), changed);
  await dialog.getByRole("button", { name: "取消导出", exact: true }).last().click();
  await dialog.waitFor({ state: "detached" });
  await extraCard.getByRole("checkbox").uncheck();
  ok("changes made to target files while reviewing conflicts stop the entire batch before writes");
}
