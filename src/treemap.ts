export type WeightedItem = { id: string; count: number };
export type Tile<T> = { item: T; x: number; y: number; width: number; height: number };

// Squarified rows preserve exact areas while avoiding long, thin rectangles.
export function treemap<T extends WeightedItem>(items: T[], width: number, height: number): Tile<T>[] {
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) return [];
  const sorted = items.filter(item => Number.isFinite(item.count) && item.count > 0)
    .slice().sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const total = sorted.reduce((sum, item) => sum + item.count, 0);
  const pending = sorted.map(item => ({ item, area: item.count / total * width * height }));
  const tiles: Tile<T>[] = [];
  let x = 0, y = 0, w = width, h = height, index = 0;
  function worst(areas: number[], side: number) {
    const sum = areas.reduce((a, b) => a + b, 0);
    return Math.max(side * side * Math.max(...areas) / (sum * sum), sum * sum / (side * side * Math.min(...areas)));
  }
  while (index < pending.length) {
    const row = [pending[index++]];
    const side = Math.min(w, h);
    while (index < pending.length && worst([...row.map(entry => entry.area), pending[index].area], side) <= worst(row.map(entry => entry.area), side)) {
      row.push(pending[index++]);
    }
    const area = row.reduce((sum, entry) => sum + entry.area, 0);
    const vertical = w >= h;
    const thickness = area / side;
    let offset = 0;
    for (const entry of row) {
      const length = entry.area / thickness;
      tiles.push({ item: entry.item, x: x + (vertical ? 0 : offset), y: y + (vertical ? offset : 0), width: vertical ? thickness : length, height: vertical ? length : thickness });
      offset += length;
    }
    if (vertical) { x += thickness; w = Math.max(0, w - thickness); }
    else { y += thickness; h = Math.max(0, h - thickness); }
  }
  return tiles;
}
