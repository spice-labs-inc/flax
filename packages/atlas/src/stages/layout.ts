// Stage 8.5 (code): precompute the 3D layout.
//
// Running a force simulation in the browser means watching the graph settle for
// several seconds on every load. We run it once here instead and bake final
// coordinates into graph.json, so the viewer opens at the finished layout and
// only has to draw.

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
} from 'd3-force-3d';
import type { GraphEdge, GraphNode, Layer, Plane } from '../model/types.ts';
import { TARGET_SHELL_RADIUS } from '../model/types.ts';
import type { Ctx, Stage } from '../pipeline/machine.ts';
import { config } from '../config.ts';

/** Planes get their own region of space so the shape of the org is legible. */
/**
 * How hard a plane holds onto its own.
 *
 * Sparse nodes hold their region; hubs are freer, because a hub that talks to
 * everything drifting toward the middle is the truth about a hub.
 *
 * The single-tenant half of the product needs more than that, and it is the one
 * case where the default is wrong. Its members talk almost exclusively to each
 * other and to the central API, so the link forces glue them into the middle of
 * the multi-tenant cluster: the two spheres came out 272 apart with radii summing
 * to 660, which is one blob wearing two labels. The whole point of splitting the
 * plane is that you can SEE which half a component is in, and that needs the
 * halves to be in different places.
 */
const anchorsFromConfig = () => {
  const pull: Partial<Record<Plane, number>> = {};
  const placed: Plane[] = [];
  const anchor: Record<Plane, [number, number, number]> = {};
  for (const p of config().planes) {
    if (p.pull !== undefined) pull[p.id] = p.pull;
    if (p.placed) placed.push(p.id);
    if (p.anchor) anchor[p.id] = p.anchor;
  }
  return { pull, placed, anchor };
};

/**
 * Components built from one repo belong together on screen. One workspace repo
 * can ship an engine, its job store, a storage proxy and a CLI image, and
 * nothing in the declared graph pulls them together: they were averaging 600
 * units apart, which is most of the map. These are not drawn; they only pull.
 */
const SIBLING_STRENGTH = 0.55;
const SIBLING_DISTANCE = 90;

/** Runtime edges pull harder than build edges: proximity should mean behaviour. */
const LAYER_STRENGTH: Record<Layer, number> = {
  network: 1,
  queue: 0.9,
  data: 0.7,
  delivery: 0.35,
  build: 0.18,
  'shared-deps': 0,
  // Excluded from the simulation for the same reason as shared dependencies:
  // measured coupling, not designed relationship, and it must not move the map.
  advisory: 0,
};

const LAYER_DISTANCE: Record<Layer, number> = {
  network: 150,
  queue: 120,
  data: 130,
  delivery: 230,
  build: 300,
  'shared-deps': 300,
  advisory: 300,
};

/** Clear space between neighboring delivery targets' shells. */
const TARGET_GAP = 36;
/**
 * Clear space between the row of targets and the highest plane shell. More than
 * the gap between targets: a shell nearer the camera draws larger than its
 * radius says, and a placed plane can sit well forward of the row.
 */
const ROW_CLEARANCE = 110;

/**
 * Put each delivery target in a place of its own, in a row over the top of the
 * map.
 *
 * The simulation pulls every target into the delivery plane, where they sat in
 * a knot with ghcr, app-gitops and the action repos and their names were lost.
 * Like the placed planes, the simulation does not get the last word. The row
 * runs across the map as the default camera sees it (x across, y up), clear of
 * every plane's shell, centered over the delivery plane, and each target takes
 * the slot nearest the things that ship to it, so their edges cross each other
 * as little as an order can manage. Positions are in the normalized units the
 * viewer draws in, and shells are sized the way the viewer sizes them.
 */
export function placeTargets(nodes: GraphNode[], edges: GraphEdge[], positions: Record<string, [number, number, number]>): number {
  const targets = nodes.filter((n) => n.kind === 'outlet' && positions[n.id]);
  if (!targets.length) return 0;

  const planes = new Map<Plane, Array<[number, number, number]>>();
  for (const n of nodes) {
    if (n.kind === 'outlet' || !positions[n.id]) continue;
    if (!planes.has(n.plane)) planes.set(n.plane, []);
    planes.get(n.plane)!.push(positions[n.id]);
  }
  let top = -Infinity;
  let home: number[] | undefined;
  for (const [plane, pts] of planes) {
    if (pts.length < 3) continue;
    const c = [0, 1, 2].map((i) => pts.reduce((s, q) => s + q[i], 0) / pts.length);
    const spread = pts.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2])).sort((a, b) => a - b);
    const r = spread[Math.floor(spread.length * 0.8)] * 1.05 + 26;
    top = Math.max(top, c[1] + r);
    if (plane === config().map.deliveryPlane) home = c;
  }
  if (!home) return 0;

  const sourceX = (t: GraphNode) => {
    const xs = edges.filter((e) => e.target === t.id && positions[e.source]).map((e) => positions[e.source][0]);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : home![0];
  };
  const ordered = targets.map((t) => ({ t, x: sourceX(t) })).sort((a, b) => a.x - b.x || a.t.id.localeCompare(b.t.id));

  const step = 2 * TARGET_SHELL_RADIUS + TARGET_GAP;
  const y = top + ROW_CLEARANCE + TARGET_SHELL_RADIUS;
  ordered.forEach(({ t }, i) => {
    const x = home![0] + (i - (ordered.length - 1) / 2) * step;
    positions[t.id] = [Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(home![2] * 100) / 100];
  });
  return ordered.length;
}

