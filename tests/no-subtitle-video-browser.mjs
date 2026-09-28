import { chromium } from "playwright";
import { fixture } from "./video-native-fixture.mjs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const out = resolve("test-results/no-subtitle-video");
await mkdir(out, { recursive: true });
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "lm-no-subtitle-")), {
  channel: "chromium", headless: true, viewport: { width: 1440, height: 900 },
  args: ["--enable-unsafe-extension-debugging"], ignoreDefaultArgs: ["--disable-extensions"],
});
const report = { version, checks: [], errors: [] };
const wave = Buffer.alloc(44 + 8000 * 2 * 45);
wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
const subtitleReady = { youtube: false, bilibili: false, gdcvault: false };
const frameHtml = `<!doctype html><video src="/test.wav" controls style="width:100%;height:240px"></video><script>
window.player={textTracks:()=>[],remoteTextTrackEls:()=>[],currentSource:()=>({src:'https://cdn-a.blazestreaming.com/first/master.m3u8'})};</script>`;
await context.route("**/*", async route => {
  const u = new URL(route.request().url());
  if (u.protocol === "chrome-extension:") return route.continue();
  if (u.pathname === "/test.wav") {
    const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : wave.length - 1;
    return route.fulfill({ status: range ? 206 : 200, headers: { "content-type": "audio/wav", "accept-ranges": "bytes",
      ...(range ? { "content-range": `bytes ${start}-${end}/${wave.length}` } : {}) }, body: wave.subarray(start, end + 1) });
  }
  if (u.pathname === "/youtubei/v1/get_transcript") {
    if (!subtitleReady.youtube) await new Promise(resolve => setTimeout(resolve, 1500));
    return subtitleReady.youtube ? route.fulfill({ json: { items: Array.from({ length: 12 }, (_, i) => ({ transcriptSegmentRenderer: {
      startMs: String(i * 1000), endMs: String((i + 1) * 1000), snippet: { runs: [{ text: `字幕 ${i}` }] },
    } })) } }) : route.fulfill({ status: 403, json: { error: { message: "No transcript" } } });
  }
  if (u.hostname === "api.bilibili.com")
    return route.fulfill({ json: { code: 0, data: { bvid: "BVtest", aid: 123, cid: 1, page_no: 1,
      subtitle: { subtitles: subtitleReady.bilibili ? [{ id_str: "zh", lan: "zh", lan_doc: "中文",
        subtitle_url: "https://aisubtitle.hdslb.com/subtitle/zh.json" }] : [] } } } });
  if (u.hostname === "aisubtitle.hdslb.com")
    return route.fulfill({ json: { body: Array.from({ length: 12 }, (_, i) => ({ from: i, to: i + 1, content: `字幕 ${i}` })) } });
  if (u.hostname === "gdcvault.com")
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>body{margin:20px;font:16px Arial}#player{display:grid;grid-template-columns:minmax(0,1fr) 370px;gap:20px}iframe{width:100%;height:260px;border:0}@media(max-width:800px){#player{display:block}}</style><div id="player"><div class="left_column"><div id="container"><iframe src="https://gdcvault.blazestreaming.com/?id=first"></iframe></div></div><div class="right_column"><div class="player-info">Session</div></div></div>` });
  if (u.hostname === "gdcvault.blazestreaming.com") return route.fulfill({ contentType: "text/html", body: frameHtml });
  if (u.hostname === "cdn-a.blazestreaming.com")
    return u.pathname.endsWith("master.m3u8")
      ? route.fulfill({ body: subtitleReady.gdcvault
        ? '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English",LANGUAGE="en",URI="en.vtt"'
        : "#EXTM3U\n#EXT-X-VERSION:3\n" })
      : route.fulfill({ contentType: "text/vtt", body: "WEBVTT\n\n" + Array.from({ length: 12 }, (_, i) =>
        `00:00:${String(i).padStart(2, "0")}.000 --> 00:00:${String(i + 1).padStart(2, "0")}.000\n字幕 ${i}\n\n`).join("") });
  if (u.hostname === "www.youtube.com" || u.hostname === "www.bilibili.com")
    return route.fulfill({ contentType: "text/html", body: fixture(u.hostname.includes("youtube") ? "youtube" : "bilibili") });
  return route.abort();
});
const until = async (condition, label) => {
  for (let i = 0; i < 120; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw Error(`Timeout: ${label}`);
};
try {
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await (await context.browser().newBrowserCDPSession()).send("Extensions.loadUnpacked", { path: resolve("dist") });
  await manager.close();
  await until(() => context.serviceWorkers().length > 0, "extension worker");
  const extensionOrigin = context.serviceWorkers()[0].url().match(/^chrome-extension:\/\/[^/]+/)[0];
  const settings = await context.newPage();
  await settings.goto(`${extensionOrigin}/settings.html`);
  const connect = async () => settings.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("LocalMark No Subtitle QA", { create: true });
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
  await connect();
  for (const site of ["youtube", "bilibili", "gdcvault"]) {
    const page = await context.newPage();
    page.on("pageerror", error => report.errors.push(`${site}: ${error.message}`));
    await page.goto(site === "youtube" ? "https://www.youtube.com/watch?v=first" : site === "bilibili"
      ? "https://www.bilibili.com/video/BVtest/" : "https://gdcvault.com/play/123/Example");
    if (site === "bilibili") await page.evaluate(() => document.querySelector("#app").removeAttribute("data-server-rendered"));
    const panel = page.locator("#localmark-video-transcript");
    const player = site === "gdcvault" ? page.frameLocator("iframe").locator("video") : page.locator("video");
    if (site === "youtube") {
      await until(async () => (await panel.locator(".message").innerText()).includes("正在读取"), "subtitle loading state");
      await until(() => player.evaluate(video => video.readyState > 0 && video.seekable.length > 0), "loading player ready");
      assert.equal(await panel.getByRole("button", { name: "截图并标注" }).isEnabled(), true);
      await player.evaluate(video => { video.currentTime = 2.4; video.pause(); });
      await panel.getByRole("button", { name: "截图并标注" }).click();
      await until(async () => await panel.locator(".video-point-card").count() === 1, "screenshot while subtitles load");
    }
    await until(async () => await panel.locator(".message.error").count() === 1, `${site} subtitle unavailable`);
    if (site === "youtube") {
      await panel.locator(".video-point-card").getByRole("button", { name: "删除截图" }).click();
      await until(async () => await panel.locator(".video-point-card").count() === 0, "loading screenshot deletion");
    }
    await until(() => player.evaluate(video => video.readyState > 0 && video.seekable.length > 0), `${site} player ready`);
    assert.equal(await panel.locator(".cue").count(), 0);
    assert.equal(await panel.getByRole("button", { name: "截图并标注" }).isEnabled(), true);
    assert((await panel.locator(".message.error").innerText()).includes("仍可按当前播放时间"));
    if (site === "youtube") {
      await player.evaluate(video => { video.removeAttribute("src"); video.load(); });
      await panel.getByRole("button", { name: "添加关键帧" }).click();
      await until(async () => (await panel.locator(".mark-error").innerText()).includes("播放器尚未准备好"), "player not ready error");
      assert.equal(await panel.locator(".video-point-card").count(), 0);
      await player.evaluate(video => { video.src = "/test.wav"; video.load(); });
      await until(() => player.evaluate(video => video.readyState > 0 && video.seekable.length > 0), "player recovered");
    }
    await player.evaluate(video => { video.currentTime = 5.4; video.pause(); });
    await panel.getByRole("button", { name: "截图并标注" }).click();
    await until(async () => await panel.locator(".video-point-card").count() === 1, `${site} screenshot mark`);
    const screenshot = panel.locator(".video-point-card img.screenshot-image");
    await screenshot.hover();
    await until(async () => await page.locator('img[alt="视频截图预览"]').count() === 1, `${site} screenshot hover preview`);
    const thumbnailBounds = await screenshot.boundingBox();
    const previewBounds = await page.locator('img[alt="视频截图预览"]').boundingBox();
    assert(previewBounds.width > thumbnailBounds.width && previewBounds.height > thumbnailBounds.height);
    if (site === "bilibili") await page.screenshot({ path: join(out, "bilibili-screenshot-hover.png") });
    await page.mouse.move(0, 0);
    await until(async () => await page.locator('img[alt="视频截图预览"]').count() === 0, `${site} screenshot preview closes`);
    assert((await panel.locator(".heading").innerText()).includes("LocalMark"));
    if (site === "bilibili") {
      await page.evaluate(() => {
        const input = document.createElement("input");
        input.id = "website-input";
        document.body.append(input);
        input.focus();
      });
      await page.keyboard.press("Shift+Enter");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "website-input");
      await page.locator("#website-input").evaluate(input => input.remove());
    }
    await panel.locator(".heading").click();
    assert.equal(await panel.locator("footer").count(), 0);
    assert.equal(await panel.locator(".video-point-card").count(), 0);
    if (site === "bilibili") await panel.screenshot({ path: join(out, "bilibili-collapsed.png") });
    await page.keyboard.press("Shift+Enter");
    await until(async () => await panel.locator(".quick-input textarea").count() === 1, `${site} shortcut expands panel`);
    assert.equal(await panel.locator(".quick-input textarea").evaluate(input => input.getRootNode().activeElement === input), true);
    await page.evaluate(() => {
      window.siteShortcutKeys = [];
      for (const type of ["keydown", "keyup", "keypress"])
        window.addEventListener(type, event => window.siteShortcutKeys.push(`${type}:${event.key}`), true);
    });
    await page.keyboard.type("快捷输入");
    await page.keyboard.press("Space");
    await page.keyboard.press("k");
    assert.equal(await panel.locator(".quick-input textarea").inputValue(), "快捷输入 k");
    assert.deepEqual(await page.evaluate(() => window.siteShortcutKeys), [], `${site} note typing must not trigger site shortcuts`);
    await panel.locator(".quick-input textarea").fill("");
    await page.mouse.click(5, 5);
    await page.keyboard.press("k");
    assert((await page.evaluate(() => window.siteShortcutKeys)).includes("keydown:k"), `${site} site shortcuts must still work outside the editor`);
    assert.equal(await panel.locator("footer .build-version").innerText(), `v${version}`);
    await panel.getByRole("button", { name: "添加关键帧" }).click();
    await until(async () => await panel.locator(".video-point-card").count() === 2, `${site} keyframe mark`);
    await panel.getByLabel("当前视频时间点评论").fill(`${site} 评论`);
    await panel.locator(".quick-input > button").click();
    await until(async () => await panel.locator(".video-point-card").count() === 3, `${site} comment mark`);
    assert.equal(await panel.locator(".video-point-card img.screenshot-image").count(), 1);
    const comment = panel.locator(".video-point-card").filter({ hasText: `${site} 评论` });
    await comment.getByRole("button", { name: "编辑视频评论" }).click();
    await panel.locator(".video-editor textarea").fill(`${site} 已编辑评论`);
    await panel.locator(".video-editor .video-editor-input button").click();
    await until(async () => await panel.locator(".video-point-card").filter({ hasText: `${site} 已编辑评论` }).count() === 1, `${site} edited comment`);
    await panel.locator(".video-point-card").filter({ hasText: "关键帧" }).getByRole("button", { name: "删除关键帧" }).click();
    await until(async () => await panel.locator(".video-point-card").count() === 2, `${site} deleted keyframe`);
    await player.evaluate(video => { video.currentTime = 10.4; video.pause(); });
    await panel.locator(".video-point-card").filter({ hasText: `${site} 已编辑评论` }).locator(".video-point-jump").click();
    await until(() => player.evaluate(video => video.paused && Math.abs(video.currentTime - 5.4) < 0.15), `${site} exact seek`);
    if (site === "youtube") {
      const sidebar = await context.newPage();
      await sidebar.goto(`${extensionOrigin}/sidepanel.html`);
      await page.bringToFront();
      const sideComment = sidebar.locator(".card.current").filter({ hasText: "视频评论 ·" });
      await until(async () => await sideComment.count() === 1, "sidebar comment");
      assert.equal(await sideComment.locator(".quote").count(), 0);
      await player.evaluate(video => { video.currentTime = 10.4; video.pause(); });
      await page.bringToFront();
      await sideComment.locator(".video-card-kind-jump").click();
      await until(() => player.evaluate(video => video.paused && Math.abs(video.currentTime - 5.4) < 0.15), "sidebar comment seeks without subtitles");
      await page.bringToFront();
      await sideComment.getByRole("button", { name: "编辑", exact: true }).click();
      await panel.locator(".video-editor").waitFor();
      await panel.getByRole("button", { name: "关闭标注窗" }).click();
      const dashboard = await context.newPage();
      await dashboard.goto(`${extensionOrigin}/dashboard.html`);
      await dashboard.getByRole("navigation", { name: "资料库视图" }).getByRole("button", { name: /高亮内容/ }).click();
      await until(async () => await dashboard.locator(".content-card .element-kind").filter({ hasText: "视频评论 ·" }).count() === 1, "dashboard comment");
      await dashboard.close(); await sidebar.close();
      const before = await panel.locator(".video-point-card").count();
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
      await until(async () => await panel.locator(".mark-error").count() === 1, "screenshot failure");
      assert.equal(await panel.locator(".video-point-card").count(), before);
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
      await until(async () => {
        const message = await panel.locator(".mark-error").innerText().catch(() => "");
        return !!message && !message.includes("连接并授权");
      }, "image write failure");
      assert.equal(await panel.locator(".video-point-card").count(), before);
      await connect();
    }
    const snapshot = await settings.evaluate(async () => (await chrome.runtime.sendMessage({ type: "snapshot" })).data);
    const videoPage = Object.values(snapshot.entries).map(entry => entry.page).find(item => item.videoMarks?.some(mark => mark.videoKey.startsWith(site + ":")));
    assert.equal(videoPage.schemaVersion, 5);
    const marks = videoPage.videoMarks.filter(mark => mark.videoKey.startsWith(site + ":"));
    assert.deepEqual(marks.map(mark => mark.kind).sort(), ["comment", "screenshot"]);
    assert(marks.every(mark => Math.abs(mark.time - 5.4) < 0.15 && mark.text === "" && !mark.from && !mark.to && !mark.trackId));
    assert(marks.find(mark => mark.kind === "screenshot")?.imagePath);
    if (site === "youtube") await until(() => settings.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("LocalMark No Subtitle QA");
      const found = [];
      async function walk(directory) {
        for await (const [name, handle] of directory.entries()) {
          if (handle.kind === "directory") await walk(handle);
          else if (name.endsWith(".json") || name.endsWith(".md")) found.push(await (await handle.getFile()).text());
        }
      }
      await walk(root);
      return found.some(text => text.includes('"kind": "comment"')) && found.some(text => text.includes("视频评论 · 0:05"));
    }), "v5 JSON and Markdown sync");
    await page.setViewportSize({ width: 320, height: 800 });
    assert(await panel.evaluate(host => host.shadowRoot.querySelector(".transcript").scrollWidth <= host.clientWidth + 1));
    await panel.screenshot({ path: join(out, `${site}-fallback.png`) });
    await page.setViewportSize({ width: 1440, height: 900 });
    subtitleReady[site] = true;
    if (site === "youtube") await page.evaluate(() => window.nativeYoutube());
    else if (site === "bilibili") await page.evaluate(() => window.nativeBili("zh"));
    else await panel.getByRole("button", { name: "重试" }).click();
    await until(async () => await panel.locator(".cue").count() === 12, `${site} subtitles recovered`);
    await until(async () => await panel.locator(".cue-marker").count() === 2, `${site} time points remapped`);
    assert.equal(await panel.locator('.cue-marker button[aria-label^="视频评论"]').count(), 1);
    report.checks.push(`${site}: no-subtitle screenshot hover preview, full collapse, LocalMark heading, Shift+Enter focus, keyframe, comment, edit, delete, seek, v5 storage, 320px, subtitle recovery`);
    await page.close();
  }
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(join(out, "results.json"), JSON.stringify(report, null, 2));
  await context.close();
}
