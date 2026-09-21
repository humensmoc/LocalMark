import { describe, it, expect } from "vitest";
import { groupedLayout } from "../src/grouped-layout";

describe("webpage rows with stepped bottoms", () => {
  it("starts each webpage below the preceding group with an aligned top", () => {
    const layout = groupedLayout([[80, 200, 100, 60], [90, 70, 110]], 990, 3);
    const [first, next] = layout.groups;
    expect(next.cards[0].top).toBe(Math.max(...first.cards.map(c => c.top + c.height)) + 36);
    expect(new Set(next.cards.map(c => c.top)).size).toBe(1);
    expect(new Set(first.bands.map(b => b.bottom)).size).toBeGreaterThan(1);
    expect(first.path.split("L").length).toBeGreaterThan(4);
  });
  it("packs within each webpage without letting later webpages fill its shorter columns", () => {
    for (let columns = 1; columns <= 5; columns++) {
      const heights = Array.from({ length: 70 }, (_, g) => Array.from({ length: 2 + g % 17 }, (_, i) => 45 + (g * 31 + i * 89) % 420));
      const layout = groupedLayout(heights, 340 * columns, columns);
      let end = 0;
      for (const [g, group] of layout.groups.entries()) {
        const start = end + (g ? 18 : 0);
        const bottoms = Array(columns).fill(start);
        expect(new Set(group.bands.map(b => b.top))).toEqual(new Set([start]));
        expect(group.cards).toHaveLength(heights[g].length);
        for (const [i, card] of group.cards.entries()) {
          if (i) expect(card.top).toBeGreaterThanOrEqual(group.cards[i - 1].top);
          expect(card.top).toBe(bottoms[card.column] + 9);
          expect(card.height).toBe(heights[g][i]);
          bottoms[card.column] = card.top + card.height + 9;
          const band = group.bands.find(b => b.column === card.column)!;
          expect(card.top).toBeGreaterThanOrEqual(band.top + 9);
          expect(card.top + card.height).toBeLessThanOrEqual(band.bottom - 9);
        }
        for (let i = 1; i < group.bands.length; i++) {
          const a = group.bands[i - 1], b = group.bands[i];
          expect(b.column).toBe(a.column + 1);
          expect(Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)).toBeGreaterThan(0);
        }
        end = Math.max(...bottoms);
      }
      expect(layout.height).toBe(end);
    }
  });
  it("handles empty results and a narrow single column", () => {
    expect(groupedLayout([], 320, 1).height).toBe(0);
    const layout = groupedLayout([[90, 70], [100, 120]], 280, 1);
    expect(layout.groups.flatMap(g => g.cards).map(c => c.left)).toEqual([9, 9, 9, 9]);
    expect(layout.height).toBe(470);
  });
  it("uses the full row when filtering leaves fewer cards than columns", () => {
    const { groups } = groupedLayout([[90, 70], [100]], 1000, 3);
    expect(groups[0].cards.map(c => c.width)).toEqual([482, 482]);
    expect(groups[1].cards[0].width).toBe(982);
    expect(groups[1].cards[0].top).toBe(135);
  });
});
