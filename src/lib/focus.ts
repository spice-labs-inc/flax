import type { Box, Cell, District, Island, World } from "./layout.ts";
import { HEX } from "./layout.ts";

export type Focus =
  | { level: "world" }
  | { level: "island"; island: Island }
  | { level: "district"; district: District }
  | { level: "item"; cell: Cell }
  /** A handful of cells lit together, such as the items a feature touches, or a surface the map draws as several islands. */
  | { level: "set"; cells: Cell[]; label: string; surface?: string };

export function focusIsland(f: Focus): Island | null {
  if (f.level === "island") return f.island;
  if (f.level === "district") return f.district.island;
  if (f.level === "item") return f.cell.island;
  return null;
}

export function focusDistrict(f: Focus): District | null {
  if (f.level === "district") return f.district;
  if (f.level === "item") return f.cell.district;
  return null;
}

export function parentOf(f: Focus): Focus {
  if (f.level === "item")
    return { level: "district", district: f.cell.district };
  if (f.level === "district")
    return { level: "island", island: f.district.island };
  return { level: "world" };
}

/** Zooming goes one level deeper toward a cell: product, surface, area, item. A selected item zooms to its area first. */
export function stepToward(f: Focus, cell: Cell): Focus {
  if (f.level === "world" || f.level === "set")
    return { level: "island", island: cell.island };
  if (f.level === "item" && f.cell === cell)
    return { level: "district", district: cell.district };
  if (focusIsland(f) !== cell.island)
    return { level: "island", island: cell.island };
  if (f.level === "island" || focusDistrict(f) !== cell.district)
    return { level: "district", district: cell.district };
  return { level: "item", cell };
}

export function focusBox(world: World, f: Focus): Box {
  if (f.level === "world") return world.box;
  if (f.level === "set") {
    if (!f.cells.length) return world.box;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of f.cells) {
      x0 = Math.min(x0, c.wx);
      y0 = Math.min(y0, c.wy);
      x1 = Math.max(x1, c.wx);
      y1 = Math.max(y1, c.wy);
    }
    const pad = Math.max(HEX * 6, (x1 - x0) * 0.15, (y1 - y0) * 0.15);
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }
  if (f.level === "island") {
    const i = f.island;
    return [i.x - i.r, i.y - i.r, i.x + i.r, i.y + i.r];
  }
  if (f.level === "district") return f.district.box;
  const c = f.cell;
  const b = c.district.box;
  const span = Math.max(b[2] - b[0], b[3] - b[1], HEX * 16);
  return [c.wx - span / 2, c.wy - span / 2, c.wx + span / 2, c.wy + span / 2];
}
