import type { Item, SurfaceInfo } from "./data.ts";

export const HEX = 10;
const SQ3 = Math.sqrt(3);
const AX_DIRS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
] as const;
/** Edge i of a pointy hex runs corner i to corner i+1 and faces the neighbor in direction EDGE_DIR[i]. */
export const EDGE_DIR = [
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
] as const;

export type Box = [number, number, number, number];
type Point = [number, number];
type Segment = [Point, Point];

export interface Cell {
  q: number;
  r: number;
  x: number;
  y: number;
  wx: number;
  wy: number;
  /** Angle and distance from the island center, used for wedge districts and the reveal wave. */
  a: number;
  d: number;
  item: Item;
  island: Island;
  district: District;
}

export interface District {
  name: string;
  cells: Cell[];
  items: Item[];
  label: Point;
  box: Box;
  island: Island;
}

export interface Island {
  info: SurfaceInfo;
  items: Item[];
  cells: Cell[];
  districts: District[];
  key: Map<string, Cell>;
  coast: Segment[];
  seams: Segment[];
  x: number;
  y: number;
  r: number;
  /** Radius of the land itself, without the contour margin. */
  land: number;
}

export interface World {
  islands: Island[];
  box: Box;
  cellOf: Map<number, Cell>;
}

export function corner(cx: number, cy: number, i: number, s = HEX): Point {
  const ang = (Math.PI / 180) * (60 * i - 30);
  return [cx + s * Math.cos(ang), cy + s * Math.sin(ang)];
}

function spiral(n: number): Point[] {
  const out: Point[] = [[0, 0]];
  for (let ring = 1; out.length < n; ring++) {
    let q = -ring;
    let r = ring;
    for (let side = 0; side < 6 && out.length < n; side++) {
      for (let step = 0; step < ring && out.length < n; step++) {
        out.push([q, r]);
        q += AX_DIRS[side]![0];
        r += AX_DIRS[side]![1];
      }
    }
  }
  return out;
}

/**
 * Each island (a surface, or the part of one the build split off) becomes a hex island; its areas are wedge-shaped
 * districts, largest first. A sub-map places every item on its one island, in the district `place` names for it.
 */
