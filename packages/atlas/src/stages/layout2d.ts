// Stage 8.6 (code): precompute the 2D grouped layouts.
//
// The 3D layout answers "what is near what". This one answers "what is inside
// what": nodes are partitioned by some property, each partition becomes a box,
// and the boxes are laid out so the diagram reads the way the k8-objects
// diagram in internal-docs reads — with the graph's own richness kept.
//
// The layout itself is ELK's, not ours. A first pass hand-rolled the tiering,
// the box packing and the edge routing; each piece worked and each one hit the
// same wall, most visibly when thirty edges between two boxes had to share one
// port and pinched into an hourglass. ELK does layered ranking, compound nodes,
// port distribution and edge routing as one problem rather than four, which is
// the only way the answers stay consistent with each other.
//
// It runs HERE, in the generator, and only here: node positions, box rectangles
// and edge bend points are all baked into graph.json, so the viewer draws what
// it is handed and the page still never simulates. elkjs never reaches the
// browser bundle.
//
// One layout per grouping key, because the answer moves: a node that sits
// beside its callers when grouped by plane sits beside the other things on its
// box when grouped by deployment.

import ELK from 'elkjs/lib/elk.bundled.js';

// elk.bundled.js is CommonJS: under Node's ESM loader the default import is the constructor itself,
// while its declaration file promises a module with a default export. Take whichever is there.
type ElkCtor = typeof ELK extends { default: infer C } ? C : typeof ELK;
const Elk = ((ELK as unknown as { default?: ElkCtor }).default ?? ELK) as unknown as ElkCtor;
import type { EdgeRoute, Flow, GraphEdge, GraphNode, Group, GroupKey, Plane } from '../model/types.ts';
import { GROUP_KEYS } from '../model/types.ts';
import type { Ctx, Stage } from '../pipeline/machine.ts';

/** Mirrors the viewer's node radius, so ELK reserves the room a node needs. */
function radius(n: GraphNode): number {
  const base =
    n.kind === 'component' ? 11 :
    n.kind === 'library' ? 7.5 :
    n.kind === 'queue' ? 11 :
    n.kind === 'broker' ? 14 :
    n.kind === 'store' ? 13 :
    n.kind === 'env' || n.kind === 'outlet' ? 16 :
    n.kind === 'machine' ? 12 : 9.5;
  return base + Math.min(36, Math.sqrt(n.degree ?? 0) * 5.6);
}

/**
 * Which environments and machines a component is deployed onto, read from the
 * edges the gitops stage produced rather than from prose.
 *
 * Membership is a set, not a single value: a component in all three clusters
 * belongs in one box saying so, not in three boxes that each tell a third of
 * the truth.
 */
function deploymentGroups(edges: GraphEdge[]): Map<string, { id: string; label: string }> {
  const envs = new Map<string, Set<string>>();
  const boxes = new Map<string, string>();
  for (const e of edges) {
    if (e.label === 'deployed here' && e.target.startsWith('env:')) {
      if (!envs.has(e.source)) envs.set(e.source, new Set());
      envs.get(e.source)!.add(e.target.slice(4));
    }
    if (e.label === 'runs on' && e.target.startsWith('machine:')) {
      boxes.set(e.source, e.target.slice(8));
    }
  }

  const out = new Map<string, { id: string; label: string }>();
  for (const [id, set] of envs) {
    const names = [...set].sort();
    out.set(id, { id: `env:${names.join('+')}`, label: names.join(' · ') });
  }
  // A component can be both: a service ships to the clusters and also runs as a
  // compose stack on a box. The box it lives in names both halves, so
  // neither claim is quietly dropped.
  for (const [id, box] of boxes) {
    const existing = out.get(id);
    out.set(
      id,
      existing
        ? { id: `${existing.id}+box:${box}`, label: `${existing.label} · ${box}` }
        : { id: `box:${box}`, label: box },
    );
  }
  return out;
}