export const layout: Stage = {
  id: 'layout',
  kind: 'code',
  title: 'Precompute the 3D layout (so the page opens instantly)',
  async run(ctx: Ctx) {
    const r = ctx.out.resolve as { nodes: GraphNode[]; edges: GraphEdge[] };
    const { pull: ANCHOR_PULL, placed: PLACED, anchor: PLANE_ANCHOR } = anchorsFromConfig();

    // d3-force mutates its inputs, so give it plain objects keyed by id.
    const simNodes = r.nodes.map((n) => ({ id: n.id, plane: n.plane, kind: n.kind }));
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    // Shared dependencies are excluded from the simulation on purpose. The layer
    // is dense and off by default, and letting it pull would rearrange the whole
    // map around coupling nobody declared — the positions people have learned
    // should keep meaning what they meant.
    const simLinks = r.edges
      .filter((e) => e.layer !== 'shared-deps' && e.layer !== 'advisory')
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, layer: e.layer }));

    // Same-repo cohesion, as links the viewer never sees.
    const byRepo = new Map<string, string[]>();
    for (const n of r.nodes) {
      if (!n.repo || !byId.has(n.id)) continue;
      if (!byRepo.has(n.repo)) byRepo.set(n.repo, []);
      byRepo.get(n.repo)!.push(n.id);
    }
    let siblings = 0;
    for (const ids of byRepo.values()) {
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          simLinks.push({ source: ids[i], target: ids[j], layer: 'sibling' as Layer });
          siblings++;
        }
      }
    }

    const degree = new Map<string, number>();
    for (const l of simLinks) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }

    // Hubs need room, stragglers need reining in. Collision spreads the dense
    // core; a capped repulsion distance stops low-degree nodes being flung into
    // empty space where they waste most of the viewport.
    const deg = (d: any) => degree.get(d.id) ?? 0;
    const anchorPull = (d: any) => ANCHOR_PULL[d.plane as Plane] ?? (deg(d) < 3 ? 0.5 : 0.3);
    const sim = forceSimulation(simNodes, 3)
      .force(
        'link',
        forceLink(simLinks)
          .id((d: any) => d.id)
          .distance((l: any) => {
            if (l.layer === 'sibling') return SIBLING_DISTANCE;
            const base = LAYER_DISTANCE[l.layer as Layer] ?? 150;
            // Give links onto a hub more length, or the hub's neighbours pile up.
            const hub = Math.max(deg(l.source), deg(l.target));
            return base + Math.min(190, Math.sqrt(hub) * 26);
          })
          .strength((l: any) => (l.layer === 'sibling' ? SIBLING_STRENGTH : (LAYER_STRENGTH[l.layer as Layer] ?? 0.4))),
      )
      .force(
        'charge',
        forceManyBody()
          .strength((d: any) => -230 - 30 * Math.min(26, deg(d)))
          .distanceMax(760)
          .theta(0.85),
      )
      // Keeps nodes from stacking on top of each other in the crowded middle.
      .force('collide', forceCollide().radius((d: any) => 30 + Math.min(34, Math.sqrt(deg(d)) * 6)).strength(0.9).iterations(2))
      .force('center', forceCenter(0, 0, 0))
      // Sparse nodes hold their plane's region; hubs are freer, but not free —
      // the force fields drawn around each plane are only honest if a plane is
      // actually a place, so the anchors sit further apart and pull harder than
      // they used to. A hub that talks to everything still drifts toward the
      // middle, which is the truth about a hub.
      .force('planeX', forceX((d: any) => PLANE_ANCHOR[d.plane as Plane]?.[0] ?? 0).strength(anchorPull))
      .force('planeY', forceY((d: any) => PLANE_ANCHOR[d.plane as Plane]?.[1] ?? 0).strength(anchorPull))
      .force('planeZ', forceZ((d: any) => PLANE_ANCHOR[d.plane as Plane]?.[2] ?? 0).strength(anchorPull))
      .stop();

    const ticks = 700;
    for (let i = 0; i < ticks; i++) sim.tick();

    // Move each placed plane bodily onto its anchor. Shape from the simulation,
    // position from the anchor.
    for (const plane of PLACED) {
      const members = (simNodes as any[]).filter((n) => n.plane === plane);
      if (!members.length) continue;
      const target = PLANE_ANCHOR[plane];
      const centroid = [0, 1, 2].map((i) => members.reduce((sum, n) => sum + [n.x, n.y, n.z][i], 0) / members.length);
      for (const n of members) {
        n.x += target[0] - centroid[0];
        n.y += target[1] - centroid[1];
        n.z += target[2] - centroid[2];
      }
    }

    let min = Infinity;
    let max = -Infinity;
    for (const n of simNodes as any[]) {
      for (const c of [n.x, n.y, n.z]) {
        if (c < min) min = c;
        if (c > max) max = c;
      }
    }
    // Normalise into a predictable box so the camera framing is stable.
    const span = Math.max(1, max - min);
    const scale = 2000 / span;

    const positions: Record<string, [number, number, number]> = {};
    for (const n of simNodes as any[]) {
      positions[n.id] = [
        Math.round(n.x * scale * 100) / 100,
        Math.round(n.y * scale * 100) / 100,
        Math.round(n.z * scale * 100) / 100,
      ];
    }

    const targets = placeTargets(r.nodes, r.edges, positions);

    for (const node of r.nodes) {
      const p = positions[node.id];
      if (p) {
        node.x = p[0];
        node.y = p[1];
        node.z = p[2];
      }
      node.degree = degree.get(node.id) ?? 0;
    }

    ctx.log(`        ${siblings} sibling pulls`);
    ctx.log(`        ${targets} delivery targets placed in their own row`);
    ctx.log(`        ${ticks} ticks over ${simNodes.length} nodes / ${simLinks.length} links`);
    return { ticks };
  },
};
