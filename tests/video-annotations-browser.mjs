import { fixture } from "./video-native-fixture.mjs";
import { chromium } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const out = resolve("test-results/video-annotations");
await mkdir(out, { recursive: true });
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "lm-video-marks-")), {
  channel: "chromium", headless: true, viewport: { width: 1440, height: 900 },
  args: ["--enable-unsafe-extension-debugging"], ignoreDefaultArgs: ["--disable-extensions"],
});
const report = { checks: [], errors: [] };
const wave = Buffer.alloc(44 + 8000 * 2 * 30);
wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
await context.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.protocol === "chrome-extension:") return route.continue();
  if (url.pathname === "/test.wav") {
    const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : wave.length - 1;
    return route.fulfill({ status: range ? 206 : 200, headers: { "content-type": "audio/wav", "accept-ranges": "bytes",
      ...(range ? { "content-range": `bytes ${start}-${end}/${wave.length}` } : {}) }, body: wave.subarray(start, end + 1) });
  }
  if (url.pathname.includes("/youtubei/")) {
    const language = route.request().postDataJSON().params;
    return route.fulfill({ json: { items: Array.from({ length: 20 }, (_, index) => ({ transcriptSegmentRenderer: {
      startMs: String(index * 1000), endMs: String((index + 1) * 1000),
      snippet: { runs: [{ text: `${language} sentence ${index}` }] },
    } })), footer: { subMenuItems: ["en", "zh"].map(id => ({ title: id === "en" ? "English" : "中文",
      selected: id === language, continuation: { reloadContinuationData: { continuation: id } } })) } } });
  }
  if (url.hostname === "www.youtube.com") return route.fulfill({ contentType: "text/html", body: fixture("youtube") });
  return route.abort();
});
const until = async (condition, label) => {
  for (let index = 0; index < 120; index++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`Timeout: ${label}`);
};
try {
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await (await context.browser().newBrowserCDPSession()).send("Extensions.loadUnpacked", { path: resolve("dist") });
  await manager.close();
  await until(() => context.serviceWorkers().length > 0, "service worker");
  const extensionOrigin = context.serviceWorkers()[0].url().match(/^chrome-extension:\/\/[^/]+/)[0];
  const settings = await context.newPage();
  await settings.goto(`${extensionOrigin}/settings.html`);
  await settings.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("LocalMark QA", { create: true });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("local-web-clipper", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(root, "pendingRoot");
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    const reply = await chrome.runtime.sendMessage({ type: "directory-connected" });
    if (!reply.ok) throw Error(reply.error);
    const markdown = await chrome.runtime.sendMessage({ type: "auto-generate-markdown", enabled: true });
    if (!markdown.ok) throw Error(markdown.error);
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.stack ?? error.message));
  await page.goto("https://www.youtube.com/watch?v=first");
  const panel = page.locator("#localmark-video-transcript");
  await until(async () => await panel.locator(".cue").count() === 20, "subtitle cues");
  await page.bringToFront();
  await page.keyboard.press("Shift+Enter");
  assert.equal(await panel.getByLabel("当前字幕批注").evaluate(input => input.getRootNode().activeElement === input), true);
  await page.evaluate(() => {
    window.siteShortcutKeys = [];
    for (const type of ["keydown", "keyup", "keypress"])
      window.addEventListener(type, event => window.siteShortcutKeys.push(`${type}:${event.key}`), true);
  });
  await page.keyboard.type("快捷输入");
  await page.keyboard.press("Space");
  await page.keyboard.press("k");
  assert.equal(await panel.getByLabel("当前字幕批注").inputValue(), "快捷输入 k");
  assert.deepEqual(await page.evaluate(() => window.siteShortcutKeys), [], "Typing in the video note must not reach website shortcuts");
  await page.keyboard.press("Shift+Enter");
  assert.equal(await panel.getByLabel("当前字幕批注").inputValue(), "快捷输入 k\n");
  await panel.getByLabel("当前字幕批注").fill("");
  await panel.getByRole("button", { name: "搜索字幕" }).click();
  await page.evaluate(() => { window.siteShortcutKeys = []; });
  await page.keyboard.type("k ");
  assert.equal(await panel.getByLabel("在字幕中搜索").inputValue(), "k ");
  assert.deepEqual(await page.evaluate(() => window.siteShortcutKeys), [], "Typing in transcript search must not reach website shortcuts");
  await panel.getByRole("button", { name: "收起搜索" }).click();
  await page.mouse.click(5, 5);
  report.checks.push("Shift+Enter focuses the current subtitle note on a video page");
  const drag = await page.evaluate(() => {
    const root = document.querySelector("#localmark-video-transcript").shadowRoot;
    const cues = root.querySelectorAll(".cue");
    return [cues[0], cues[1]].map((cue, index) => {
      const range = document.createRange(); range.setStart(cue.firstChild, index ? 7 : 3); range.collapse(true);
      const rect = range.getBoundingClientRect(); return { x: rect.x, y: rect.y + rect.height / 2 };
    });
  });
  await page.mouse.move(drag[0].x, drag[0].y);
  await panel.locator(".cue-time-popup").waitFor();
  const timeRect = await panel.locator(".cue-time-button").boundingBox();
  assert(timeRect, "hover timestamp should be visible before selecting");
  await page.mouse.down();
  await until(async () => await panel.locator(".cue-time-popup").count() === 0, "timestamp hidden during text selection");
  await page.mouse.move(timeRect.x + timeRect.width / 2, timeRect.y + timeRect.height / 2);
  await page.mouse.move(drag[1].x, drag[1].y, { steps: 8 });
  const selectedText = await page.evaluate(() => document.querySelector("#localmark-video-transcript").shadowRoot.getSelection().toString());
  assert(!selectedText.includes("0:00"), "timestamp text must stay out of the subtitle selection");
  await page.mouse.up();
  await until(async () => await panel.locator(".video-editor").count() === 1, "real mouse selection popup");
  assert.equal(await page.evaluate(() => document.querySelector("#localmark-video-transcript").shadowRoot.getSelection().toString()), selectedText);
  assert.equal(await panel.locator(".video-editor textarea").evaluate(el => el.getRootNode().activeElement === el), false);
  await page.evaluate(() => { window.siteShortcutKeys = []; });
  await page.keyboard.type("x");
  assert.equal(await panel.locator(".video-editor textarea").inputValue(), "x");
  assert.deepEqual(await page.evaluate(() => window.siteShortcutKeys), [], "The first key focusing a selection note must not reach website shortcuts");
  await page.mouse.click(5, 5);
  await until(async () => await panel.locator(".video-editor").count() === 0, "outside click closes video editor");
  await page.keyboard.press("k");
  assert((await page.evaluate(() => window.siteShortcutKeys)).includes("keydown:k"), "Page shortcuts remain available outside the video editor");
  report.checks.push("subtitle selection stays available and an outside click closes the video editor");
  await page.mouse.move(drag[0].x, drag[0].y);
  await panel.locator(".cue-time-popup").waitFor();
  const timeButton = panel.locator(".cue-time-button");
  const plainTimeStyle = await timeButton.evaluate(button => ({
    background: getComputedStyle(button).backgroundColor,
    border: getComputedStyle(button).borderColor,
    shadow: getComputedStyle(button).boxShadow,
  }));
  const hoverTimeRect = await timeButton.boundingBox();
  assert(hoverTimeRect);
  await page.mouse.move(hoverTimeRect.x + hoverTimeRect.width / 2, hoverTimeRect.y + hoverTimeRect.height / 2);
  await until(() => timeButton.evaluate(button => button.matches(":hover")), "timestamp button hover");
  const hoveredTimeStyle = await timeButton.evaluate(button => ({
    background: getComputedStyle(button).backgroundColor,
    border: getComputedStyle(button).borderColor,
    shadow: getComputedStyle(button).boxShadow,
  }));
  assert.notEqual(hoveredTimeStyle.background, plainTimeStyle.background);
  assert.notEqual(hoveredTimeStyle.border, plainTimeStyle.border);
  assert.notEqual(hoveredTimeStyle.shadow, plainTimeStyle.shadow);
  await page.screenshot({ path: join(out, "timestamp-hover.png") });
  report.checks.push("timestamp button has distinct hover background, border and ring");
  await page.evaluate(() => {
    const root = document.querySelector("#localmark-video-transcript").shadowRoot;
    const cues = root.querySelectorAll(".cue");
    cues[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, button: 0 }));
    const range = document.createRange();
    range.setStart(cues[0].firstChild, 3); range.setEnd(cues[1].firstChild, 4);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 900, clientY: 270 }));
  });
  await panel.locator(".video-editor").waitFor();
  await panel.locator(".video-editor textarea").fill("跨句批注");
  await panel.locator(".video-editor .video-colors button").nth(1).click();
  await until(async () => await panel.locator(".cue.annotated").count() === 2, "complete cue highlight");
  assert.equal(await panel.locator(".cue-note").first().innerText(), "跨句批注");
  report.checks.push("partial selection across cues saves full-cue highlight and inline note");
  await page.mouse.move(1200, 800);
  const highlightStates = await panel.evaluate(host => {
    const cue = host.shadowRoot.querySelector(".cue.annotated");
    const original = cue.className;
    const states = Array.from({ length: 8 }, (_, mask) => {
      cue.classList.toggle("hovered", !!(mask & 1));
      cue.classList.toggle("annotated", !!(mask & 2));
      cue.classList.toggle("active", !!(mask & 4));
      const style = getComputedStyle(cue);
      return {
        bands: ["--cue-annotation-band", "--cue-current-band"]
          .map(name => style.getPropertyValue(name).trim()),
        base: style.getPropertyValue("--cue-highlight-base").trim(),
        annotation: style.getPropertyValue("--annotation").trim(),
        background: style.backgroundImage,
        underline: style.textDecorationLine,
        underlineColor: style.textDecorationColor,
        underlineThickness: style.textDecorationThickness,
        shadow: style.boxShadow,
      };
    });
    cue.className = original;
    return states;
  });
  for (let mask = 0; mask < 8; mask++) {
    assert.equal(highlightStates[mask].base, mask & 2 ? highlightStates[mask].annotation : highlightStates[0].base);
    for (let band = 0; band < 2; band++) {
      const enabled = !!(mask & (1 << (band + 1)));
      assert.equal(highlightStates[mask].bands[band], enabled ? highlightStates[1 << (band + 1)].bands[band] : highlightStates[mask].base);
    }
    assert.equal(highlightStates[mask].shadow, "none");
    assert.equal(highlightStates[mask].background.includes("linear-gradient"), !!(mask & 6));
    if (mask & 6) {
      assert(highlightStates[mask].background.includes("33.333%"));
      assert(highlightStates[mask].background.includes("66.667%"));
    }
    assert.equal(highlightStates[mask].underline, mask & 1 ? "underline" : "none");
    if (mask & 1) {
      assert.equal(highlightStates[mask].underlineColor, highlightStates[1].underlineColor);
      assert.equal(highlightStates[mask].underlineThickness, highlightStates[1].underlineThickness);
    }
  }
  const triple = await panel.evaluate(host => {
    const cue = host.shadowRoot.querySelector(".cue.annotated");
    cue.classList.add("hovered", "active");
    return cue.className;
  });
  assert(triple.includes("hovered") && triple.includes("annotated") && triple.includes("active"));
  await panel.locator(".transcript").screenshot({ path: `${out}/three-highlight-states.png` });
  await panel.evaluate(host => host.shadowRoot.querySelector(".cue.annotated").classList.remove("hovered", "active"));
  report.checks.push("all eight hover/annotation/playback combinations keep the same underline and three equal background bands");
  await panel.getByLabel("当前字幕批注").fill("关键帧批注");
  await until(() => page.locator("video").evaluate(video => video.seekable.length > 0), "seekable media");
  await page.locator("video").evaluate(video => { video.currentTime = 5.4; video.pause(); });
  await until(() => page.locator("video").evaluate(video => Math.abs(video.currentTime - 5.4) < 0.1), "media seek before mark");
  await panel.getByRole("button", { name: "添加关键帧" }).click();
  await until(async () => await panel.locator(".cue-marker").count() === 1, "keyframe marker");
  await panel.locator(".cue-marker button").first().click();
  await until(() => page.locator("video").evaluate(video => Math.abs(video.currentTime - 5.4) < 0.15 && video.paused), "precise marker seek");
  report.checks.push("keyframe keeps its own time, comment and exact seek");
  await panel.getByLabel("当前字幕批注").fill("截图批注");
  await page.evaluate(() => {
    const player = document.querySelector("#movie_player");
    player.style.position = "relative";
    const controls = document.createElement("div"); controls.className = "ytp-chrome-bottom";
    controls.style.cssText = "position:absolute;bottom:0;left:0;width:100%;height:20px;background:#ff0000;z-index:50";
    player.append(controls);
  });
  await panel.getByRole("button", { name: "截图并标注" }).click();
  await until(async () => await panel.locator(".cue-marker").count() === 2 || await panel.locator(".mark-error").count() > 0, "screenshot result");
  assert.equal(await panel.locator(".mark-error").count(), 0, await panel.locator(".mark-error").allInnerTexts());
  const screenshotNote = panel.locator(".cue-note").filter({ hasText: "截图批注" });
  const keyframeNote = panel.locator(".cue-note").filter({ hasText: "关键帧批注" });
  await until(async () => await screenshotNote.locator(".cue-note-heading img.screenshot-image").count() === 1, "inline screenshot comment thumbnail");
  assert.equal(await keyframeNote.locator(".cue-note-heading svg").count(), 1);
  assert.equal(await screenshotNote.locator(".cue-note-heading").innerText(), "0:05");
  assert.equal(await keyframeNote.locator(".cue-note-heading").innerText(), "0:05");
  report.checks.push("point comments show their own small screenshot or bookmark instead of a type word");
  for (const [note, target] of [
    [screenshotNote, ".cue-note-heading img.screenshot-image"],
    [keyframeNote, ".cue-note-heading svg"],
  ]) {
    await page.locator("video").evaluate(video => { video.currentTime = 9.2; video.pause(); });
    await note.locator(target).click();
    await until(() => page.locator("video").evaluate(video => video.paused && Math.abs(video.currentTime - 5.4) < 0.15), "point comment card seeks exact time");
    assert.equal(await panel.locator(".video-editor").count(), 0);
    await page.locator("video").evaluate(video => { video.currentTime = 9.2; video.pause(); });
    const bounds = await note.boundingBox();
    await note.click({ position: { x: bounds.width - 5, y: bounds.height - 5 } });
    await until(() => page.locator("video").evaluate(video => video.paused && Math.abs(video.currentTime - 5.4) < 0.15), "point comment card blank area seeks exact time");
  }
  report.checks.push("clicking point comment image, icon or blank card area seeks without opening the editor");
  const subtitleNote = panel.locator(".cue-note").filter({ hasText: "跨句批注" });
  await page.locator("video").evaluate(video => { video.currentTime = 9.2; video.pause(); });
  await subtitleNote.click({ position: { x: 5, y: 5 } });
  await until(() => page.locator("video").evaluate(video => video.paused && Math.abs(video.currentTime) < 0.15), "subtitle comment card seeks its marked time");
  assert.equal(await panel.locator(".video-editor").count(), 0);
  await page.locator("video").evaluate(video => { video.currentTime = 9.2; video.pause(); });
  const subtitleBounds = await subtitleNote.boundingBox();
  await subtitleNote.click({ position: { x: subtitleBounds.width - 5, y: subtitleBounds.height - 5 } });
  await until(() => page.locator("video").evaluate(video => video.paused && Math.abs(video.currentTime) < 0.15), "subtitle comment card blank area seeks its marked time");
  report.checks.push("clicking subtitle comment card padding or blank area seeks without opening the editor");
  await page.locator("video").evaluate(video => { video.currentTime = 0.4; video.pause(); });
  await until(async () => await panel.locator('.cue.active[data-index="0"]').count() === 1, "playback on annotated cue");
  await subtitleNote.hover();
  await until(async () => await panel.locator(".cue.hovered.annotated").count() === 2, "subtitle comment highlights its two cues");
  assert.equal(await panel.locator(".cue.active.hovered.annotated").count(), 1);
  await panel.locator(".transcript").screenshot({ path: `${out}/subtitle-comment-hover.png` });
  await screenshotNote.hover();
  const screenshotId = await screenshotNote.getAttribute("data-mark-id");
  await until(async () => await panel.locator(`.cue-marker.comment-hovered[data-mark-id="${screenshotId}"]`).count() === 1, "screenshot comment highlights its image");
  assert.equal(await panel.locator(".cue.hovered.annotated").count(), 0);
  assert.equal(await panel.locator(".cue-marker.comment-hovered").count(), 1);
  assert.notEqual(await panel.locator(`.cue-marker[data-mark-id="${screenshotId}"] > button`).first().evaluate(button => getComputedStyle(button).boxShadow), "none");
  await panel.locator(".transcript").screenshot({ path: `${out}/screenshot-comment-hover.png` });
  await keyframeNote.hover();
  const keyframeId = await keyframeNote.getAttribute("data-mark-id");
  await until(async () => await panel.locator(`.cue-marker.comment-hovered[data-mark-id="${keyframeId}"]`).count() === 1, "keyframe comment highlights its icon");
  assert.equal(await panel.locator(".cue-marker.comment-hovered").count(), 1);
  assert.equal(await panel.locator(`.cue-marker[data-mark-id="${keyframeId}"] > button:first-child svg`).count(), 1);
  await panel.locator(".transcript").screenshot({ path: `${out}/keyframe-comment-hover.png` });
  await keyframeNote.locator(".cue-note-jump").focus();
  assert.equal(await panel.locator(`.cue-marker.comment-hovered[data-mark-id="${keyframeId}"]`).count(), 1);
  await panel.locator(".paragraph-time").first().focus();
  await page.mouse.move(1200, 800);
  await until(async () => await panel.locator(".cue-marker.comment-hovered").count() === 0, "comment highlight clears on exit");
  report.checks.push("hovering or focusing each comment highlights only its exact subtitle range, screenshot image, or keyframe icon");
  for (const [note, seconds] of [[screenshotNote, 5.4], [keyframeNote, 5.4], [panel.locator(".cue-note").filter({ hasText: "跨句批注" }), 0]]) {
    await page.locator("video").evaluate(video => { video.currentTime = 9.2; video.pause(); });
    await note.locator(".cue-note-jump").click();
    await until(() => page.locator("video").evaluate((video, target) => Math.abs(video.currentTime - target) < 0.15 && video.paused, seconds), "comment jumps to its mark time");
    assert.equal(await panel.locator(".video-editor").count(), 0);
  }
  report.checks.push("subtitle, screenshot and keyframe comment text seeks to its own timestamp without opening the editor");
  await page.locator("video").evaluate(video => { video.currentTime = 5.4; video.pause(); });
  const markerPositions = await panel.locator(".cue-marker > button:first-child").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x));
  assert(markerPositions.length === 2 && Math.abs(markerPositions[0] - markerPositions[1]) > 8, "same-time icons must remain separate");
  const image = await settings.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("LocalMark QA");
    const media = await root.getDirectoryHandle("media");
    for await (const [id, directory] of media.entries())
      for await (const [name, handle] of directory.entries()) {
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        let binary = "";
        for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
        return { id, name, size: bytes.length, png: btoa(binary), dimensions: await createImageBitmap(await handle.getFile()).then(bitmap => {
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
          const pixel = Array.from(ctx.getImageData(Math.floor(bitmap.width / 2), bitmap.height - 10, 1, 1).data);
          const dimensions = [bitmap.width, bitmap.height, pixel]; bitmap.close(); return dimensions;
        }) };
      }
    return null;
  });
  assert(image?.name.endsWith(".png") && image.size > 100 && image.dimensions[0] > 200);
  assert(image.dimensions[2][0] < 100, "screenshot must hide playback controls");
  assert.equal(await page.locator("#movie_player .ytp-chrome-bottom").isVisible(), true);
  await writeFile(join(out, "capture.png"), Buffer.from(image.png, "base64"));
  const imageButton = panel.getByRole("button", { name: /截图 .*跳转视频/ });
  await imageButton.first().hover();
  await until(async () => await page.locator('img[alt="视频截图预览"]').count() === 1, "image preview");
  const previewBounds = await page.locator('img[alt="视频截图预览"]').boundingBox();
  assert(previewBounds.width >= 350 && previewBounds.x >= 0 && previewBounds.x + previewBounds.width <= 1440);
  assert(previewBounds.y >= 0 && previewBounds.y + previewBounds.height <= 900);
  assert.equal(await panel.locator(".cue-timeline > .cue-marker img.screenshot-image").count(), 1);
  assert.equal(await panel.locator(".cue-timeline").first().evaluate(node => getComputedStyle(node).borderTopWidth), "0px");
  await page.setViewportSize({ width: 320, height: 800 });
  await imageButton.first().hover();
  const narrowPreview = await page.locator('img[alt="视频截图预览"]').boundingBox();
  assert(narrowPreview.x >= 0 && narrowPreview.x + narrowPreview.width <= 320);
  await page.setViewportSize({ width: 1440, height: 900 });
  await panel.screenshot({ path: join(out, "point-thumbnails.png") });
  await until(() => settings.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("LocalMark QA");
    const found = [];
    async function walk(directory) {
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === "directory") await walk(handle);
        else if (name.endsWith(".json") || name.endsWith(".md")) found.push(await (await handle.getFile()).text());
      }
    }
    await walk(root);
    return found.some(text => text.includes('"kind": "screenshot"') && text.includes("media/")) &&
      found.some(text => text.includes("![视频截图]") && text.includes("截图批注"));
  }), "JSON and Markdown sync");
  report.checks.push("screenshot PNG saved in the local OPFS fixture and previewed from disk");
  await panel.getByRole("button", { name: "截图并标注" }).click();
  await until(async () => await panel.locator(".cue-marker").count() === 3, "second screenshot");
  await until(async () => await panel.locator(".cue-timeline img.screenshot-image").count() === 2, "second screenshot image loaded");
  assert.equal(await panel.locator(".cue-timeline img.screenshot-image").count(), 2);
  const sidebar = await context.newPage();
  await sidebar.setViewportSize({ width: 320, height: 800 });
  await sidebar.goto(`${extensionOrigin}/sidepanel.html`);
  await page.bringToFront();
  const sidebarScreenshots = sidebar.locator(".card.current").filter({ has: sidebar.locator(".element-kind").filter({ hasText: /^截图 ·/ }) });
  const sidebarSubtitles = sidebar.locator(".card.current").filter({ has: sidebar.locator(".element-kind").filter({ hasText: /^字幕标注 ·/ }) });
  const sidebarKeyframes = sidebar.locator(".card.current").filter({ has: sidebar.locator(".element-kind").filter({ hasText: /^关键帧 ·/ }) });
  await until(async () => await sidebarScreenshots.count() === 2, "sidebar screenshot cards");
  await until(async () => await sidebarKeyframes.count() === 1, "sidebar keyframe card");
  await until(async () => await sidebarScreenshots.locator(".screenshot-gallery img").count() === 2, "sidebar screenshot images loaded");
  assert.deepEqual(await sidebarScreenshots.evaluateAll(cards => cards.map(card => [card.querySelectorAll(".screenshot-gallery img").length, card.querySelectorAll(".quote").length])), [[1, 0], [1, 0]]);
  assert.equal(await sidebarScreenshots.filter({ hasText: "截图批注" }).locator(".note").innerText(), "截图批注");
  assert.equal(await sidebarSubtitles.locator(".screenshot-gallery img").count(), 0);
  assert.equal(await sidebarSubtitles.locator(".quote").count(), 1);
  assert.equal(await sidebarSubtitles.locator(".note").innerText(), "跨句批注");
  await sidebarScreenshots.first().locator(".screenshot-gallery img").hover();
  assert.equal(await sidebar.locator('img[alt="视频截图预览"]').count(), 0);
  assert.equal(await sidebarScreenshots.first().locator(".screenshot-gallery img").getAttribute("tabindex"), null);
  await page.locator("video").evaluate(video => { video.currentTime = 12.4; video.pause(); });
  await page.bringToFront();
  await sidebarScreenshots.filter({ hasText: "截图批注" }).locator(".video-card-image-jump").click();
  await until(() => page.locator("video").evaluate(video => video.paused && Math.abs(video.currentTime - 5.4) < 0.15), "sidebar screenshot image seeks exact time");
  await page.locator("video").evaluate(video => { video.currentTime = 12.4; video.pause(); });
  await page.bringToFront();
  await sidebarKeyframes.locator(".video-card-kind-jump").click();
  await until(() => page.locator("video").evaluate(video => video.paused && Math.abs(video.currentTime - 5.4) < 0.15), "sidebar keyframe label seeks exact time");
  await page.locator("video").evaluate(video => { video.currentTime = 12.4; video.pause(); });
  await page.bringToFront();
  await sidebarKeyframes.locator(".quote").click();
  await until(() => page.locator("video").evaluate(video => video.paused && Math.abs(video.currentTime - 5.4) < 0.15), "sidebar keyframe text seeks exact time");
  for (const card of [sidebarScreenshots.filter({ hasText: "截图批注" }), sidebarKeyframes]) {
    await page.locator("video").evaluate(video => { video.currentTime = 12.4; video.pause(); });
    await page.bringToFront();
    await card.click({ position: { x: 7, y: 7 } });
    await until(() => page.locator("video").evaluate(video => video.paused && Math.abs(video.currentTime - 5.4) < 0.15), "sidebar point card blank area seeks exact time");
  }
  report.checks.push("sidebar screenshot and keyframe card image, label, text and blank area seek exact timestamps");
  await sidebar.mouse.move(4, 4);
  await sidebar.screenshot({ path: join(out, "sidebar-card.png") });
  await sidebar.close();
  const dashboard = await context.newPage();
  await dashboard.goto(`${extensionOrigin}/dashboard.html`);
  await dashboard.getByRole("navigation", { name: "资料库视图" }).getByRole("button", { name: /高亮内容/ }).click();
  const dashboardScreenshots = dashboard.locator(".content-card").filter({ has: dashboard.locator(".element-kind").filter({ hasText: /^截图 ·/ }) });
  const dashboardSubtitles = dashboard.locator(".content-card").filter({ has: dashboard.locator(".element-kind").filter({ hasText: /^字幕 ·/ }) });
  await until(async () => await dashboardScreenshots.count() === 2, "dashboard screenshot cards");
  await until(async () => await dashboardScreenshots.locator(".screenshot-gallery img").count() === 2, "dashboard screenshot images loaded");
  assert.deepEqual(await dashboardScreenshots.evaluateAll(cards => cards.map(card => [card.querySelectorAll(".screenshot-gallery img").length, card.querySelectorAll("blockquote").length])), [[1, 0], [1, 0]]);
  assert.equal(await dashboardScreenshots.filter({ hasText: "截图批注" }).locator(".content-note").innerText(), "截图批注");
  assert.equal(await dashboardSubtitles.locator(".screenshot-gallery img").count(), 0);
  assert.equal(await dashboardSubtitles.locator("blockquote").count(), 1);
  assert.equal(await dashboardSubtitles.locator(".content-note").innerText(), "跨句批注");
  await dashboardScreenshots.first().locator(".screenshot-gallery img").hover();
  await until(async () => await dashboard.locator('img[alt="视频截图预览"]').count() === 1, "dashboard image hover");
  await dashboard.mouse.move(4, 4);
  await dashboardScreenshots.first().screenshot({ path: join(out, "dashboard-card.png") });
  await dashboard.close();
  await page.bringToFront();
  report.checks.push("screenshot cards show only their own image and comment; subtitle cards show only text and comment; dashboard image preview remains available");
  await panel.getByLabel("字幕语言").selectOption("zh");
  await until(async () => (await panel.locator(".cue").first().innerText()).startsWith("zh"), "language switch");
  assert.equal(await panel.locator(".cue.annotated").count(), 1);
  await panel.locator(".annotation-rail button").first().click();
  await until(async () => await panel.getByLabel("字幕语言").inputValue() === "en", "rail language switch");
  report.checks.push("point marks cross languages and text rail restores its source language");
  await panel.getByLabel("当前字幕批注").fill("直接字幕批注");
  await page.locator("video").evaluate(video => { video.currentTime = 8.2; video.pause(); });
  await panel.locator(".quick-input > button").click();
  await until(async () => await panel.locator(".cue-note").filter({ hasText: "直接字幕批注" }).count() === 1, "quick cue comment");
  assert.equal(await panel.getByLabel("当前字幕批注").inputValue(), "");
  report.checks.push("quick input saves a current-cue note and clears after success");
  await imageButton.first().hover();
  await imageButton.first().locator("..").locator(".marker-edit").click();
  await panel.locator(".video-editor .video-delete").click();
  await until(async () => await panel.locator(".cue-marker").count() === 2, "first screenshot deletion");
  await imageButton.first().hover();
  await imageButton.first().locator("..").locator(".marker-edit").click();
  await panel.locator(".video-editor .video-delete").click();
  await until(async () => await panel.locator(".cue-marker").count() === 1, "screenshot deletion");
  const imageStillExists = await settings.evaluate(async id => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("LocalMark QA");
    try { const directory = await (await root.getDirectoryHandle("media")).getDirectoryHandle(id); for await (const _ of directory.entries()) return true; } catch {}
    return false;
  }, image.id);
  assert.equal(imageStillExists, false);
  report.checks.push("deleting screenshot removes its owned local PNG");
  await settings.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("local-web-clipper", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").delete("root");
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await panel.getByRole("button", { name: "截图并标注" }).click();
  await panel.locator(".mark-error").waitFor();
  assert((await panel.locator(".mark-error").innerText()).includes("连接并授权"));
  assert.equal(await panel.locator(".cue-marker").count(), 1);
  report.checks.push("disconnected folder rejects screenshot without creating a mark");
  await settings.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("LocalMark Write Failure", { create: true });
    await root.getFileHandle("media", { create: true });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("local-web-clipper", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(root, "pendingRoot");
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    const reply = await chrome.runtime.sendMessage({ type: "directory-connected" });
    if (!reply.ok) throw Error(reply.error);
  });
  await panel.getByRole("button", { name: "截图并标注" }).click();
  await until(async () => await panel.locator(".mark-error").count() > 0, "screenshot write error");
  assert.equal(await panel.locator(".cue-marker").count(), 1);
  report.checks.push("local image write failure leaves the screenshot mark uncreated");
  await page.evaluate(() => {
    const root = document.querySelector("#localmark-video-transcript").shadowRoot;
    const cues = root.querySelectorAll(".cue");
    cues[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, button: 0 }));
    const selection = window.getSelection(); selection.removeAllRanges();
    selection.setBaseAndExtent(cues[1].firstChild, 5, cues[0].firstChild, 2);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 900, clientY: 270 }));
  });
  await panel.locator(".video-editor textarea").fill("反选批注");
  await panel.locator(".video-editor .video-colors button").nth(2).click();
  await until(async () => await panel.locator(".cue-inserts").first().locator(".cue-note").count() === 2, "overlapping notes");
  await panel.locator(".cue-inserts").first().locator(".cue-note-edit").first().click();
  await panel.locator(".video-editor textarea").fill("修改后的批注");
  await panel.locator(".video-editor .video-colors button").nth(0).click();
  await until(async () => await panel.locator(".cue-note").filter({ hasText: "修改后的批注" }).count() === 1, "edited subtitle note");
  await panel.locator(".cue-inserts").first().locator(".cue-note-edit").nth(1).click();
  await panel.locator(".video-editor .video-delete").click();
  await until(async () => await panel.locator(".cue-inserts").first().locator(".cue-note").count() === 1, "overlap deletion");
  report.checks.push("reverse selection, overlapping notes, color edit and individual deletion");
  await panel.screenshot({ path: join(out, "wide.png") });
  await page.evaluate(() => document.documentElement.removeAttribute("dark"));
  await until(async () => await panel.getAttribute("data-theme") === "light", "light theme");
  await panel.screenshot({ path: join(out, "light.png") });
  await page.setViewportSize({ width: 320, height: 800 });
  await panel.screenshot({ path: join(out, "narrow.png") });
  assert(await panel.evaluate(host => host.shadowRoot.querySelector(".transcript").scrollWidth <= host.clientWidth + 1));
  report.checks.push("light/dark themes and 320px layout without horizontal overflow");
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(join(out, "results.json"), JSON.stringify(report, null, 2));
  await context.close();
}