/** The group a node belongs to under one grouping, or undefined for ungrouped. */
function grouperFor(
  key: GroupKey,
  edges: GraphEdge[],
): (n: GraphNode) => { id: string; label: string; within?: Plane } | undefined {
  if (key === 'deploy') {
    const map = deploymentGroups(edges);
    return (n) => map.get(n.id);
  }
  return (n) => {
    // Each delivery target is its own place: in one shared delivery box they
    // drew as a knot with the repos that ship to them.
    if (key === 'plane' && n.kind === 'outlet') return { id: n.id, label: n.label, within: n.plane };
    const v = n[key] as string | undefined;
    return v ? { id: v, label: v } : undefined;
  };
}

const BOX_PREFIX = 'box::';

type Pt = [number, number];

/**
 * A route as a start point followed by deltas.
 *
 * These are orthogonal routes, so consecutive points differ on ONE axis: every
 * second number in the delta stream is a zero. That turns a nine-character
 * coordinate into a single character, and gives gzip a long run of identical
 * tokens to chew on. Same points out the other end — the viewer adds them back
 * up — for about a third less to download.
 */
const flatten = (pts: Pt[]): number[] => {
  if (!pts.length) return [];
  const out: number[] = [pts[0][0], pts[0][1]];
  const r = (v: number) => Math.round(v * 10) / 10;
  for (let i = 1; i < pts.length; i++) {
    out.push(r(pts[i][0] - pts[i - 1][0]), r(pts[i][1] - pts[i - 1][1]));
  }
  return out;
};

/** Neither horizontal nor vertical, by more than a rounding error. */
const bent = (a: Pt, b: Pt) => Math.min(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) > 1.5;

/**
 * Square up the two ends of a route against the node centres it runs between.
 *
 * ELK puts a route's first and last point on the node's bounding box, spread
 * along the edge so several routes can leave without overlapping. The viewer
 * draws from the node's CENTRE, and centre-to-port is diagonal whenever the
 * port is not directly in line — which is most of the time. That single stub
 * was three thousand diagonal segments across the five groupings, and it hid
 * behind an endpoint-only check that only ever asked whether a route existed.
 *
 * The elbow is oriented to meet the next segment squarely: if the route leaves
 * horizontally, the stub arrives vertically, and the corner rounds cleanly.
 */
function squareEnds(pts: Pt[], a: Pt, b: Pt): Pt[] {
  const out = pts.slice();
  if (out.length && bent(a, out[0])) {
    const next = out[1] ?? b;
    const leavesHorizontally = Math.abs(next[1] - out[0][1]) <= Math.abs(next[0] - out[0][0]);
    out.unshift(leavesHorizontally ? [out[0][0], a[1]] : [a[0], out[0][1]]);
  }
  const last = out.length - 1;
  if (out.length && bent(b, out[last])) {
    const prev = out[last - 1] ?? a;
    const arrivesHorizontally = Math.abs(prev[1] - out[last][1]) <= Math.abs(prev[0] - out[last][0]);
    out.push(arrivesHorizontally ? [out[last][0], b[1]] : [b[0], out[last][1]]);
  }
  return out;
}

/**
 * Layered, top-down, with each box laid out as its own little diagram and the
 * edges between boxes routed at the top level.
 *
 * `SEPARATE_CHILDREN` rather than `INCLUDE_CHILDREN` is the whole difference
 * between a diagram and a bird's nest, and it was not obvious. Including
 * children ranks all nine boxes into one global layering, which pushes the
 * field to 11000x10600 and sends 235 back-edges the long way around the
 * outside — the ring that made the first attempt unreadable. Separating them
 * gives 6200x3900 and not one route leaving the diagram's own bounds.
 * Measured, not guessed.
 *
 * `separateConnectedComponents` matters for the sparse groupings — deployment
 * leaves most of the graph unattached, and packing those components is exactly
 * the job the hand-rolled grid was doing badly.
 */
const ROOT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.hierarchyHandling': 'SEPARATE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.separateConnectedComponents': 'true',
  // Wider than 16:9 on purpose: boxes stack better than they sit side by side,
  // so asking for extra width lands nearer a landscape screen than asking for
  // the shape you actually want.
  'elk.aspectRatio': '2.2',
  'elk.spacing.nodeNode': '34',
  'elk.spacing.edgeNode': '22',
  'elk.spacing.edgeEdge': '20',
  'elk.spacing.componentComponent': '90',
  'elk.layered.spacing.nodeNodeBetweenLayers': '76',
  'elk.layered.spacing.edgeNodeBetweenLayers': '26',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
};

