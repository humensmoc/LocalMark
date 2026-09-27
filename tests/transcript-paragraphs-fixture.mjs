import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const out = "test-results/transcript-paragraphs";
export async function hoverCue(page, cue) {
  await cue.scrollIntoViewIfNeeded();
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const point = await cue.evaluate((e) => {
    const container = e.closest(".body").getBoundingClientRect();
    const r = [...e.getClientRects()].find(
      (r) =>
        r.width > 0 &&
        r.bottom > Math.max(0, container.top) &&
        r.top < Math.min(innerHeight, container.bottom),
    );
    return {
      x: r.left + Math.min(r.width / 2, 8),
      y:
        (Math.max(r.top, container.top, 0) +
          Math.min(r.bottom, container.bottom, innerHeight)) /
        2,
    };
  });
  await page.mouse.move(point.x, point.y);
}
export async function verifyTranscriptParagraphs(context, page, panel, site) {
  await mkdir(out, { recursive: true });
  const total = await panel.locator(".cue").count();
  assert.equal(total, 60);
  assert.equal(await panel.locator(".subtitle-paragraph").count(), 2);
  assert.deepEqual(await panel.locator(".paragraph-time").allTextContents(), [
    "0:00",
    "0:30",
  ]);
  await hoverCue(page, panel.locator(".cue").nth(5));
  const clock = panel.locator(".cue-time-button");
  await clock.waitFor({ state: "visible" });
  assert.equal(await clock.innerText(), "0:05");
  await hoverCue(page, panel.locator(".cue").nth(17));
  assert.equal(await clock.innerText(), "0:17");
  // The pointer can leave text and reach the timestamp without losing the popup.
  await clock.hover();
  await page.waitForTimeout(180);
  assert(await clock.isVisible());
  await page.screenshot({ path: `${out}/${site}-hover.png` });
  await page.keyboard.press("Escape");
  await clock.waitFor({ state: "hidden" });
  const settings = await context.newPage();
  settings.on("pageerror", (e) => console.log("Settings error", e.message));
  settings.on("requestfailed", (r) =>
    console.log("Settings request failed", r.url(), r.failure()?.errorText),
  );
  await settings.goto(
    context
      .serviceWorkers()[0]
      .url()
      .replace(/background\.js$/, "settings.html"),
  );
  const seconds = settings.getByLabel("每段时长（秒）");
  await seconds.waitFor({ timeout: 8000 }).catch(async (e) => {
    console.log(
      "Settings page",
      settings.url(),
      (await settings.content()).slice(0, 1200),
    );
    throw e;
  });
  await seconds.fill("15");
  await settings.getByRole("button", { name: "保存字幕设置" }).click();
  await settings.getByRole("status").filter({ hasText: "已保存" }).waitFor();
  await page.waitForFunction(
    () =>
      document
        .getElementById("localmark-video-transcript")
        ?.shadowRoot.querySelectorAll(".subtitle-paragraph").length === 4,
  );
  await settings.reload();
  await seconds.waitFor();
  await settings.waitForFunction(
    () => document.getElementById("transcript-interval").value === "15",
  );
  await seconds.fill("0");
  await settings.getByRole("button", { name: "保存字幕设置" }).click();
  await settings.getByRole("alert").filter({ hasText: "1～600" }).waitFor();
  assert.equal(await panel.locator(".subtitle-paragraph").count(), 4);
  await seconds.fill("60");
  await settings.getByRole("button", { name: "保存字幕设置" }).click();
  await page.waitForFunction(
    () =>
      document
        .getElementById("localmark-video-transcript")
        ?.shadowRoot.querySelectorAll(".subtitle-paragraph").length === 1,
  );
  await seconds.fill("30");
  await settings.getByRole("button", { name: "保存字幕设置" }).click();
  await page.waitForFunction(
    () =>
      document
        .getElementById("localmark-video-transcript")
        ?.shadowRoot.querySelectorAll(".subtitle-paragraph").length === 2,
  );
  if (site === "gdcvault")
    await settings.screenshot({ path: `${out}/settings.png` });
  await settings.close();
  const viewport = page.viewportSize(),
    layouts = [];
  for (const width of [900, 480, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await hoverCue(page, panel.locator(".cue").nth(5));
    await clock.waitFor({ state: "visible" }).catch(async (e) => {
      console.log(
        "Hover failure",
        site,
        width,
        await panel
          .locator(".cue")
          .nth(5)
          .evaluate((e) => ({
            rects: [...e.getClientRects()].map((r) => ({
              x: r.x,
              y: r.y,
              w: r.width,
              h: r.height,
            })),
            hover: e.matches(":hover"),
            body: e.closest(".body").getBoundingClientRect().toJSON(),
          })),
      );
      throw e;
    });
    const box = await clock.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width + 1);
    const column = await panel.locator(".subtitle-paragraph").first().evaluate(row => {
      const time = row.querySelector(".paragraph-time").getBoundingClientRect();
      const text = row.querySelector(".paragraph-text").getBoundingClientRect();
      const shell = row.closest(".body-shell").getBoundingClientRect();
      return { gutter: text.left - shell.left, gap: text.left - time.right };
    });
    assert(column.gutter <= 65, `subtitle text starts too far from the rail at ${width}px: ${column.gutter}px`);
    assert(column.gap >= 5, `subtitle time overlaps the text at ${width}px`);
    assert(
      await panel.evaluate(
        (h) =>
          h.shadowRoot.querySelector(".transcript").scrollWidth <=
          h.clientWidth + 1,
      ),
    );
    layouts.push({ width, clock: box, column });
    if (width === 320)
      await page.screenshot({ path: `${out}/${site}-320.png` });
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize(viewport);
  // Keyboard access reveals a timestamp and moves focus to that exact button.
  await panel.locator(".cue").nth(5).focus();
  await clock.waitFor({ state: "visible" });
  await panel.locator(".cue").nth(5).press("Enter");
  assert(await clock.evaluate((e) => e.getRootNode().activeElement === e));
  await page.keyboard.press("Escape");
  await writeFile(
    `${out}/${site}.json`,
    JSON.stringify(
      {
        total,
        layouts,
        settings:
          "30->15 (persisted)->invalid 0 rejected->60->30; updates existing panel",
      },
      null,
      2,
    ),
  );
  console.log(site + " paragraph settings/hover checks passed");
}
