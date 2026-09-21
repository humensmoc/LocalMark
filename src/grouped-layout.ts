export type GroupLayout = {
  cards: { left: number; top: number; width: number; height: number; column: number }[];
  bands: { column: number; top: number; bottom: number }[];
  path: string;
};

type Point = [number, number];

/** Round both convex and concave turns without crossing a short step. */
function roundedOutline(points: Point[], radius: number) {
  const distinct = points.filter(([x, y], i) => {
    const previous = points[(i + points.length - 1) % points.length];
    return x !== previous[0] || y !== previous[1];
  });
  const corners = distinct.filter(([x, y], i) => {
    const previous = distinct[(i + distinct.length - 1) % distinct.length];
    const next = distinct[(i + 1) % distinct.length];
    return (x - previous[0]) * (next[1] - y) !== (y - previous[1]) * (next[0] - x);
  });
  if (!corners.length) return "";
  return corners.map(([x, y], i) => {
    const previous = corners[(i + corners.length - 1) % corners.length];
    const next = corners[(i + 1) % corners.length];
    const incoming = Math.hypot(previous[0] - x, previous[1] - y);
    const outgoing = Math.hypot(next[0] - x, next[1] - y);
    const r = Math.min(radius, incoming / 2, outgoing / 2);
    const start = [x + (previous[0] - x) * r / incoming, y + (previous[1] - y) * r / incoming];
    const end = [x + (next[0] - x) * r / outgoing, y + (next[1] - y) * r / outgoing];
    return `${i ? "L" : "M"}${start.join(",")} Q${x},${y} ${end.join(",")}`;
  }).join(" ") + " Z";
}

/** Each webpage starts a new row; its lower edge follows the packed columns. */
export function groupedLayout(heights: number[][], width: number, columns: number, padding = 9, gap = 18) {
  let bottom = 0;
  const groups: GroupLayout[] = [];
  for (const items of heights) {
    const usedColumns = Math.max(1, Math.min(columns, items.length));
    const pitch = width / usedColumns;
    const top = bottom + (bottom ? gap : 0);
    const skyline = Array<number>(usedColumns).fill(top);
    const bands = new Map<number, { column: number; top: number; bottom: number }>();
    const cards: GroupLayout["cards"] = [];
    for (const height of items) {
      const candidates = skyline.map((top, column) => ({ column, top }))
        .sort((a, b) => a.top - b.top || a.column - b.column);
      const { column, top } = candidates[0];
      cards.push({ left: column * pitch + padding, top: top + padding, width: pitch - padding * 2, height, column });
      skyline[column] = top + height + padding * 2;
      const band = bands.get(column);
      if (band) band.bottom = skyline[column];
      else bands.set(column, { column, top, bottom: skyline[column] });
    }
    const ordered = [...bands.values()].sort((a, b) => a.column - b.column);
    // The top is level; the lower edge can turn at every column boundary.
    const points: [number, number][] = [];
    for (const band of ordered) points.push([band.column * pitch, band.top], [(band.column + 1) * pitch, band.top]);
    for (const band of [...ordered].reverse()) points.push([(band.column + 1) * pitch, band.bottom], [band.column * pitch, band.bottom]);
    const path = roundedOutline(points, Math.min(16, padding * 2));
    groups.push({ cards, bands: ordered, path });
    if (items.length) bottom = Math.max(...skyline);
  }
  return { groups, height: bottom, width };
}
