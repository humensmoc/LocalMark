import { describe, expect, it } from "vitest";
import { treemap } from "../src/treemap";

describe("count-weighted treemap", () => {
  for (const [width, height] of [[1200, 700], [280, 420], [400, 850]]) {
    it(`fills ${width}x${height} without overlaps and preserves every proportion`, () => {
      const items = [99, 52, 16, 12, 7, 7, 6, 5, 5, 3, 2, 2, 1, 1, 1, 1, 0].map((count, i) => ({ id: String(i), count }));
      const tiles = treemap(items, width, height);
      const total = items.reduce((sum, item) => sum + item.count, 0);
      expect(tiles).toHaveLength(items.length - 1);
      expect(tiles.reduce((sum, t) => sum + t.width * t.height, 0)).toBeCloseTo(width * height, 6);
      for (const [i, tile] of tiles.entries()) {
        expect(tile.width * tile.height / (width * height)).toBeCloseTo(tile.item.count / total, 10);
        expect(tile.x).toBeGreaterThanOrEqual(0);
        expect(tile.y).toBeGreaterThanOrEqual(0);
        expect(tile.x + tile.width).toBeLessThanOrEqual(width + 1e-7);
        expect(tile.y + tile.height).toBeLessThanOrEqual(height + 1e-7);
        for (const other of tiles.slice(i + 1)) {
          const overlapWidth = Math.min(tile.x + tile.width, other.x + other.width) - Math.max(tile.x, other.x);
          const overlapHeight = Math.min(tile.y + tile.height, other.y + other.height) - Math.max(tile.y, other.y);
          expect(overlapWidth < 1e-7 || overlapHeight < 1e-7).toBe(true);
        }
      }
    });
  }
  it("handles empty, zero, invalid and single-item inputs", () => {
    expect(treemap([], 600, 400)).toEqual([]);
    expect(treemap([{ id: "zero", count: 0 }, { id: "bad", count: NaN }], 600, 400)).toEqual([]);
    expect(treemap([{ id: "a", count: 10 }], 0, 400)).toEqual([]);
    expect(treemap([{ id: "a", count: 10 }], 600, 400)).toEqual([{ item: { id: "a", count: 10 }, x: 0, y: 0, width: 600, height: 400 }]);
  });
  it("keeps tiny values proportional and stable when source order changes", () => {
    const items = [1000000, ...Array(150).fill(1)].map((count, i) => ({ id: String(i), count }));
    const tiles = treemap(items, 1000, 600);
    expect(tiles).toEqual(treemap(items.slice().reverse(), 1000, 600));
    expect(tiles).toHaveLength(151);
    expect(tiles.every(tile => Number.isFinite(tile.width + tile.height) && tile.width > 0 && tile.height > 0)).toBe(true);
  });
});