export function buildWorld(
  surfaces: SurfaceInfo[],
  items: Item[],
  aspect: number,
  place?: Map<number, string>,
): World {
  const islands: Island[] = [];
  for (const info of surfaces) {
    const list = place
      ? items
      : items.filter((it) => it.island === info.island);
    if (list.length === 0) continue;
    const byArea = new Map<string, Item[]>();
    for (const it of list) {
      const area = place?.get(it.idx) ?? it.area;
      const a = byArea.get(area);
      if (a) a.push(it);
      else byArea.set(area, [it]);
    }
    const island: Island = {
      info,
      items: list,
      cells: [],
      districts: [],
      key: new Map(),
      coast: [],
      seams: [],
      x: 0,
      y: 0,
      r: 0,
      land: 0,
    };
    const spots = spiral(list.length)
      .map(([q, r]) => {
        const x = HEX * SQ3 * (q + r / 2);
        const y = HEX * 1.5 * r;
        return {
          q,
          r,
          x,
          y,
          a: (Math.atan2(y, x) + Math.PI * 2.5) % (Math.PI * 2),
          d: Math.hypot(x, y),
        };
      })
      .sort((A, B) => A.a - B.a || A.d - B.d);
    const areas = [...byArea.entries()].sort(
      (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
    );
    let k = 0;
    for (const [name, areaItems] of areas) {
      const district: District = {
        name,
        cells: [],
        items: areaItems,
        label: [0, 0],
        box: [0, 0, 0, 0],
        island,
      };
      for (const item of areaItems) {
        const spot = spots[k++]!;
        const cell: Cell = { ...spot, wx: 0, wy: 0, item, island, district };
        district.cells.push(cell);
        island.cells.push(cell);
      }
      island.districts.push(district);
    }
    island.land = Math.max(...island.cells.map((c) => c.d)) + HEX;
    island.r = island.land + HEX * 2.2;
    islands.push(island);
  }
  pack(islands, aspect);
  for (const isl of islands) {
    for (const c of isl.cells) {
      c.wx = c.x + isl.x;
      c.wy = c.y + isl.y;
      isl.key.set(`${c.q},${c.r}`, c);
    }
    for (const d of isl.districts) {
      const xs = d.cells.map((c) => c.wx);
      const ys = d.cells.map((c) => c.wy);
      const cx = xs.reduce((s, v) => s + v, 0) / xs.length;
      const cy = ys.reduce((s, v) => s + v, 0) / ys.length;
      let best = d.cells[0]!;
      let bd = Infinity;
      for (const c of d.cells) {
        const dd = (c.wx - cx) ** 2 + (c.wy - cy) ** 2;
        if (dd < bd) {
          bd = dd;
          best = c;
        }
      }
      d.label = [best.wx, best.wy];
      d.box = [
        Math.min(...xs) - HEX,
        Math.min(...ys) - HEX,
        Math.max(...xs) + HEX,
        Math.max(...ys) + HEX,
      ];
    }
    edges(isl);
  }
  const box: Box = [
    Math.min(...islands.map((i) => i.x - i.r)),
    Math.min(...islands.map((i) => i.y - i.r)),
    Math.max(...islands.map((i) => i.x + i.r)),
    Math.max(...islands.map((i) => i.y + i.r)),
  ];
  const cellOf = new Map<number, Cell>();
  for (const isl of islands)
    for (const c of isl.cells) cellOf.set(c.item.idx, c);
  return { islands, box, cellOf };
}

function edges(isl: Island): void {
  for (const c of isl.cells) {
    for (let i = 0; i < 6; i++) {
      const [dq, dr] = EDGE_DIR[i]!;
      const nb = isl.key.get(`${c.q + dq},${c.r + dr}`);
      const seg: Segment = [
        corner(c.wx, c.wy, i),
        corner(c.wx, c.wy, (i + 1) % 6),
      ];
      if (!nb) isl.coast.push(seg);
      else if (
        nb.district !== c.district &&
        (c.q < nb.q || (c.q === nb.q && c.r < nb.r))
      )
        isl.seams.push(seg);
    }
  }
}

/** Greedy front packing of island circles, biased to the stage's aspect ratio. */
function pack(islands: Island[], aspect: number): void {
  const sorted = [...islands].sort((a, b) => b.r - a.r);
  const placed: Island[] = [];
  const sa = Math.sqrt(Math.max(0.3, Math.min(3, aspect)));
  for (const c of sorted) {
    if (placed.length === 0) {
      placed.push(c);
      continue;
    }
    let best: [number, number, number] | null = null;
    for (const a of placed) {
      for (const b of placed) {
        for (const [x, y] of tangents(a, b, c.r)) {
          if (
            !placed.every(
              (p) => Math.hypot(p.x - x, p.y - y) >= p.r + c.r - 0.01,
            )
          )
            continue;
          const score = Math.hypot(x / sa, y * sa * 0.9);
          if (!best || score < best[2]) best = [x, y, score];
        }
      }
    }
    if (best) {
      c.x = best[0];
      c.y = best[1];
    }
    placed.push(c);
  }
}

function tangents(a: Island, b: Island, r: number): Point[] {
  if (a === b) {
    return Array.from({ length: 12 }, (_, t): Point => {
      const ang = (t / 12) * Math.PI * 2;
      return [a.x + Math.cos(ang) * (a.r + r), a.y + Math.sin(ang) * (a.r + r)];
    });
  }
  const ra = a.r + r;
  const rb = b.r + r;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d === 0 || d > ra + rb || d < Math.abs(ra - rb)) return [];
  const l = (ra * ra - rb * rb + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, ra * ra - l * l));
  const mx = a.x + (dx * l) / d;
  const my = a.y + (dy * l) / d;
  return [
    [mx + (h * dy) / d, my - (h * dx) / d],
    [mx - (h * dy) / d, my + (h * dx) / d],
  ];
}

/** The cell under a world point, by cube rounding in each island's axial frame. */
export function cellAt(world: World, wx: number, wy: number): Cell | null {
  for (const isl of world.islands) {
    const lx = wx - isl.x;
    const ly = wy - isl.y;
    if (lx * lx + ly * ly > isl.r * isl.r) continue;
    const x = ((SQ3 / 3) * lx - ly / 3) / HEX;
    const z = ((2 / 3) * ly) / HEX;
    const y = -x - z;
    let rx = Math.round(x);
    const ry = Math.round(y);
    let rz = Math.round(z);
    const ex = Math.abs(rx - x);
    const ey = Math.abs(ry - y);
    const ez = Math.abs(rz - z);
    if (ex > ey && ex > ez) rx = -ry - rz;
    else if (ey <= ez) rz = -rx - ry;
    const c = isl.key.get(`${rx},${rz}`);
    if (c) return c;
  }
  return null;
}

export function islandAt(world: World, wx: number, wy: number): Island | null {
  return (
    world.islands.find((i) => Math.hypot(wx - i.x, wy - i.y) < i.r) ?? null
  );
}
