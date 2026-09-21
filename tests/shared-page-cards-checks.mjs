import assert from "node:assert/strict";
import { join } from "node:path";

export async function checkSharedPageCards({ page, context, view, out, releaseArtwork }) {
  await view("网页");
  const source = page.locator(".webpage-card").first();
  const id = await source.getAttribute("data-page-id");
  const inspect = node => {
    const styles = (el, properties) => el ? Object.fromEntries(properties.map(p => [p, getComputedStyle(el)[p]])) : null;
    return {
      card: styles(node, ["padding", "borderRadius", "backgroundColor", "borderTopColor"]),
      title: styles(node.querySelector(".tag-page-title"), ["fontSize", "fontWeight", "lineHeight"]),
      tags: [...node.querySelectorAll(".result-taxonomy > span")].map(el => [el.textContent, styles(el,["fontSize","backgroundColor","color"])]),
      stats: node.querySelector(".result-stats")?.textContent,
      statStyles: styles(node.querySelector(".result-stats strong"), ["fontSize", "fontWeight"]),
      comment: node.querySelector(".result-comment > p")?.textContent,
      rating: styles(node.querySelector(".rating-dots"), ["position", "bottom", "right", "color"]),
      expanders: node.querySelectorAll("summary,details").length,
    };
  };
  // Clear the current detail selection so its highlight border is not compared.
  if (await source.getAttribute("class").then(c => c.includes("selected-article"))) {
    await page.locator(".webpage-card .tag-page-title").nth(1).click();
  }
  const reference = await source.evaluate(inspect);
  const sidebar = await context.newPage();
  const checkGap = async () => {
    const cards = sidebar.locator(".webpage-card");
    const first = await cards.nth(0).boundingBox(), second = await cards.nth(1).boundingBox();
    assert.ok(Math.abs(second.y - first.y - first.height - 10) < 1, "sidebar webpage cards keep the dashboard's 10px spacing");
  };
  try {
    await sidebar.setViewportSize({ width: 360, height: 900 });
    await sidebar.goto(new URL("sidepanel.html", page.url()).href);
    await sidebar.getByRole("button", { name: "最近网页", exact: true }).click();
    const card = sidebar.locator(`.webpage-card[data-page-id="${id}"]`);
    await card.waitFor();
    assert.deepEqual(await card.evaluate(inspect), reference, "recent cards share the dashboard webpage styles and information");
    await checkGap();
    await sidebar.screenshot({ path: join(out,"shared-recent-cards.png") });
    await sidebar.getByRole("button", { name: "标签", exact: true }).click();
    await card.waitFor();
    assert.deepEqual(await card.evaluate(inspect), reference, "tag cards share the dashboard webpage styles and information");
    await checkGap();
    await sidebar.screenshot({ path: join(out,"shared-tag-cards.png") });
    for (const width of [480,360,320]) {
      await sidebar.setViewportSize({ width, height: 900 });
      assert.equal(await sidebar.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await card.locator(".tag-page-title").focus();
      assert.equal(await card.locator(".tag-page-title").evaluate(el=>document.activeElement===el),true);
    }
    await sidebar.getByRole("button", { name: "最近网页", exact: true }).click();
    await sidebar.screenshot({ path: join(out,"shared-recent-320.png") });
  } finally { await sidebar.close(); }
  const metadata = await page.evaluate(async id => {
    const { data } = await chrome.runtime.sendMessage({ type: "snapshot" });
    return data.entries[id].page;
  }, id);
  for (const [viewName, name] of [["主分类", metadata.category], ["子标签", metadata.tags[0]]]) {
    await view(viewName);
    await page.locator(".catalog-card").filter({ has: page.locator(".catalog-card-title strong", { hasText: new RegExp(`^${name}$`) }) }).click();
    const related = page.locator(`.catalog-related .webpage-card[data-page-id="${id}"]`);
    await related.waitFor();
    await page.mouse.move(0, 0);
    assert.deepEqual(await related.evaluate(inspect), reference, `${viewName} related webpages use the shared card, metadata and rating layout`);
    const cards = page.locator(".catalog-related .webpage-card");
    const first = await cards.nth(0).boundingBox(), second = await cards.nth(1).boundingBox();
    assert.ok(Math.abs(second.y - first.y - first.height - 10) < 1);
    await related.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, viewName === "主分类" ? "shared-category-related.png" : "shared-tag-related.png") });
    await related.locator(".tag-page-title").focus();
    await related.locator(".tag-page-title").press("Enter");
    await page.locator(`.tag-results .webpage-card[data-page-id="${id}"].selected-article`).waitFor();
  }
  // Imported bookmarks can have no comments/highlights and slow favicon URLs.
  // They must still look identical in the library and both related lists.
  const emptyId = "0000000000000006";
  await view("网页");
  const emptySource = page.locator(`.tag-results .webpage-card[data-page-id="${emptyId}"]`);
  await emptySource.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const emptyReference = await emptySource.evaluate(inspect);
  const emptyMetadata = await page.evaluate(async id => (await chrome.runtime.sendMessage({ type: "snapshot" })).data.entries[id].page, emptyId);
  for (const [viewName, name] of [["主分类", emptyMetadata.category], ["子标签", emptyMetadata.tags[0]]]) {
    await view(viewName);
    await page.locator(".catalog-card").filter({ has: page.locator(".catalog-card-title strong", { hasText: new RegExp(`^${name}$`) }) }).click();
    const related = page.locator(`.catalog-related .webpage-card[data-page-id="${emptyId}"]`);
    await related.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    assert.deepEqual(await related.evaluate(inspect), emptyReference);
    assert.equal(await related.locator(".result-stats,.result-comment").count(), 0, "empty metadata does not invent stats or comments");
    for (const selector of [".site-icon", ".site-backdrop"]) {
      assert.equal(await related.locator(`${selector} > .site-monogram`).isVisible(), true, "site artwork stays visible while the favicon loads");
    }
    await page.screenshot({ path: join(out, viewName === "主分类" ? "related-empty-category.png" : "related-empty-tag.png") });
    await page.setViewportSize({ width: 320, height: 900 });
    await related.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const meta = await related.locator(".result-taxonomy").boundingBox(), rating = await related.locator(".rating-dots").boundingBox();
    assert.ok(meta.x + meta.width <= rating.x - 9, "tags leave room for the rating in a narrow related card");
    await page.screenshot({ path: join(out, viewName === "主分类" ? "related-empty-category-320.png" : "related-empty-tag-320.png") });
    await page.setViewportSize({ width: 1920, height: 1080 });
  }
  releaseArtwork();
  const loaded = page.locator(`.catalog-related .webpage-card[data-page-id="${emptyId}"]`);
  await loaded.scrollIntoViewIfNeeded();
  await loaded.locator(".site-icon > img:not(.is-loading)").waitFor();
  await loaded.locator(".site-backdrop > img:not(.is-loading)").waitFor();
  assert.equal(await loaded.locator(".site-monogram").count(), 0, "loaded favicon replaces both fallbacks");
  await page.screenshot({ path: join(out, "related-empty-artwork-loaded.png") });
}