/**
 * Room inside a box: extra at the top so the box label has somewhere to live.
 *
 * The routing options have to be repeated here. Separating children means each
 * box gets its own layout run, and a run reads its options from its own node,
 * so setting them only on the root leaves every intra-box edge on the default.
 * That was worth finding: it is the difference between a routed box and a knot.
 *
 * Orthogonal, not polyline, on purpose. Polyline measures straighter (1.07x
 * straight-line against 1.30x) but it draws a street map — every edge takes its
 * own diagonal. Right angles in shared corridors are what makes a transit map
 * legible, and the extra distance is the price of that.
 */
const BOX_OPTIONS: Record<string, string> = {
  'elk.padding': '[top=64,left=40,bottom=40,right=40]',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.nodeNode': '30',
  'elk.spacing.edgeNode': '22',
  'elk.spacing.edgeEdge': '20',
  'elk.layered.spacing.nodeNodeBetweenLayers': '70',
  'elk.layered.unnecessaryBendpoints': 'true',
};

/**
 * A delivery target's box holds one node, so ELK would shrink it to the node
 * and leave no room for its name. A minimum size keeps the name inside it.
 */
const TARGET_BOX_OPTIONS: Record<string, string> = {
  ...BOX_OPTIONS,
  'elk.nodeSize.constraints': '[MINIMUM_SIZE]',
  'elk.nodeSize.minimum': '(340, 170)',
  'elk.contentAlignment': '[H_CENTER, V_CENTER]',
};

interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkNode[];
  layoutOptions?: Record<string, string>;
}

interface ElkPoint {
  x: number;
  y: number;
}

interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  container?: string;
  sections?: Array<{ startPoint: ElkPoint; endPoint: ElkPoint; bendPoints?: ElkPoint[] }>;
}

interface ElkGraph extends ElkNode {
  edges?: ElkEdge[];
}

