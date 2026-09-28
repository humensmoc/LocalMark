import { chromium } from "playwright";
import { hoverCue, verifyTranscriptParagraphs } from "./transcript-paragraphs-fixture.mjs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const out = resolve("test-results/gdcvault-regression");
await mkdir(out, { recursive: true });
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const context = await chromium.launchPersistentContext(
  await mkdtemp(join(tmpdir(), "lm-gdc-")),
  {
    channel: "chromium",
    headless: true,
    viewport: { width: 1400, height: 950 },
    args: ["--enable-unsafe-extension-debugging"],
    ignoreDefaultArgs: ["--disable-extensions"],
  },
);
const report = { version, checks: [], errors: [] };
const deadline = setTimeout(() => void context.close(), 90000);
let mode = "normal";
const wave = Buffer.alloc(44 + 8000 * 2 * 90);
wave.write("RIFF");
wave.writeUInt32LE(wave.length - 8, 4);
wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24);
wave.writeUInt32LE(16000, 28);
wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34);
wave.write("data", 36);
wave.writeUInt32LE(wave.length - 44, 40);
const frameHtml = `<!doctype html><video id="media" src="https://gdcvault.blazestreaming.com/test.wav" controls style="width:100%;height:230px"></video><script>
const media=document.querySelector('video');let tracks=[{kind:'subtitles',language:'eng',mode:'disabled'},{kind:'subtitles',language:'zho',mode:'showing'}];
window.player={textTracks:()=>tracks,remoteTextTrackEls:()=>[],currentSource:()=>({src:'https://cdn-a.blazestreaming.com/'+new URL(location.href).searchParams.get('id')+'/master.m3u8'})};
window.changeLanguage=()=>{tracks[0].mode='showing';tracks[1].mode='disabled'};</script>`;
await context.route("**/*", async (route) => {
  const u = new URL(route.request().url());
  if (u.protocol === "chrome-extension:") return route.continue();
  if (u.pathname === "/test.wav") {
    const range = route
        .request()
        .headers()
        .range?.match(/bytes=(\d+)-(\d*)/),
      start = range ? Number(range[1]) : 0,
      end = range?.[2] ? Number(range[2]) : wave.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      headers: {
        "content-type": "audio/wav",
        "accept-ranges": "bytes",
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${wave.length}` }
          : {}),
      },
      body: wave.subarray(start, end + 1),
    });
  }
  if (u.hostname === "gdcvault.com")
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><style>body{font:16px Arial;margin:25px}#player{display:grid;grid-template-columns:minmax(0,1fr) 370px;gap:24px}iframe{width:100%;height:260px;border:0}dl{margin:0}aside{min-width:0}@media(max-width:800px){#player{display:block}}</style><div id="player"><div class="left_column"><div id="container"><iframe src="https://gdcvault.blazestreaming.com/?id=first"></iframe></div><p>Overview: original page content.</p></div><aside class="right_column"><dl class="player-info"><dt>Session Name:</dt><dd>Example session</dd><dt>Speaker(s):</dt><dd>Speaker</dd></dl></aside></div>`,
    });
  if (u.hostname === "gdcvault.blazestreaming.com")
    return route.fulfill({ contentType: "text/html", body: frameHtml });
  if (u.hostname === "cdn-a.blazestreaming.com") {
    if (mode === "http" && u.pathname.endsWith(".vtt"))
      return route.fulfill({ status: 403, body: "Denied" });
    if (u.pathname.endsWith("master.m3u8"))
      return route.fulfill({
        body: '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="en.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="Chinese",LANGUAGE="zho",URI="zh.m3u8"',
      });
    if (u.pathname.endsWith(".m3u8"))
      return route.fulfill({
        body: `#EXTM3U\n#EXTINF:30,\n${u.pathname.includes("zh") ? "zh" : "en"}-1.vtt\n#EXTINF:30,\n${u.pathname.includes("zh") ? "zh" : "en"}-2.vtt\n#EXT-X-ENDLIST`,
      });
    const zh = u.pathname.includes("zh"),
      second = u.pathname.includes("/second/");
    const cue = (i) =>
      `id-${i}\n00:00:${String(i).padStart(2, "0")}.000 --> 00:00:${String(i + 1).padStart(2, "0")}.000\n${second ? "SECOND " : ""}${zh ? "中文字幕" : "English transcript"} ${i}${i === 4 ? " &lt;img src=x&gt;" : ""}\n\n`;
    const start = u.pathname.endsWith("1.vtt") ? 0 : 29,
      end = u.pathname.endsWith("1.vtt") ? 31 : 60;
    return route.fulfill({
      contentType: "text/vtt",
      body:
        "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:180000\n\n" +
        Array.from({ length: end - start }, (_, j) => cue(start + j)).join(""),
    });
  }
  return route.abort();
});
async function until(fn, label) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw Error("Timeout: " + label);
}
try {
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() =>
    chrome.developerPrivate.updateProfileConfiguration({
      inDeveloperMode: true,
    }),
  );
  await (
    await context.browser().newBrowserCDPSession()
  ).send("Extensions.loadUnpacked", { path: resolve("dist") });
  await manager.close();
  const p = await context.newPage();
  p.on("pageerror", (e) => report.errors.push(e.message));
  await p.goto("https://gdcvault.com/play/123/Example");
  const panel = p.locator("#localmark-video-transcript");
  await panel.waitFor();
  await until(
    async () => (await panel.locator(".cue").count()) === 60,
    "full transcript",
  );
  assert.equal(
    await panel.locator("select").inputValue(),
    "https://cdn-a.blazestreaming.com/first/zh.m3u8",
  );
  assert((await panel.locator("footer").innerText()).includes(`v${version}`));
  assert(
    await panel.evaluate((h) => h.nextElementSibling.matches(".player-info")),
  );
  assert.equal(await panel.locator(".cues img").count(), 0);
  await verifyTranscriptParagraphs(context, p, panel, "gdcvault");
  await p.evaluate(() => {
    const root = document.querySelector("#localmark-video-transcript").shadowRoot;
    const cue = root.querySelector(".cue");
    cue.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, button: 0 }));
    const range = document.createRange(); range.selectNodeContents(cue);
    const selection = root.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 1000, clientY: 310 }));
  });
  await panel.locator(".video-editor").waitFor();
  assert.equal(await panel.locator(".video-editor textarea").evaluate(el => el.getRootNode().activeElement === el), false);
  assert.match(await p.evaluate(() => document.querySelector("#localmark-video-transcript").shadowRoot.getSelection().toString()), /中文字幕/);
  await p.screenshot({ path: join(out, "annotation-popup-selection.png") });
  await p.frameLocator("iframe").locator("body").click({ position: { x: 5, y: 5 } });
  await until(async () => await panel.locator(".video-editor").count() === 0, "GDC iframe click closes annotation editor");
  report.checks.push("GDC: selecting subtitles keeps focus outside the editor, and clicking the player iframe dismisses it");
  await p.evaluate(() => {
    document.querySelector("#localmark-video-transcript").shadowRoot.getSelection()?.removeAllRanges();
  });
  await p.mouse.move(5, 5);
  await panel.getByRole("button", { name: "搜索字幕", exact: true }).click();
  await panel.getByRole("searchbox").fill("中文字幕 59");
  assert.equal(await panel.locator(".cue").count(), 1);
  await panel.getByRole("searchbox").fill("");
  const frame = () =>
    p
      .frames()
      .find((f) => f.url().startsWith("https://gdcvault.blazestreaming.com/"));
  await until(
    () =>
      frame().evaluate(
        () => document.querySelector("video").seekable.length > 0,
      ),
    "media ready",
  );
  await frame().evaluate(() => { const video = document.querySelector("video"); video.currentTime = 43.4; video.pause(); });
  await until(() => frame().evaluate(() => Math.abs(document.querySelector("video").currentTime - 43.4) < 0.1), "GDC locate target time");
  await panel.getByRole("searchbox").fill("no match");
  await panel.getByRole("button", { name: "定位当前播放字幕" }).click();
  await until(async () => await panel.locator('.cue[data-index="43"]').count() === 1 &&
    await panel.locator('.cue[data-index="43"]').evaluate(cue => {
      const body = cue.closest(".body").getBoundingClientRect(), rect = cue.getBoundingClientRect();
      return rect.top >= body.top - 1 && rect.bottom <= body.bottom + 1;
    }), "GDC locate current cue after clearing search");
  assert(await frame().evaluate(() => { const video = document.querySelector("video"); return video.paused && Math.abs(video.currentTime - 43.4) < 0.1; }));
  report.checks.push("GDC: locate button reveals the current iframe playback cue without seeking");
  const locate = panel.getByRole("button", { name: "定位当前播放字幕" });
  const button = await locate.boundingBox();
  await p.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await p.mouse.down();
  await until(async () => await locate.getAttribute("aria-pressed") === "true", "GDC follow mode enters");
  await p.mouse.up();
  await frame().evaluate(() => { const video = document.querySelector("video"); video.currentTime = 58.4; video.pause(); });
  await until(() => panel.locator('.cue[data-index="58"]').evaluate(cue => {
    const body = cue.closest(".body"), a = cue.getBoundingClientRect(), b = body.getBoundingClientRect();
    return Math.abs((a.top + a.bottom - b.top - b.bottom) / 2) < 12;
  }), "GDC iframe playback follows to center");
  await p.mouse.down();
  await until(async () => await locate.getAttribute("aria-pressed") === "false", "GDC follow mode exits");
  await p.mouse.up();
  report.checks.push("GDC: holding the locator follows iframe playback and holding again exits");
  await frame().evaluate(() => document.querySelector("video").play());
  await hoverCue(p, panel.locator(".cue").nth(5));
  await panel.locator(".cue-time-button").click();
  await until(
    () =>
      frame().evaluate(() => {
        const v = document.querySelector("video");
        return v.paused && Math.abs(v.currentTime - 5) < 0.1;
      }),
    "iframe seek pause",
  );
  await until(
    async () => (await panel.locator(".cue.active").count()) > 0,
    "active cue",
  );
  await frame().evaluate(() => { const video = document.querySelector("video"); video.currentTime = 5.4; video.pause(); });
  await until(() => frame().evaluate(() => Math.abs(document.querySelector("video").currentTime - 5.4) < 0.1), "mark time ready");
  await panel.getByLabel("当前字幕批注").fill("GDC 关键帧");
  await panel.getByRole("button", { name: "添加关键帧" }).click();
  await until(async () => await panel.locator(".cue-marker").count() === 1, "GDC keyframe marker");
  await frame().evaluate(() => { const video = document.querySelector("video"); video.currentTime = 9; video.pause(); });
  await panel.locator(".cue-marker button").first().click();
  await until(() => frame().evaluate(() => {
    const video = document.querySelector("video");
    return video.paused && Math.abs(video.currentTime - 5.4) < 0.15;
  }), "GDC keyframe exact seek");
  report.checks.push("GDC: keyframe timestamp and icon seek inside iframe");
  const extensionOrigin = context.serviceWorkers()[0].url().match(/^chrome-extension:\/\/[^/]+/)[0];
  const settings = await context.newPage();
  await settings.goto(`${extensionOrigin}/settings.html`);
  await settings.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("LocalMark GDC QA", { create: true });
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
  await p.bringToFront();
  await panel.getByRole("button", { name: "截图并标注" }).click();
  await until(async () => await panel.locator(".cue-timeline img.screenshot-image").count() === 1 || await panel.locator(".mark-error").count() > 0, "GDC screenshot result");
  assert.equal(await panel.locator(".mark-error").count(), 0, await panel.locator(".mark-error").allInnerTexts());
  report.checks.push("GDC: screenshot captures the iframe video frame and creates a thumbnail");
  await settings.close();
  await frame().evaluate(() => window.changeLanguage());
  await until(
    async () =>
      (await panel.locator("select").inputValue()).endsWith("/en.m3u8"),
    "native language change",
  );
  await panel.locator("select").selectOption({ label: "Chinese (Simplified)" });
  await until(
    async () =>
      (await panel.locator(".cue").first().innerText()).includes("中文字幕"),
    "select language",
  );
  await panel.locator(".heading").click();
  assert.equal(await panel.locator(".body").count(), 0);
  await panel.locator(".heading").click();
  await p.screenshot({ path: join(out, "wide.png") });
  for (const width of [900, 480, 320]) {
    await p.setViewportSize({ width, height: 850 });
    assert(
      await panel.evaluate(
        (h) =>
          h.shadowRoot.querySelector(".transcript").scrollWidth <=
          h.clientWidth + 1,
      ),
    );
  }
  await panel.screenshot({ path: join(out, "narrow.png") });
  report.checks.push(
    "Full HLS transcript, duplicate removal, native/default/select language, search, safe text, placement, version, iframe seek/pause, active cue, collapse, responsive widths",
  );
  mode = "http";
  await panel.locator(".retry").click();
  await panel.locator(".error").waitFor();
  assert((await panel.locator(".error").innerText()).includes("HTTP 403"));
  mode = "normal";
  await panel.locator(".retry").click();
  await until(
    async () => (await panel.locator(".cue").count()) === 60,
    "retry",
  );
  // A new iframe document with the same URL must not receive commands bound to the old one.
  await p.evaluate(() => {
    const old = document.querySelector("iframe");
    old.replaceWith(old.cloneNode());
  });
  await until(
    async () =>
      await frame()
        ?.evaluate(() => document.querySelector("video")?.readyState > 0)
        .catch(() => false),
    "replacement frame",
  );
  await hoverCue(p, panel.locator(".cue").nth(10));
  await panel.locator(".cue-time-button").click();
  await panel.locator(".seek-error").waitFor();
  assert(
    await frame().evaluate(
      () => document.querySelector("video").currentTime < 1,
    ),
  );
  await panel.locator(".retry").click();
  await until(
    async () => (await panel.locator(".cue").count()) === 60,
    "new binding",
  );
  await hoverCue(p, panel.locator(".cue").nth(10));
  await panel.locator(".cue-time-button").click();
  await until(
    () =>
      frame().evaluate(
        () => Math.abs(document.querySelector("video").currentTime - 10) < 0.1,
      ),
    "rebound seek",
  );
  await p.evaluate(() => {
    history.pushState({}, "", "/play/456/Other");
    document.querySelector("iframe").src =
      "https://gdcvault.blazestreaming.com/?id=second";
  });
  await until(
    async () =>
      (await panel.locator(".cue").first().innerText()).includes("SECOND"),
    "new session",
  );
  await p.evaluate(() => history.pushState({}, "", "/browse"));
  await until(async () => (await panel.count()) === 0, "leave session");
  report.checks.push(
    "HTTP reason and retry, replaced iframe document rejection and rebinding, SPA new session, removal on browse",
  );
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  report.errors.push(String(e));
  throw e;
} finally {
  await writeFile(join(out, "results.json"), JSON.stringify(report, null, 2));
  clearTimeout(deadline);
  await context.close();
}
