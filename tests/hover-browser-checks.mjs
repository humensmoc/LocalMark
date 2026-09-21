import assert from "node:assert/strict";
import { join } from "node:path";

export async function hoverTrackingChecks({ page, host, target, out, name }) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  const tooltip = host.locator('.tooltip[data-state="open"]');
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const [fraction, vertical] of [[0.1, 0.2], [0.4, 0.8], [0.7, 0.4], [0.25, 0.7]]) {
    const x = box.x + box.width * fraction, y = box.y + box.height * vertical;
    await page.mouse.move(x, y);
    await frame();
    assert.equal(await tooltip.count(), 1, "comment opens while the pointer is moving, without waiting for it to stop");
    const rect = await tooltip.boundingBox();
    assert.ok(Math.abs(rect.x - x - 14) <= 2, `${name} follows the cursor's right side: ${rect.x} vs ${x}`);
    assert.ok(Math.abs(rect.y - y - 8) <= 2, `${name} follows the cursor vertically`);
    assert.equal(await tooltip.locator(".hover-note").first().evaluate(el => getComputedStyle(el).color), "rgb(255, 255, 255)");
  }
  await page.screenshot({ path: join(out, `${name}-comment-follow.png`) });
  // Continuous movement off a mark must not keep restarting the exit timeout.
  for (let step = 0; step < 6; step++) {
    await page.mouse.move(25 + step, 25);
    await frame();
  }
  assert.equal(await host.locator(".tooltip").count(), 0, "comment leaves promptly while the pointer keeps moving");
}