export const layout2d: Stage = {
  id: 'layout2d',
  kind: 'code',
  title: 'Precompute the 2D grouped layouts (ELK, one per grouping)',
  async run(ctx: Ctx) {
    const r = ctx.out.resolve as { nodes: GraphNode[]; edges: GraphEdge[]; flows: Flow[] };
    // Shared dependencies are left out for the same reason the 3D layout leaves
    // them out: the layer is dense, off by default, and would rearrange every
    // box around coupling nobody declared.
    const edges = r.edges.filter((e) => e.layer !== 'shared-deps' && e.layer !== 'advisory' && e.source !== e.target);
    // Shared dependencies stay out of the LAYOUT — letting them pull would
    // rearrange every box around coupling nobody declared — but they are still
    // drawn when the layer is on, so they still need routing once the positions
    // are settled. Leaving them out of both was 17 straight diagonals per
    // grouping, cutting across a diagram that has no other diagonal in it.
    const routable = r.edges.filter((e) => e.source !== e.target);
    const elk = new Elk();

    const groupsOut: Partial<Record<GroupKey, Group[]>> = {};
    const routesOut: Partial<Record<GroupKey, Record<string, EdgeRoute>>> = {};

    for (const key of GROUP_KEYS) {
      const assign = grouperFor(key, edges);
      const buckets = new Map<string, { label: string; within?: Plane; members: GraphNode[] }>();
      const loose: GraphNode[] = [];
      for (const n of r.nodes) {
        const g = assign(n);
        if (!g) {
          loose.push(n);
          continue;
        }
        if (!buckets.has(g.id)) buckets.set(g.id, { label: g.label, within: g.within, members: [] });
        buckets.get(g.id)!.members.push(n);
        // Recorded on the node so the 3D view can group by the same answer
        // without re-deriving it from box rectangles it does not have.
        if (!n.groupOf) n.groupOf = {};
        n.groupOf[key] = g.id;
      }

      const box = (n: GraphNode): ElkNode => ({
        id: n.id,
        width: radius(n) * 2,
        height: radius(n) * 2,
      });

      const graph: ElkGraph = {
        id: 'root',
        layoutOptions: ROOT_OPTIONS,
        children: [
          ...[...buckets.entries()].map(([id, b]) => ({
            id: BOX_PREFIX + id,
            layoutOptions: b.within ? TARGET_BOX_OPTIONS : BOX_OPTIONS,
            children: b.members.map(box),
          })),
          // Ungrouped nodes sit at the root rather than in an invented box, so
          // an empty deployment story looks empty instead of made up.
          ...loose.map(box),
        ],
        edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
      };

      const laid = (await elk.layout(graph as never)) as unknown as ElkGraph;

      // -- absolute coordinates ------------------------------------------------
      // ELK reports every child relative to its parent, and every edge section
      // relative to the container the edge was routed in. Walk once and record
      // the absolute origin of everything, so both can be resolved.
      const origin = new Map<string, { x: number; y: number }>([['root', { x: 0, y: 0 }]]);
      const nodeAt = new Map<string, { x: number; y: number }>();
      const boxRect = new Map<string, { x: number; y: number; w: number; h: number }>();

      const walk = (parent: ElkNode, ox: number, oy: number): void => {
        for (const child of parent.children ?? []) {
          const cx = ox + (child.x ?? 0);
          const cy = oy + (child.y ?? 0);
          if (child.children?.length) {
            origin.set(child.id, { x: cx, y: cy });
            boxRect.set(child.id, { x: cx, y: cy, w: child.width ?? 0, h: child.height ?? 0 });
            walk(child, cx, cy);
          } else {
            // Centre, not corner: everything downstream thinks in centres.
            nodeAt.set(child.id, { x: cx + (child.width ?? 0) / 2, y: cy + (child.height ?? 0) / 2 });
          }
        }
      };
      walk(laid, 0, 0);

      // -- normalise -----------------------------------------------------------
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const see = (x: number, y: number) => {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      };
      for (const p of nodeAt.values()) see(p.x, p.y);
      for (const b of boxRect.values()) {
        see(b.x, b.y);
        see(b.x + b.w, b.y + b.h);
      }
      if (!Number.isFinite(minX)) {
        ctx.log(`        ${key}: nothing placed, skipped`);
        continue;
      }

      // No rescaling. ELK was given node sizes in the same units the viewer
      // draws them in, so its output is already at the right scale; squeezing
      // it into a fixed field width would crush the spacing it just worked out
      // and leave nodes overlapping. Only the origin moves.
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const round = (v: number) => Math.round(v * 10) / 10;
      // ELK's y grows downward; the scene's grows up.
      const px = (x: number) => round(x - cx);
      const py = (y: number) => round(-(y - cy));

      for (const n of r.nodes) {
        const p = nodeAt.get(n.id);
        if (!p) continue;
        if (!n.pos2d) n.pos2d = {};
        n.pos2d[key] = [px(p.x), py(p.y)];
      }

      groupsOut[key] = [...buckets.entries()]
        .map(([id, b]) => {
          const rect = boxRect.get(BOX_PREFIX + id);
          if (!rect) return null;
          return {
            id,
            label: b.label,
            x: px(rect.x + rect.w / 2),
            y: py(rect.y + rect.h / 2),
            w: round(rect.w),
            h: round(rect.h),
            count: b.members.length,
            ...(b.within ? { within: b.within } : {}),
          };
        })
        .filter((g): g is Group => g !== null);

      // -- edge routes ---------------------------------------------------------
      const routes: Record<string, EdgeRoute> = {};
      const nodeBox = new Map<string, string>();
      for (const [id, b] of buckets) for (const n of b.members) nodeBox.set(n.id, BOX_PREFIX + id);
      let elkRouted = 0;
      for (const e of laid.edges ?? []) {
        const section = e.sections?.[0];
        // Keep the section even when it has no bends. ELK gives a straight
        // orthogonal run no bend points, and skipping those left the edge with
        // no route at all — so it fell back to a line between node CENTRES,
        // which is diagonal whenever the two nodes are not aligned. That was
        // most of the diagonals left inside boxes, web app to API included.
        if (!section) continue;
        const base = origin.get(e.container ?? 'root') ?? { x: 0, y: 0 };
        // Keep the start and end points, not just the bends. They sit on the
        // node's boundary and are where the orthogonal route actually begins
        // and ends; joining a node's CENTRE straight to the first bend instead
        // puts a diagonal stub on every edge, which is exactly the thing right
        // angles were chosen to avoid.
        const pts: Array<[number, number]> = [];
        for (const p of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) {
          pts.push([px(base.x + p.x), py(base.y + p.y)]);
        }
        const sa = nodeAt.get(e.sources[0]);
        const sb = nodeAt.get(e.targets[0]);
        routes[e.id] = flatten(
          squareEnds(
            pts,
            sa ? [px(sa.x), py(sa.y)] : pts[0],
            sb ? [px(sb.x), py(sb.y)] : pts[pts.length - 1],
          ),
        );
        elkRouted++;
      }

      // -- corridors between boxes ---------------------------------------------
      //
      // Separating children buys clean box interiors at a price ELK does not
      // announce: it does not route the edges BETWEEN boxes at all. They come
      // back with no sections, and drawing them from node centre to node centre
      // is what makes the picture read as a street map — every connection taking
      // its own diagonal across everything.
      //
      // So the inter-box layer is routed here, the way a transit map does it.
      // Every edge running from box A to box B leaves A's facing edge, runs
      // along a shared corridor in the gap, and enters B's facing edge. Each
      // edge of the pair gets its own lane in that corridor, a fixed distance
      // from its neighbours, so parallel connections read as parallel lines
      // rather than as one ambiguous smear.
      const LANE = 16;
      /**
       * What an edge end is anchored to. A node in a box anchors to the box; a
       * node the grouping could not place anchors to itself, standing in as a
       * box of zero size. Without that second case every edge touching an
       * ungrouped node fell through unrouted — 259 of them under the repository
       * grouping and 366 under deployment, which is most of those two diagrams.
       */
      const anchorOf = (id: string) => nodeBox.get(id) ?? `node::${id}`;
      const rectOf = (anchor: string) => {
        const box = boxRect.get(anchor);
        if (box) return box;
        const p = nodeAt.get(anchor.slice(6));
        return p ? { x: p.x, y: p.y, w: 0, h: 0 } : undefined;
      };

      let jogs = 0;
      const byPair = new Map<string, GraphEdge[]>();
      for (const e of routable) {
        if (routes[e.id]) continue;
        if (!nodeAt.has(e.source) || !nodeAt.has(e.target)) continue;
        const ba = anchorOf(e.source);
        const bb = anchorOf(e.target);
        if (ba === bb) {
          // Both ends in the same box with no route of their own: the shared
          // dependency layer, which ELK never sees. There is no gap to cross,
          // so it gets a plain jog rather than a corridor — but a jog, not the
          // diagonal it would otherwise draw straight through the box.
          const a = nodeAt.get(e.source)!;
          const b = nodeAt.get(e.target)!;
          if (Math.abs(a.x - b.x) > 1 && Math.abs(a.y - b.y) > 1) {
            const mid = (a.y + b.y) / 2;
            routes[e.id] = flatten([[px(a.x), py(mid)], [px(b.x), py(mid)]]);
            jogs++;
          }
          continue;
        }
        const k = `${ba} ${bb}`;
        if (!byPair.has(k)) byPair.set(k, []);
        byPair.get(k)!.push(e);
      }

      let corridors = 0;
      for (const [k, list] of byPair) {
        const [ba, bb] = k.split(' ');
        const A = rectOf(ba);
        const B = rectOf(bb);
        if (!A || !B) continue;
        const acx = A.x + A.w / 2;
        const acy = A.y + A.h / 2;
        const bcx = B.x + B.w / 2;
        const bcy = B.y + B.h / 2;
        // Run the corridor along whichever axis actually separates the boxes.
        const vertical = Math.abs(bcy - acy) >= Math.abs(bcx - acx);

        // Sort by where each edge's endpoints sit across the corridor, so lanes
        // are assigned in the order the lines already want to cross. Assigning
        // them arbitrarily would braid every bundle.
        const across = (e: GraphEdge) =>
          vertical
            ? nodeAt.get(e.source)!.x + nodeAt.get(e.target)!.x
            : nodeAt.get(e.source)!.y + nodeAt.get(e.target)!.y;
        list.sort((p, q) => across(p) - across(q));

        list.forEach((e, i) => {
          const a = nodeAt.get(e.source)!;
          const b = nodeAt.get(e.target)!;
          const lane = (i - (list.length - 1) / 2) * LANE;
          const pts: Pt[] = [];
          const push = (x: number, y: number) => pts.push([px(x), py(y)]);
          if (vertical) {
            const down = bcy > acy;
            const exit = down ? A.y + A.h : A.y;
            const entry = down ? B.y : B.y + B.h;
            push(a.x, exit);
            push(a.x, (exit + entry) / 2 + lane);
            push(b.x, (exit + entry) / 2 + lane);
            push(b.x, entry);
          } else {
            const right = bcx > acx;
            const exit = right ? A.x + A.w : A.x;
            const entry = right ? B.x : B.x + B.w;
            push(exit, a.y);
            push((exit + entry) / 2 + lane, a.y);
            push((exit + entry) / 2 + lane, b.y);
            push(entry, b.y);
          }
          routes[e.id] = flatten(pts);
          corridors++;
        });
      }

      // -- guided-flow hops ----------------------------------------------------
      //
      // A flow step is a curated claim about a journey, and it does not have to
      // correspond to an edge the extraction found: ten of the 107 steps name a
      // hop with no edge in either direction, and eleven more match an edge only
      // backwards. Both were falling through to a straight line from node centre
      // to node centre, which is why a flow would suddenly draw a diagonal
      // across an otherwise square diagram and then take it away again.
      //
      // Route them the same way, keyed by the pair so the viewer can find one
      // without an edge id.
      const covered = new Set<string>();
      for (const e of edges) {
        if (!routes[e.id]) continue;
        covered.add(`${e.source}|${e.target}`);
        covered.add(`${e.target}|${e.source}`);
      }
      let flowHops = 0;
      for (const flow of r.flows ?? []) {
        for (const step of flow.steps) {
          const pair = `${step.from}|${step.to}`;
          if (covered.has(pair)) continue;
          const a = nodeAt.get(step.from);
          const b = nodeAt.get(step.to);
          if (!a || !b) continue;
          covered.add(pair);
          // Anchored the same way edges are, so a hop touching an ungrouped
          // node still gets a route instead of falling back to a diagonal.
          const anchorA = anchorOf(step.from);
          const anchorB = anchorOf(step.to);
          if (anchorA === anchorB) {
            // Nothing to cross, but a straight line between two nodes that are
            // not in line is still a diagonal. Jog instead.
            if (Math.abs(a.x - b.x) > 1 && Math.abs(a.y - b.y) > 1) {
              const mid = (a.y + b.y) / 2;
              routes[`pair:${pair}`] = flatten([[px(a.x), py(mid)], [px(b.x), py(mid)]]);
              flowHops++;
            }
            continue;
          }
          const A = rectOf(anchorA);
          const B = rectOf(anchorB);
          if (!A || !B) continue;
          const vertical = Math.abs(B.y - A.y) >= Math.abs(B.x - A.x);
          const pts: Pt[] = [];
          const push = (x: number, y: number) => pts.push([px(x), py(y)]);
          if (vertical) {
            const down = B.y + B.h / 2 > A.y + A.h / 2;
            const exit = down ? A.y + A.h : A.y;
            const entry = down ? B.y : B.y + B.h;
            push(a.x, exit);
            push(a.x, (exit + entry) / 2);
            push(b.x, (exit + entry) / 2);
            push(b.x, entry);
          } else {
            const right = B.x + B.w / 2 > A.x + A.w / 2;
            const exit = right ? A.x + A.w : A.x;
            const entry = right ? B.x : B.x + B.w;
            push(exit, a.y);
            push((exit + entry) / 2, a.y);
            push((exit + entry) / 2, b.y);
            push(entry, b.y);
          }
          routes[`pair:${pair}`] = flatten(pts);
          flowHops++;
        }
      }

      routesOut[key] = routes;

      ctx.log(
        `        ${key}: ${buckets.size} boxes, ${nodeAt.size} placed, ${loose.length} loose, ` +
          `${elkRouted} routed by elk, ${corridors} through ${byPair.size} corridors, ${jogs} jogs, ${flowHops} flow hops`,
      );
    }

    return { groups: groupsOut, routes: routesOut };
  },
};
