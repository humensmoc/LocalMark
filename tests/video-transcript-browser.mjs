import { fixture } from "./video-native-fixture.mjs";
import { hoverCue, verifyTranscriptParagraphs } from "./transcript-paragraphs-fixture.mjs";
import { chromium } from "playwright";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const out = resolve("test-results/video-transcript");
await mkdir(out, { recursive: true });
const live = process.argv.includes("--live");
const context = await chromium.launchPersistentContext(
  await mkdtemp(join(tmpdir(), "localmark-transcript-")),
  {
    channel: "chromium",
    headless: true,
    viewport: { width: 1600, height: 1000 },
    args: ["--enable-unsafe-extension-debugging"],
    ignoreDefaultArgs: ["--disable-extensions"],
  },
);
const report = { live, checks: [], errors: [], pages: [] };
context.setDefaultTimeout(12000);
const deadline = setTimeout(() => {
  console.error("Transcript browser test deadline exceeded");
  void context.close();
}, 90000);
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const until = async (fn, label) => {
  for (let i = 0; i < 120; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error("Timeout: " + label);
};
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
let mode = "normal",
  delayOld = false;
const cueText = (i) =>
  i === 0
    ? "第一条字幕 First subtitle"
    : i === 1
      ? "需要查找的字幕 Search this line"
      : i === 2
        ? "<img src=x onerror=alert(1)>"
        : `字幕 ${i} ${"长内容".repeat(i === 3 ? 40 : 3)}`;
if (!live)
  await context.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.protocol === "chrome-extension:") return route.continue();
    if (u.pathname === "/test.wav") {
      const range = route
        .request()
        .headers()
        .range?.match(/bytes=(\d+)-(\d*)/);
      const start = range ? Number(range[1]) : 0,
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
    if (u.pathname.includes("/youtubei/")) {
      assert.equal(
        route.request().headers()["x-native-client"],
        "website-context",
        "Only the website may request the transcript",
      );
      const params = route.request().postDataJSON().params;
      if (delayOld && params === "en") {
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (mode === "http")
        return route.fulfill({
          status: 403,
          json: { error: { message: "Precondition check failed" } },
        });
      return route.fulfill({
        json:
          mode === "empty"
            ? {}
            : {
                items: Array.from({ length: 60 }, (_, i) => ({
                  transcriptSegmentRenderer: {
                    startMs: String(i * 1000),
                    endMs: String((i + 1) * 1000),
                    snippet: {
                      runs: [
                        { text: (params === "zh" ? "中文 " : "") + cueText(i) },
                      ],
                    },
                  },
                })),
                footer: {
                  subMenuItems: ["en", "zh"].map((id) => ({
                    title: id === "en" ? "English" : "中文",
                    selected: id === params,
                    continuation: {
                      reloadContinuationData: { continuation: id },
                    },
                  })),
                },
              },
      });
    }
    if (u.hostname === "api.bilibili.com") {
      assert(
        u.pathname.includes("/wbi/"),
        "Do not request an independent unsigned Bilibili endpoint",
      );
      if (u.pathname.endsWith("/view"))
        return route.fulfill({
          json: {
            code: 0,
            data: {
              aid: 123,
              pages: [
                { page: 1, cid: 1 },
                { page: 2, cid: 2 },
              ],
            },
          },
        });
      return route.fulfill({
        json: {
          code: 0,
          data: {
            bvid: "BVtest",
            aid: 123,
            cid: Number(u.searchParams.get("cid")),
            page_no: Number(u.searchParams.get("cid")),
            subtitle: {
              need_login_subtitle: mode === "login",
              subtitles:
                mode === "login"
                  ? []
                  : ["zh", "en"].map((lan) => ({
                      id_str: lan,
                      lan,
                      lan_doc: lan === "zh" ? "中文" : "English",
                      subtitle_url: `https://aisubtitle.hdslb.com/subtitle/${lan}-${u.searchParams.get("cid")}.json`,
                    })),
            },
          },
        },
      });
    }
    if (u.hostname === "aisubtitle.hdslb.com")
      return route.fulfill({
        json: {
          body: Array.from({ length: 60 }, (_, i) => ({
            from: i,
            to: i + 1,
            content: `${u.pathname.includes("-2") ? "分P二 " : ""}${u.pathname.includes("/en") ? "English " : ""}${cueText(i)}`,
          })),
        },
      });
    if (["www.youtube.com", "www.bilibili.com"].includes(u.hostname))
      return route.fulfill({
        contentType: "text/html",
        body: fixture(u.hostname.includes("youtube") ? "youtube" : "bilibili"),
      });
    return route.abort();
  });
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
  for (const site of ["bilibili", "youtube"]) {
    console.log("Checking", site);
    mode = "normal";
    const p = await context.newPage();
    p.on("pageerror", (e) => report.errors.push(`${site}: ${e.message}`));
    if (!live)
      p.on("console", (m) => {
        if (m.type() === "error")
          report.errors.push(`${site} console: ${m.text()}`);
      });
    const url =
      site === "bilibili"
        ? `https://www.bilibili.com/video/${live ? "BV1VxhU6BEKq" : "BVtest"}/`
        : `https://www.youtube.com/watch?v=${live ? "Z9KSwtVrCMg&list=PLCjcnzyqKMUdPtC7J1FILmufVfgyI-nAo&index=6" : "first"}`;
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const panel = p.locator("#localmark-video-transcript");
    if (!live && site === "bilibili") {
      await p.waitForLoadState("load");
      await p.waitForTimeout(1400); // More than two placement polls after load.
      assert.equal(
        await panel.count(),
        0,
        "Do not insert into pending SSR markup",
      );
      assert(
        await p.evaluate(
          () =>
            document.querySelector(".right-container").innerHTML ===
            window.biliServerMarkup,
        ),
        "The website must receive its original subtree when it hydrates",
      );
      await p.evaluate(() =>
        document.querySelector("#app").removeAttribute("data-server-rendered"),
      );
      report.checks.push(
        "Bilibili: SSR subtree stays intact after document load until the app hydrates",
      );
    }
    await panel.waitFor();
    await until(
      async () =>
        (await panel.locator(".cue").count()) > 0 ||
        (await panel.locator(".error").count()) > 0,
      site + " source result",
    );
    assert(
      (await panel.locator(".transcript").innerText()).includes(`v${version}`),
    );
    if (live) {
      report.pages.push({
        site,
        url: p.url(),
        text: (await panel.locator(".transcript").innerText()).slice(0, 1600),
        cues: await panel.locator(".cue").count(),
        rect: await panel.boundingBox(),
      });
      await p.screenshot({ path: join(out, `${site}-live.png`) });
      await panel.screenshot({ path: join(out, `${site}-live-panel.png`) });
      await p.close();
      continue;
    }
    assert.equal(await panel.locator(".cue").count(), 60);
    if (site === "bilibili")
      assert.equal(
        await panel.getByLabel("字幕语言", { exact: true }).inputValue(),
        "en",
        "Initial language follows the native player",
      );
    const placement = await p.evaluate((site) => {
      const h = document.querySelector("#localmark-video-transcript");
      return site === "youtube"
        ? h.parentElement.firstElementChild === h
        : h.nextElementSibling.id === "danmukuBox" &&
            h.previousElementSibling.classList.contains("up-info-container");
    }, site);
    assert(placement);
    await verifyTranscriptParagraphs(context, p, panel, site);
    await panel.getByRole("button", { name: "搜索字幕", exact: true }).click();
    const search = panel.getByRole("searchbox");
    await search.fill("Search this");
    assert.equal(await panel.locator(".cue").count(), 1);
    await search.fill("no match");
    assert.equal(await panel.locator(".cue").count(), 0);
    await search.fill("");
    assert.equal(await panel.locator(".cues img").count(), 0);
    console.log(site, "source, placement, search passed");
    await until(
      () =>
        p
          .locator("video")
          .evaluate((v) => v.seekable.length > 0 && v.seekable.end(0) > 10),
      "media seekable",
    );
    await p.locator("video").evaluate(async (v) => {
      await Promise.race([
        v.play(),
        new Promise((_, reject) =>
          setTimeout(() => reject(Error("Media play timed out")), 5000),
        ),
      ]);
    });
    await hoverCue(p, panel.locator(".cue").nth(5));
    await panel.locator(".cue-time-button").click();
    try {
      await until(
        () =>
          p
            .locator("video")
            .evaluate((v) => v.paused && Math.abs(v.currentTime - 5) < 0.1),
        "seek and pause",
      );
    } catch (error) {
      console.log(
        "seek diagnostics",
        await p.locator("video").evaluate((v) => ({
          current: v.currentTime,
          paused: v.paused,
          ready: v.readyState,
          duration: v.duration,
          seekable: Array.from({ length: v.seekable.length }, (_, i) => [
            v.seekable.start(i),
            v.seekable.end(i),
          ]),
        })),
        await panel.locator(".transcript").innerText(),
      );
      throw error;
    }
    await panel.getByLabel("字幕语言", { exact: true }).selectOption("zh");
    await until(
      async () =>
        !(await panel.locator("[aria-busy=true]").count()) &&
        (await panel.locator(".cue").first().innerText()).includes(
          site === "youtube" ? "中文" : "第一条",
        ),
      "language",
    );
    if (site === "bilibili") {
      await p.evaluate(() => window.nativeBili("en"));
      await until(
        async () =>
          (await panel.getByLabel("字幕语言", { exact: true }).inputValue()) ===
          "en",
        "native language changed back to a cached file",
      );
    }
    await panel.locator(".heading").click();
    assert.equal(await panel.locator(".body").count(), 0);
    await panel.locator(".heading").click();
    await p.screenshot({ path: join(out, `${site}-wide.png`) });
    for (const width of [900, 480, 320]) {
      await p.setViewportSize({ width, height: 800 });
      const overflow = await panel.evaluate((h) => {
        const t = h.shadowRoot.querySelector(".transcript");
        return (
          t.scrollWidth > t.clientWidth + 1 ||
          document.documentElement.scrollWidth > innerWidth + 1
        );
      });
      assert(!overflow, `${site} overflow ${width}`);
    }
    await panel.screenshot({ path: join(out, `${site}-320.png`) });
    if (site === "bilibili") {
      await p.evaluate(() => {
        const app = document.querySelector("#app"),
          replacement = app.cloneNode(true);
        replacement.querySelector("#localmark-video-transcript")?.remove();
        replacement.setAttribute("data-server-rendered", "true");
        app.replaceWith(replacement);
        window.biliServerMarkup =
          replacement.querySelector(".right-container").innerHTML;
      });
      await p.waitForTimeout(1400);
      assert.equal(
        await panel.count(),
        0,
        "Replacement SSR root must also be left alone",
      );
      assert(
        await p.evaluate(
          () =>
            document.querySelector(".right-container").innerHTML ===
            window.biliServerMarkup,
        ),
      );
      await p.evaluate(() =>
        document.querySelector("#app").removeAttribute("data-server-rendered"),
      );
      await panel.waitFor();
      assert.equal(await panel.locator(".cue").count(), 60);
      report.checks.push(
        "Bilibili: replacement SSR root waits, then restores one subtitle panel",
      );
      await p.evaluate(async () => {
        history.pushState({}, "", location.pathname + "?p=2");
        await window.nativeBili();
      });
      await until(
        async () =>
          (await panel.locator(".cue").first().innerText()).includes("分P二"),
        "Bilibili P2",
      );
      mode = "login";
      await p.evaluate(() => window.nativeBili());
      await panel.locator(".error").waitFor();
      assert(
        (await panel.locator(".transcript").innerText()).includes("需要登录"),
      );
    } else {
      mode = "http";
      await p.evaluate(() => {
        document
          .querySelector("ytd-engagement-panel-section-list-renderer")
          ?.remove();
        return window.nativeYoutube();
      });
      await panel.locator(".error").waitFor();
      assert(
        (await panel.locator(".transcript").innerText()).includes("HTTP 403"),
      );
      mode = "normal";
      // User opens the native panel AFTER the plugin's error; no plugin retry.
      await p
        .locator("ytd-video-description-transcript-section-renderer button")
        .click();
      await until(
        async () => (await panel.locator(".cue").count()) === 60,
        "retry recovery",
      );
      delayOld = true;
      await p.evaluate(() => {
        void window.nativeYoutube("en");
      });
      await p.evaluate(() => {
        history.pushState({}, "", "/watch?v=second");
        document
          .querySelector("ytd-watch-flexy")
          .setAttribute("video-id", "second");
        document.querySelector("ytd-watch-flexy").data = {
          getTranscriptEndpoint: { params: "zh" },
        };
        document
          .querySelector("ytd-engagement-panel-section-list-renderer")
          ?.remove();
      });
      await until(
        async () =>
          (await panel.locator(".cue").first().innerText()).includes("中文"),
        "YouTube SPA",
      );
      await p.waitForTimeout(2400);
      assert(
        (await panel.locator(".cue").first().innerText()).includes("中文"),
      );
      delayOld = false;
    }
    report.checks.push(
      `${site}: placement, version, 60 cues, search, safe text, real media seek/pause, languages, collapse, 900/480/320px, errors, SPA`,
    );
    await p.evaluate(() => history.pushState({}, "", "/"));
    await until(async () => (await panel.count()) === 0, "leave video");
    await p.close();
  }
  if (!live)
    assert.deepEqual(
      report.errors.filter((e) => !e.includes("403")),
      [],
    );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.errors.push(String(error));
  for (const page of context.pages()) {
    const panel = page.locator("#localmark-video-transcript .transcript");
    if (await panel.count())
      console.log("Failure panel", page.url(), await panel.innerText());
  }
  throw error;
} finally {
  clearTimeout(deadline);
  await writeFile(
    join(out, live ? "live-results.json" : "results.json"),
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
