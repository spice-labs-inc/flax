/**
 * The hex glyph split into N sectors, one per environment, the first centered on the top vertex. With three
 * envs the sectors are the three rhombi the map always drew; with one env the whole hex; with two, halves.
 */

/** A point on the outline of a pointy-top hexagon of radius r at a clockwise angle from the top, in degrees. */
export function hexPoint(deg: number, r: number): [number, number] {
  const a = ((deg % 360) + 360) % 360;
  const lo = Math.floor(a / 60) * 60;
  const [x1, y1] = vertex(lo, r);
  const [x2, y2] = vertex(lo + 60, r);
  const t = (a - lo) / 60;
  return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
}

function vertex(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [r * Math.sin(rad), -r * Math.cos(rad)];
}

/** The outline points of sector i of n, from the center: start edge, every vertex inside, end edge. */
export function sectorPoints(
  i: number,
  n: number,
  r: number,
): [number, number][] {
  if (n <= 1) return [0, 60, 120, 180, 240, 300].map((d) => vertex(d, r));
  const span = 360 / n;
  const start = i * span - span / 2;
  const end = start + span;
  const pts: [number, number][] = [[0, 0], hexPoint(start, r)];
  for (let d = Math.ceil(start / 60) * 60; d < end; d += 60)
    if (d > start) pts.push(vertex(d, r));
  pts.push(hexPoint(end, r));
  return pts;
}

export function sectorPath(i: number, n: number, r: number): string {
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  return (
    sectorPoints(i, n, r)
      .map(([x, y], k) => `${k === 0 ? "M" : "L"}${f(x)} ${f(y)}`)
      .join(" ") + " Z"
  );
}
