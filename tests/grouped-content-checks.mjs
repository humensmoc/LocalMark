import assert from "node:assert/strict";
import { join } from "node:path";

export async function checkGroupedContent(page, view, out) {
  const pages = await page.evaluate(async () => {
    const { data } = await chrome.runtime.sendMessage({ type: "snapshot" });
    return Object.values(data.entries).map(entry => entry.page);
  });
  const mode = () => page.getByRole("switch", { name: "按网页分组", exact: true });
  const verifyFrozenHeading = async () => {
    const collection = page.locator(".content-collection");
    await collection.evaluate(node => { node.scrollTop = 0; });
    const heading = collection.locator(":scope > .collection-heading");
    const before = await heading.boundingBox();
    await collection.evaluate(node => { node.scrollTop = 650; });
    await page.waitForFunction(() => document.querySelector(".content-collection").scrollTop > 100);
    const after = await heading.boundingBox();
    assert.ok(Math.abs(after.y - before.y) < 1, "highlight count and grouping controls stay below the filters when scrolling");
    assert.equal(await mode().evaluate(node => {
      const box = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }), true, "scrolled cards never cover the grouping control");
    await page.screenshot({ path: join(out, `highlight-heading-scrolled-${page.viewportSize().width}.png`) });
    await collection.evaluate(node => { node.scrollTop = 0; });
  };
  const verify = async ({ query = "", category = "", singleColumn = false, grouped = true } = {}) => {
    const matching = pages.filter(p => !category || p.category === category).flatMap(p => p.annotations.map(mark => ({ page: p, mark })))
      .filter(({ page: p, mark }) => [p.title, p.url, p.category, ...p.tags, mark.text, mark.note].join("\n").includes(query))
      .sort((a, b) => b.mark.updatedAt.localeCompare(a.mark.updatedAt));
    const expected = new Map();
    for (const item of matching) {
      if (!expected.has(item.page.id)) expected.set(item.page.id, []);
      expected.get(item.page.id).push(item.mark);
    }
    await page.waitForFunction(count => document.querySelectorAll(".content-card").length === count, matching.length);
    await page.waitForFunction(() => [...document.querySelectorAll(".content-card")].every(card => card.style.width && card.getBoundingClientRect().height > 0));
    if (!grouped) {
      assert.equal(await page.locator(".content-page-group").count(), 0);
      assert.equal(await page.locator(".content-source").count(), matching.length);
      assert.equal(await page.locator(".content-page-tags").count(), matching.length);
      assert.deepEqual(await page.locator(".content-card").evaluateAll(nodes => nodes.map(n => n.dataset.markId)), matching.map(x => x.mark.id));
      return [];
    }
    await page.waitForFunction(() => document.querySelectorAll(".content-group-outlines path").length === document.querySelectorAll(".content-page-group").length);
    const groups = await page.locator(".grouped-content-flow").evaluate(root => {
      const origin = root.getBoundingClientRect();
      const paths = [...root.querySelectorAll(".content-group-outlines path")];
      return [...root.querySelectorAll(".content-page-group")].map((group, i) => {
        const path = paths[i];
        return { id: group.dataset.pageId, path: path.getAttribute("d"), fill: getComputedStyle(path).fill, stroke: getComputedStyle(path).stroke,
          cards: [...group.children].map(card => {
            const box = card.getBoundingClientRect();
            const x = box.x - origin.x, y = box.y - origin.y;
            return { id: card.dataset.markId, pageId: card.dataset.pageId, x, y, width: box.width, height: box.height,
              inside: [[x,y],[x+box.width,y],[x,y+box.height],[x+box.width,y+box.height]].every(([a,b]) => path.isPointInFill(new DOMPoint(a,b))),
              sources: card.querySelectorAll(".content-source").length, tags: card.querySelectorAll(".result-taxonomy").length,
              note: card.querySelector(".content-note p")?.textContent ?? "", text: card.querySelector("blockquote")?.textContent };
          }) };
      });
    });
    assert.deepEqual(groups.map(g => g.id), [...expected.keys()]);
    for (const group of groups) {
      assert.equal(group.cards[0].pageId, group.id, "first card is dedicated webpage information");
      assert.equal(group.cards[0].id, undefined);
      assert.equal(group.cards[0].tags, 1);
      assert.equal(group.cards[0].text, undefined, "webpage information does not consume the first excerpt");
      const marks = expected.get(group.id);
      assert.deepEqual(group.cards.slice(1).map(c => c.id), marks.map(m => m.id));
      for (const [i, card] of group.cards.entries()) {
        assert.ok(card.inside, "all four card corners stay in their webpage's outline");
        if (i) {
          assert.equal(card.sources, 0); assert.equal(card.tags, 0);
          assert.equal(card.text, marks[i - 1].text);
          assert.equal(card.note, marks[i - 1].note.trim() ? marks[i - 1].note : "");
          assert.ok(card.height <= 481);
        }
      }
    }
    let previousBottom = -27;
    for (const group of groups) {
      const columns = new Map();
      for (const card of group.cards) {
        const x = Math.round(card.x);
        if (!columns.has(x)) columns.set(x, []);
        columns.get(x).push(card);
      }
      for (const cards of columns.values()) {
        cards.sort((a,b) => a.y - b.y);
        assert.ok(Math.abs(cards[0].y - previousBottom - 36) < 1, "each webpage starts on a new aligned row");
        for (let i=1;i<cards.length;i++) assert.ok(Math.abs(cards[i].y-cards[i-1].y-cards[i-1].height-18)<1, "cards pack tightly within each webpage");
      }
      if (singleColumn) assert.equal(columns.size, 1);
      previousBottom = Math.max(...group.cards.map(c => c.y + c.height));
    }
    return groups;
  };
  await view("高亮内容");
  const navigation = page.getByRole("navigation", { name: "资料库视图" });
  assert.equal(await navigation.getByRole("button").count(), 5);
  assert.equal(await mode().getAttribute("aria-checked"), "true");
  const initial = await verify();
  await verifyFrozenHeading();
  assert.ok(initial.length > 10);
  assert.ok(new Set(initial.map(g=>g.fill)).size === 4);
  assert.ok(initial.some(g=>g.path.split("L").length>4), "region borders turn along the column skyline");
  assert.ok(initial.slice(1).every((g,i)=>Math.min(...g.cards.map(c=>c.y))>Math.max(...initial[i].cards.map(c=>c.y+c.height))), "following webpages never enter the preceding group's shorter columns");
  await page.screenshot({ path: join(out, "grouped-staircase-wide.png") });
  await page.locator(".group-page-card .tag-page-title").first().click();
  assert.equal(await page.locator(".selected-article .tag-page-title").textContent(), pages.find(p=>p.id===initial[0].id).title);
  await view("高亮内容");
  await page.getByRole("group", { name: "主分类筛选" }).getByRole("button", { name: /^前端设计\s*\d+$/ }).click();
  await verify({ category: "前端设计" });
  await page.getByRole("button", { name: "清空筛选", exact: true }).click();
  const search = page.getByRole("textbox", { name: "搜索高亮内容" });
  await search.fill("摘录 2：");
  const filtered = await verify({ query: "摘录 2：" });
  assert.notEqual(filtered[0].cards[1].id, initial[0].cards[1].id);
  await page.screenshot({ path: join(out, "grouped-staircase-filtered.png") });
  await mode().click();
  await verify({ query: "摘录 2：", grouped: false });
  await search.fill("");
  await verify({ grouped: false });
  await verifyFrozenHeading();
  await page.screenshot({ path: join(out, "grouped-mode-off.png") });
  await page.reload();
  await view("高亮内容");
  assert.equal(await mode().getAttribute("aria-checked"), "false", "display preference survives refresh");
  await verify({ grouped: false });
  await mode().click();
  await search.fill("结合项目验证这条观点。");
  await verify({ query: "结合项目验证这条观点。" });
  await search.fill("不存在的排序测试内容");
  await page.getByRole("heading", { name: "没有匹配的内容" }).waitFor();
  assert.equal(await page.locator(".content-page-group").count(), 0);
  await search.fill("");
  await verify();
  for (const width of [1440,900,720,480,320]) {
    await page.setViewportSize({ width, height: 900 });
    await verify({ singleColumn: width<=720 });
    await verifyFrozenHeading();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.screenshot({ path: join(out, "grouped-staircase-320.png") });
  await page.locator(".content-card").last().scrollIntoViewIfNeeded();
  assert.ok(await page.locator(".content-card").last().isVisible());
  await page.setViewportSize({width:1920,height:1080});
  await page.reload(); await view("高亮内容");
  assert.equal(await mode().getAttribute("aria-checked"), "true");
  await verify();
}
