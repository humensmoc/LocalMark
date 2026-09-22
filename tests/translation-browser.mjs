import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { JSDOM, VirtualConsole } from "jsdom";
import assert from "node:assert/strict";

const output = resolve("test-results");
await mkdir(output, { recursive: true });
const W = ".immersive-translate-target-wrapper";
let body = `<p id="mwFw" data-imt-p="1">With a web annotation system, a user can add information to a Web resource.<font class="notranslate immersive-translate-target-wrapper" lang="zh-CN"><br><font class="immersive-translate-target-inner">借助网页标注系统，用户可以添加网页资源的信息。</font></font></p>`;
// Parse the supplied snapshot without running scripts or loading resources.
if (process.argv[2]) {
  const d = new JSDOM(await readFile(process.argv[2], "utf8"), {
    virtualConsole: new VirtualConsole(),
  }).window.document;
  body = d.querySelector("#mwFw").outerHTML;
}
let initial = "dual";
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<html imt-state="${initial}"><head><title>沉浸式翻译高亮验证</title><style>
body{font:18px/1.9 system-ui;margin:40px auto;max-width:820px;padding:0 24px;color:#243342}
[imt-state="original"] ${W}{display:none} ${W}{display:block;margin-top:12px}
h1{font-size:26px} a{color:#275e9b}
</style></head><body><h1>中英文切换与摘录定位</h1>${body}</body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "localmark-translation-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 850 },
  args: ["--enable-unsafe-extension-debugging"],
  ignoreDefaultArgs: ["--disable-extensions"],
});
const errors = [];
context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
const until = async (fn, label) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out: " + label);
};
try {
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() =>
    chrome.developerPrivate.updateProfileConfiguration({
      inDeveloperMode: true,
    }),
  );
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send("Extensions.loadUnpacked", { path: resolve("dist") });
  await manager.close();
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  await page.goto(base + "/article");
  const bridge = () =>
    worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
      return chrome.tabs.sendMessage(tab.id, { type: "ping" });
    }, page.url());
  const controller = await context.newPage();
  await controller.goto(
    `chrome-extension://${new URL(worker.url()).host}/settings.html`,
  );
  const state = () =>
    controller.evaluate(
      async () => (await chrome.runtime.sendMessage({ type: "snapshot" })).data,
    );
  const marks = async () =>
    Object.values((await state()).entries).find(
      (e) => e.page.url === page.url(),
    )?.page.annotations ?? [];
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  async function exposeOverlay() {
    await page.locator("#local-web-clipper-root").waitFor();
    const session = await context.newCDPSession(page),
      worlds = [];
    session.on("Runtime.executionContextCreated", ({ context }) =>
      worlds.push(context),
    );
    await session.send("Runtime.enable");
    const { root } = await session.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    function find(n) {
      if (n.attributes?.includes("local-web-clipper-root")) return n;
      for (const child of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
        const found = find(child);
        if (found) return found;
      }
    }
    const host = find(root);
    for (const executionContextId of [
      undefined,
      worlds.find((w) => w.name.includes("playwright"))?.id,
    ]) {
      const { object } = await session.send("DOM.resolveNode", {
        backendNodeId: host.shadowRoots[0].backendNodeId,
        executionContextId,
      });
      await session.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration:
          'function(){const root=this;Object.defineProperty(this.host,"shadowRoot",{get:()=>root,configurable:true});}',
      });
    }
    await session.detach();
  }
  await exposeOverlay();
  await page.bringToFront();
  assert.equal((await bridge()).version, version);
  const originalTranslation = await page
    .locator("#mwFw .immersive-translate-target-inner")
    .innerText();
  await page.evaluate(() => {
    const e = document.querySelector("#mwFw .immersive-translate-target-inner");
    const r = document.createRange();
    r.selectNodeContents(e);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    const rect = e.getBoundingClientRect();
    e.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        button: 0,
        clientX: rect.left + 80,
        clientY: rect.top + 20,
      }),
    );
  });
  const host = page.locator("#local-web-clipper-root");
  await host.getByLabel("高亮选中文字", { exact: true }).click();
  await until(
    async () => (await marks()).length === 1,
    "mark saved through page UI",
  );
  const [mark] = await marks();
  assert.equal(mark.anchor.basis, "source");
  assert.ok(mark.anchor.segments[0].translation);
  assert.equal(
    mark.text.replace(/\s+/g, " ").trim(),
    originalTranslation.replace(/\s+/g, " ").trim(),
  );
  assert.ok(mark.anchor.exact.startsWith("With a web annotation system"));
  const drawn = (name) =>
    page.evaluate(
      (name) =>
        [...(CSS.highlights.get(name) ?? [])].map((r) => r.toString()).join(""),
      name,
    );
  await until(
    async () => (await bridge()).located.includes(mark.id),
    "exact location",
  );
  assert.ok((await drawn("wc-yellow")).includes("网页"));
  // Saving a comment and receiving sync snapshots must not replace the
  // existing Highlight or any of its resolved ranges.
  await page.evaluate(() => {
    globalThis.noteHighlight = CSS.highlights.get("wc-yellow");
    globalThis.noteRanges = [...globalThis.noteHighlight];
  });
  await page.locator("#mwFw .immersive-translate-target-inner").click();
  await host.locator("#wc-note").fill("更新评论不重新定位原文");
  await host.getByRole("button", { name: "确认保存", exact: true }).click();
  await until(async () => (await marks())[0].note === "更新评论不重新定位原文", "comment persisted");
  await host.locator(".editor").waitFor({ state: "detached" });
  await page.waitForTimeout(350); // Include the debounced file-sync notification.
  assert.ok(await page.evaluate(() => {
    const current = CSS.highlights.get("wc-yellow");
    return current === globalThis.noteHighlight &&
      [...current].every((range, i) => range === globalThis.noteRanges[i]);
  }), "comment-only saves preserve the highlight registry and ranges");
  Object.assign(mark, (await marks())[0]);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: join(output, "translation-dual.png") });
  await page.evaluate(() =>
    document.documentElement.setAttribute("imt-state", "original"),
  );
  await until(
    async () => (await bridge()).approximate.includes(mark.id),
    "attribute-only toggle",
  );
  assert.equal(await drawn("wc-yellow"), "");
  assert.ok(
    (await drawn("wc-context-yellow")).startsWith(
      "With a web annotation system",
    ),
  );
  await page.screenshot({ path: join(output, "translation-original.png") });
  await page.evaluate(() =>
    document.documentElement.setAttribute("imt-state", "dual"),
  );
  await until(
    async () => !(await bridge()).approximate.includes(mark.id),
    "translation visible again",
  );
  const wrapperHTML = await page.locator(W).evaluate((e) => e.outerHTML);
  await page.locator(W).evaluate((e) => e.remove());
  await until(
    async () => (await bridge()).approximate.includes(mark.id),
    "removed translation",
  );
  await page
    .locator("#mwFw")
    .evaluate(
      (e, html) => e.insertAdjacentHTML("beforeend", html),
      wrapperHTML,
    );
  await until(
    async () => !(await bridge()).approximate.includes(mark.id),
    "reinserted translation",
  );
  await page
    .locator(".immersive-translate-target-inner")
    .evaluate(
      (e) => (e.textContent = "新的中文翻译，与原来的句子使用不同措辞。"),
    );
  await until(
    async () => (await bridge()).approximate.includes(mark.id),
    "changed translation",
  );
  assert.equal(await drawn("wc-yellow"), "");
  assert.equal(
    await drawn("wc-context-yellow"),
    "新的中文翻译，与原来的句子使用不同措辞。",
  );
  assert.equal((await marks())[0].text, mark.text);
  await page.setViewportSize({ width: 420, height: 850 });
  await page.screenshot({
    path: join(output, "translation-changed-narrow.png"),
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  initial = "original";
  await page.reload();
  await page.locator("#local-web-clipper-root").waitFor();
  await until(
    async () => (await bridge()).approximate.includes(mark.id),
    "restore original after reload",
  );
  initial = "dual";
  await page.reload();
  await page.locator("#local-web-clipper-root").waitFor();
  await until(
    async () =>
      (await bridge()).located.includes(mark.id) &&
      !(await bridge()).approximate.includes(mark.id),
    "restore exact after reload",
  );
  assert.deepEqual((await marks())[0], mark);
  await exposeOverlay();
  await page.setViewportSize({ width: 1280, height: 900 });
  const bilingual = `<p data-imt-p="1">Which will you choose?<font class="immersive-translate-target-wrapper"><font class="immersive-translate-target-inner">你会选择哪一个？</font></font></p><p data-imt-p="1">The action that helps me win.<font class="immersive-translate-target-wrapper"><font class="immersive-translate-target-inner">帮助我取得胜利的行动。</font></font></p>`;
  const layouts = [
    {
      name: "bilingual",
      html: bilingual,
      text: "Which will you choose?\n你会选择哪一个？\n\nThe action that helps me win.\n帮助我取得胜利的行动。",
    },
    {
      name: "ordinary",
      html: "<p>First paragraph.<br>A new line.</p><p>Second paragraph.</p><ul><li>First item</li><li>Second item</li></ul>",
      text: "First paragraph.\nA new line.\n\nSecond paragraph.\n\nFirst item\n\nSecond item",
    },
  ];
  for (const layout of layouts) {
    const beforeCount = (await marks()).length;
    await page.evaluate((html) => {
      document.querySelector("#layout-fixture")?.remove();
      const section = document.createElement("section");
      section.id = "layout-fixture";
      section.innerHTML = html;
      document.querySelector("h1").after(section);
      const r = document.createRange();
      r.selectNodeContents(section);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      section.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          button: 0,
          clientX: 640,
          clientY: 130,
        }),
      );
    }, layout.html);
    await host.getByLabel("高亮选中文字", { exact: true }).hover();
    await host.locator(".editor .excerpt").waitFor();
    assert.equal(
      await host.locator(".editor .excerpt").textContent(),
      layout.text,
    );
    assert.equal(
      await host
        .locator(".editor .excerpt")
        .evaluate((e) => getComputedStyle(e).whiteSpace),
      "pre-wrap",
    );
    const comment = `评论第一行\n评论第二行：${"长内容".repeat(24)}\n\n评论末尾`;
    await host.locator("#wc-note").fill(comment);
    await host.getByRole("button", { name: "确认保存", exact: true }).click();
    await until(
      async () => (await marks()).length === beforeCount + 1,
      "formatted quote saved",
    );
    const saved = (await marks()).at(-1);
    assert.equal(saved.text, layout.text);
    await host.locator(".editor").waitFor({ state: "detached" });
    await until(
      async () => (await bridge()).located.includes(saved.id),
      "formatted quote located",
    );
    await page.mouse.move(4, 4);
    await host
      .getByLabel("定位：" + saved.text.slice(0, 25), { exact: true })
      .hover();
    await host.locator(".hover-note").waitFor();
    assert.equal(await host.locator(".tooltip").innerText(), comment);
    assert.equal(
      await host
        .locator(".hover-note")
        .evaluate((e) => getComputedStyle(e).whiteSpace),
      "pre-wrap",
    );
    await host.locator(".tooltip").evaluate(async el => {
      await Promise.all(el.getAnimations().map(a => a.finished.catch(() => {})));
    });
    await page.screenshot({ path: join(output, `quote-layout-${layout.name}.png`) });
    await host
      .getByLabel("定位：" + saved.text.slice(0, 25), { exact: true })
      .evaluate((e) => e.blur());
    await page.setViewportSize({ width: 420, height: 900 });
    await page.mouse.move(410, 880);
    await host
      .getByLabel("定位：" + saved.text.slice(0, 25), { exact: true })
      .hover();
    await host.locator(".hover-note").waitFor();
    const box = await host.locator(".tooltip").boundingBox();
    assert.ok(
      box.x >= 0 && box.x + box.width <= 420,
      "tooltip fits narrow viewport",
    );
    await page.screenshot({
      path: join(output, `quote-layout-${layout.name}-narrow.png`),
    });
    await host
      .getByLabel("定位：" + saved.text.slice(0, 25), { exact: true })
      .evaluate((e) => e.blur());
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Chinese UI capture, comment-only save preserves highlights, persistence, original/dual attribute toggle, removal/reinsertion, changed wording, reload in both states, bilingual and ordinary excerpt line breaks in editor/storage, comment-only hover with line breaks, narrow layout, build version, no page errors.",
  );
} finally {
  await context.close();
  await new Promise((r) => server.close(r));
}
