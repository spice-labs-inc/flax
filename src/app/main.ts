// Glue: filter state, projected labels, picking, the inspector, and the flow
// player. Nothing here simulates layout — positions arrive precomputed.

import { Vector3 } from 'three';
import type { AdvisoryRecord, Flow, Graph, GraphEdge, GraphNode, Group, GroupKey, Layer, Plane } from '../model/types.ts';
import { GROUP_KEYS } from '../model/types.ts';
import { buildScene, LAYER_COLOR, nodeColor, nodeRadius, PLANE_COLOR, setPlaneColors } from './scene.ts';
import type { ViewerConfig } from '../model/viewer-config.ts';
import { buildScene2d } from './scene2d.ts';

const graph: Graph = JSON.parse(document.getElementById('graph-data')!.textContent!);
const CONFIG: ViewerConfig = JSON.parse(document.getElementById('atlas-config')!.textContent!);
setPlaneColors(Object.fromEntries(CONFIG.planes.map((p) => [p.id, p.color])));
/**
 * A delivery target's shell or box holds only the target, and the target's own
 * label already names it; a second name on the rim would say it twice.
 */
const targetGroups = new Set((graph.groups?.plane ?? []).filter((g) => g.within).map((g) => g.id));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const LAYER_LABEL: Record<Layer, string> = {
  network: 'Network calls',
  queue: 'Queues & events',
  data: 'Data & storage',
  build: 'Build deps',
  delivery: 'Delivery',
  'shared-deps': 'Shared dependencies',
  advisory: 'Shared advisories',
};
const LAYER_VERB: Record<Layer, string> = {
  network: 'calls',
  queue: 'publishes to',
  data: 'reads / writes',
  build: 'depends on',
  delivery: 'ships via',
  'shared-deps': 'shares code with',
  advisory: 'shares an advisory with',
};
const PLANE_LABEL: Record<Plane, string> = Object.fromEntries(CONFIG.planes.map((p) => [p.id, p.label]));
/** One palette for severity, used by the pills, the filter rows and the nodes. */
const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ff4d4d',
  high: '#ff8a4d',
  medium: '#ffc04d',
  low: '#9fb2c1',
  unrated: '#7e8fa0',
};

const KIND_LABEL: Record<string, string> = {
  component: 'Component',
  library: 'Library',
  queue: 'Queue',
  broker: 'Message broker',
  store: 'Datastore',
  external: 'External service',
  registry: 'Registry',
  env: 'Environment',
  outlet: 'Delivery target',
  machine: 'Machine',
};

// -- state -------------------------------------------------------------------

const state = {
  layers: new Set<Layer>(['network', 'queue']),
  planes: new Set<Plane>(CONFIG.defaultPlanes),
  visibility: 'all' as 'all' | 'public' | 'internal',
  status: 'live' as 'live' | 'all',
  query: '',
  sizeScale: 1,
  /** Which advisory bands count toward the sizing. */
  severities: new Set(['critical']),
  /**
   * Size nodes by the advisories they carry instead of by how connected they
   * are. Same grammar as the default — size is "how much of THIS, here" — so
   * the map keeps its shape and only the meaning of bigness changes.
   */
  byAdvisories: false,
  selected: null as { type: 'node'; id: string } | { type: 'edge'; id: string } | null,
  flow: null as { flow: Flow; step: number } | null,
  /** What the pointer is over. Focuses like a selection, without committing. */
  hover: null as { type: 'node' | 'edge'; id: string } | null,
  /** Which renderer is on screen. The 3D map is the one people have learned. */
  mode: '3d' as '3d' | '2d',
  /** What the 2D boxes mean. Only read in 2D. */
  grouping: 'plane' as GroupKey,
  /** Whether the group containers are drawn: shells in 3D, boxes in the flat view. */
  shells: true,
};

const byId = new Map(graph.nodes.map((n) => [n.id, n]));
const adjacency = new Map<string, GraphEdge[]>();
for (const e of graph.edges) {
  if (!adjacency.has(e.source)) adjacency.set(e.source, []);
  if (!adjacency.has(e.target)) adjacency.set(e.target, []);
  adjacency.get(e.source)!.push(e);
  adjacency.get(e.target)!.push(e);
}

const canvas = $<HTMLCanvasElement>('gl');
const view = buildScene(canvas, graph);
const canvas2 = $<HTMLCanvasElement>('gl2');
const view2 = buildScene2d(canvas2, graph);

/** The canvas the pointer is currently talking to. */
const liveCanvas = () => (state.mode === '2d' ? canvas2 : canvas);

/**
 * Filter state is fanned out to both renderers rather than only the visible
 * one. Repainting 304 nodes twice costs nothing, and it means switching
 * dimension never shows a view that is a filter behind.
 */
/**
 * In the flat view, filtered-out things do not vanish — they go behind the
 * frosted glass, which is the whole point of having glass. In the 3D map they
 * still disappear: there is no glass there, so a ghost would just be clutter.
 */
const GHOST = 0.085;
// Negative means context: drawn behind the glass at that magnitude. Filtered-out
// things become context; things that are merely QUIET — build deps, shared
// dependencies — stay positive and stay sharp.
const ghost = (a: number) => (a <= 0 ? -GHOST : a);

/** Last applied node size, in world units, keyed by node. */
const nodeSizeById = new Map<string, number>();

const paint = {
  setNodeAlpha(fn: (n: GraphNode, i: number) => number) {
    // The 3D view has no glass, so it only wants the magnitude.
    view.setNodeAlpha((n, i) => Math.abs(fn(n, i)));
    view2.setNodeAlpha((n, i) => ghost(fn(n, i)));
  },
  setNodeSize(fn: (n: GraphNode, i: number) => number) {
    // Remembered so the pointer's node target can match the node's drawn size.
    view.setNodeSize((n, i) => {
      const s = fn(n, i);
      nodeSizeById.set(n.id, s);
      return s;
    });
    view2.setNodeSize(fn);
  },
  setNodeTint(fn: (n: GraphNode, i: number) => string) {
    view.setNodeTint(fn);
    view2.setNodeTint(fn);
  },
  setEdgeAlpha(fn: (e: GraphEdge, i: number) => number) {
    view.setEdgeAlpha((e, i) => Math.abs(fn(e, i)));
    view2.setEdgeAlpha((e, i) => ghost(fn(e, i)));
  },
  setHighlight(list: Array<{ source: string; target: string; layer: Layer }>) {
    view.setHighlight(list);
    view2.setHighlight(list);
  },
};

/** Where a node sits in whichever dimension is on screen. */
function nodePos(n: GraphNode): Vector3 {
  return state.mode === '2d' ? view2.positionOf(n) : new Vector3(n.x!, n.y!, n.z!);
}

// -- filtering ---------------------------------------------------------------

function nodePasses(n: GraphNode): boolean {
  if (!state.planes.has(n.plane)) return false;
  if (state.status === 'live' && !['active', 'maintenance'].includes(n.status)) return false;
  if (state.visibility === 'public' && n.visibility !== 'public') return false;
  if (state.visibility === 'internal' && n.visibility === 'public') return false;
  return true;
}

/** Advisories on this node that pass the severity filter, worst first. */
function advisoriesOn(n: GraphNode): AdvisoryRecord[] {
  if (!n.advisoryIds?.length || !graph.advisories) return [];
  return n.advisoryIds
    .map((id) => graph.advisories![id])
    .filter((a): a is AdvisoryRecord => !!a && state.severities.has(a.severity));
}

function matchesQuery(n: GraphNode): boolean {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return (
    n.label.toLowerCase().includes(q) ||
    n.id.toLowerCase().includes(q) ||
    (n.repo ?? '').toLowerCase().includes(q) ||
    (n.language ?? '').toLowerCase().includes(q)
  );
}

/** Nodes and edges belonging to the flow, up to and including the current step. */
function flowSets(): { nodes: Set<string>; hops: Set<string>; head: Set<string>; later: Set<string>; done: Set<string> } {
  const nodes = new Set<string>();
  const hops = new Set<string>();
  const head = new Set<string>();
  const later = new Set<string>();
  const done = new Set<string>();
  if (!state.flow) return { nodes, hops, head, later, done };
  const { flow, step } = state.flow;
  // The entire path stays on screen: a single lit edge is not a picture of a
  // system. Position in the journey is carried by brightness instead.
  flow.steps.forEach((s, i) => {
    hops.add(`${s.from}|${s.to}`);
    if (i <= step) {
      nodes.add(s.from);
      nodes.add(s.to);
      done.add(`${s.from}|${s.to}`);
    } else {
      later.add(s.from);
      later.add(s.to);
    }
    if (i === step) {
      head.add(s.from);
      head.add(s.to);
    }
  });
  return { nodes, hops, head, later, done };
}

let visibleNodeIds = new Set<string>();
/** The edges actually drawn, recomputed only when the filters change. */
let visibleEdges: GraphEdge[] = [];
/**
 * What the current selection touches, or null when nothing is selected.
 * Everything outside it is pushed down rather than hidden, so the selection
 * reads against the shape of the graph instead of floating on its own.
 */
let focusIds: Set<string> | null = null;

function applyFilters(): void {
  // Hovering a connection reads like selecting it, minus the commitment: the
  // same focus and the same dimming, but no inspector and no history entry.
  // With this many parallel corridors, following one line by eye is only
  // possible once the others are out of the way.
  const sel = state.selected ?? state.hover;
  // A hover is a lighter question than a click. Selecting a node reads THROUGH
  // waypoints to show a whole path; pointing at one should just answer what it
  // is wired to, so the hover case stops at one hop.
  const glance = !state.selected && state.hover !== null;
  const view0 = VIEWS.find((v) => v.id === activeView);
  const mutedEdges = !state.flow && !sel && view0?.mutedEdges === true;
  // The layer a view is ABOUT. Everything else in it becomes context.
  const subject = !state.flow && !sel ? view0?.subject : undefined;
  const inFlow = flowSets();
  const flowing = state.flow !== null;
  visibleNodeIds = new Set();

  // 1. which nodes survive the filters (or belong to the running flow)
  for (const n of view.nodes) {
    if (flowing) {
      if (inFlow.nodes.has(n.id) || inFlow.later.has(n.id)) visibleNodeIds.add(n.id);
    } else if (nodePasses(n)) {
      visibleNodeIds.add(n.id);
    }
  }

  // 2. which edges are actually drawn
  const edgeShown = (e: GraphEdge): boolean => {
    if (flowing) return inFlow.hops.has(`${e.source}|${e.target}`) || inFlow.hops.has(`${e.target}|${e.source}`);
    return state.layers.has(e.layer) && visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target);
  };

  // 3. connectivity counted from what is on screen, not the whole graph, so a
  //    node's size answers "how connected is it *in this view*".
  const shownDegree = new Map<string, number>();
  let shownLinks = 0;
  for (const e of graph.edges) {
    if (!edgeShown(e)) continue;
    shownLinks++;
    shownDegree.set(e.source, (shownDegree.get(e.source) ?? 0) + 1);
    shownDegree.set(e.target, (shownDegree.get(e.target) ?? 0) + 1);
  }

  // A node with no visible connection carries no information here — the filters
  // already said it exists. The product plane alone holds 42 datastores and 29
  // queues, and left in they were most of what was on screen.
  let unconnected = 0;
  if (!flowing) {
    for (const id of [...visibleNodeIds]) {
      if (!shownDegree.has(id)) {
        visibleNodeIds.delete(id);
        unconnected++;
      }
    }
  }

  focusIds = null;
  if (!flowing && sel) {
    focusIds = new Set<string>();
    if (sel.type === 'node') {
      // Read through waypoints. A gateway is not what the web app is talking
      // to, and an API forwarding a read is not what answered it, so selecting
      // either end lights the other, with the middle lit too.
      //
      // Two ways to keep going: the node reached is pure transit, in which case
      // every one of its edges continues the path; or the hop taken was itself a
      // forward, in which case only further forwards continue it. Without that
      // second restriction, touching the API would light everything it knows.
      focusIds.add(sel.id);
      if (glance) {
        // One hop: this node, and whatever it is directly wired to.
        for (const e of adjacency.get(sel.id) ?? []) {
          if (!edgeShown(e)) continue;
          focusIds.add(e.source === sel.id ? e.target : e.source);
        }
      } else {
      const frontier: Array<{ id: string; all: boolean }> = [{ id: sel.id, all: true }];
      const walked = new Set<string>([sel.id]);
      while (frontier.length) {
        const { id, all } = frontier.pop()!;
        for (const e of adjacency.get(id) ?? []) {
          if (!edgeShown(e)) continue;
          if (!all && !e.proxy) continue;
          const other = e.source === id ? e.target : e.source;
          focusIds.add(other);
          if (walked.has(other)) continue;
          // Every neighbour is walked, but only a transit node is walked freely.
          // Anything else continues along its forwarding hops alone, which is
          // what carries web app -> gateway -> API -> report service to the end
          // without dragging in the rest of what the API touches.
          walked.add(other);
          frontier.push({ id: other, all: byId.get(other)?.transit === true });
        }
      }
      }
    } else {
      const e = graph.edges.find((x) => x.id === sel.id);
      if (e) {
        focusIds.add(e.source);
        focusIds.add(e.target);
      }
    }
  }

  // In advisory mode a node's size is its advisory count, not its degree — and
  // a component carrying none shrinks to its base size rather than vanishing,
  // because "clean" is an answer worth seeing next to "eleven criticals".
  paint.setNodeSize((n) => {
    if (!state.byAdvisories) return nodeRadius(n, shownDegree.get(n.id) ?? 0) * state.sizeScale;
    // Advisory sizing needs a longer reach than connection sizing. Borrowing
    // the degree curve alone put eleven criticals barely above a clean
    // component, and this is the one view where that difference IS the content,
    // so the count also drives a multiplier on top of the curve.
    const carried = advisoriesOn(n).length;
    const lift = 1 + Math.min(1.6, carried * 0.22);
    return nodeRadius(n, carried * 3) * state.sizeScale * lift;
  });
  paint.setNodeTint((n) => {
    if (!state.byAdvisories) return nodeColor(n);
    const worst = advisoriesOn(n)[0];
    return worst ? SEVERITY_COLOR[worst.severity] ?? nodeColor(n) : '#3d4a57';
  });

  paint.setNodeAlpha((n) => {
    if (flowing) {
      if (inFlow.head.has(n.id)) return 1;
      if (inFlow.nodes.has(n.id)) return 0.8;
      if (inFlow.later.has(n.id)) return 0.55;
      return 0;
    }
    if (!visibleNodeIds.has(n.id)) return 0;
    // Out of focus is context, and goes behind the glass.
    if (focusIds && !focusIds.has(n.id)) return -0.09;
    return matchesQuery(n) ? 1 : 0.14;
  });

  paint.setEdgeAlpha((e) => {
    if (!edgeShown(e)) return 0;
    if (flowing) {
      const cur = state.flow!.flow.steps[state.flow!.step];
      const isHead = (e.source === cur.from && e.target === cur.to) || (e.source === cur.to && e.target === cur.from);
      if (isHead) return 1;
      const done = inFlow.done.has(`${e.source}|${e.target}`) || inFlow.done.has(`${e.target}|${e.source}`);
      return done ? 0.6 : 0.34;
    }
    // Advisories is a view about nodes: which components carry what. The
    // connections are still needed to decide what is ON screen — a node with no
    // visible connection is dropped as uninformative — but they are not the
    // subject, so they recede to context and let the sizing speak.
    if (mutedEdges) return -0.06;
    if (subject) return e.layer === subject ? 0.95 : -0.1;
    const picked = sel;
    if (picked?.type === 'node' && (e.source === picked.id || e.target === picked.id)) return 1;
    if (picked?.type === 'edge' && e.id === picked.id) return 1;
    // Everything the selection does not touch drops well below the layer's
    // resting brightness, so a dense view can be read one node at a time.
    if (picked) return -0.05;
    const rest = e.layer === 'build' ? 0.24 : e.layer === 'shared-deps' ? 0.22 : 0.52;
    // A box with heavy internal traffic — Product has 49 nodes and 158 edges
    // between them — buries the corridors leaving it under its own wiring. ELK
    // cannot fix that for free: DEPTH_FIRST cycle breaking takes the crossings
    // inside Product from 1326 to 1169, and pays 29% more box area and 20%
    // longer routes for it (measured).
    //
    // So the fix is weight, not layout. Traffic INSIDE a box rests quieter than
    // traffic crossing between boxes, which lets the box read as texture and
    // the corridors as structure. At rest only: a selected or flowing edge is
    // being asked about and answers at full strength either way.
    return state.mode === '2d' && view2.sameBox(e) ? rest * 0.6 : rest;
  });

  visibleEdges = graph.edges.filter(edgeShown);
  rebuildPulseTracks(edgeShown, sel);

  // Whatever is in focus gets drawn again, thicker and on top.
  if (state.flow) {
    const s = state.flow.flow.steps[state.flow.step];
    // The step, not the underlying edge — otherwise a response hop is drawn
    // along the request edge and reads backwards.
    paint.setHighlight([{ source: s.from, target: s.to, layer: s.layer }]);
  } else if (sel?.type === 'node') {
    paint.setHighlight(graph.edges.filter((e) => state.layers.has(e.layer) && (e.source === sel.id || e.target === sel.id)));
  } else if (sel?.type === 'edge') {
    paint.setHighlight(graph.edges.filter((e) => e.id === sel.id));
  } else {
    paint.setHighlight([]);
  }

  // A box whose contents are all filtered out stays drawn but recedes: the flat
  // view lays boxes out on a plane, so an empty one leaves a hole that says
  // something was there.
  //
  // A shell is not a box. It has no reserved place — it is a volume around
  // wherever its members happen to sit — so an empty one is a bubble of nothing
  // sitting over other groups' nodes, and its rim reads as a shape in the map.
  // Empty shells therefore go all the way out, label included. A shell that is
  // merely out of FOCUS still holds visible nodes and stays.
  emptyFields.clear();
  view.setFieldAlpha((id, members) => {
    if (!state.shells) return 0;
    const live = members.some((n) => visibleNodeIds.has(n.id));
    if (!live) {
      emptyFields.add(id);
      return 0;
    }
    if (focusIds && !members.some((n) => focusIds!.has(n.id))) return 0.3;
    return 0.42;
  });

  dimBoxes.clear();
  view2.setBoxAlpha((g, members) => {
    if (!state.shells) return 0;
    const live = members.some((n) => visibleNodeIds.has(n.id));
    const a = !live ? -0.16 : focusIds && !members.some((n) => focusIds!.has(n.id)) ? -0.3 : 1;
    // Remembered so the DOM labels can be frosted to match their box.
    if (a < 0) dimBoxes.add(g.id);
    return a;
  });

  if (state.flow) {
    // Mid-flow the visible set is one hop, so node counts read as broken.
    // Report progress through the journey instead.
    const { flow, step } = state.flow;
    $('counts').textContent = `step ${step + 1} of ${flow.steps.length} · ${flow.plane}`;
  } else {
    // A CVE view without a visible date is worse than none: it looks current.
    const stamp =
      state.byAdvisories && graph.advisoriesAsOf
        ? ` · advisories as of ${graph.advisoriesAsOf.slice(0, 10)}`
        : '';
    $('counts').textContent =
      `${visibleNodeIds.size} nodes · ${shownLinks} connections` +
      (unconnected ? ` · ${unconnected} unconnected hidden` : '') +
      stamp;
  }
}



/** Any deliberate navigation drops out of a guided flow first. */
function leaveFlowIfRunning(): void {
  if (state.flow) exitFlow();
}

/** Opening on the whole graph shows nothing. Each preset is a legible answer. */
const VIEWS: Array<{ id: string; label: string; hint: string; layers: Layer[]; planes: Plane[]; byAdvisories?: boolean; mutedEdges?: boolean; subject?: Layer }> = CONFIG.views.map((v) => ({ ...v, layers: v.layers as Layer[], subject: v.subject as Layer | undefined }));
const DEFAULT_VIEW = VIEWS[0]?.id ?? 'all';
let activeView = DEFAULT_VIEW;

function applyView(id: string): void {
  const v = VIEWS.find((x) => x.id === id);
  if (!v) return;
  leaveFlowIfRunning();
  activeView = id;
  state.layers = new Set(v.layers);
  state.planes = new Set(v.planes);
  state.byAdvisories = v.byAdvisories === true;
  syncToggleRows();
  for (const b of $('views').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.view === id));
  }
  applyFilters();
  frameVisible();
  pushRoute();
}

// -- dimension ---------------------------------------------------------------

function setMode(next: '3d' | '2d'): void {
  state.mode = next;
  const flat = next === '2d';
  canvas.hidden = flat;
  canvas2.hidden = !flat;
  // Which of the two controls is on screen is decided by syncDimensionControls
  // below, not here: they belong to different views now.
  // The label layer serves both: boxes in the flat view, force fields in 3D.
  $('boxlabels').style.display = 'block';
  $('hint').textContent = flat
    ? 'drag to pan · scroll to zoom · click a node to inspect'
    : 'drag to orbit · scroll to zoom · click a node to inspect · shift-click for a meteor, alt-click to throw one';
  for (const b of $('dim').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.d === next));
  }
  syncDimensionControls();
  // Both renderers share the window, and the hidden one never resized while it
  // was hidden. Re-assert the size before the first frame in the new mode.
  resize();
  applyFilters();
  frameVisible();
  pushRoute();
}

/**
 * Show or hide the 3D group shells.
 *
 * Deliberately NOT tied to the routing: an edge still runs its group's corridor
 * with the shells hidden, because "where does this cross to" and "draw me the
 * volumes" are two questions and one control should not answer both.
 */
function setShells(next: boolean): void {
  if (next === state.shells) return;
  state.shells = next;
  for (const b of $('shellwrap').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(((b as HTMLElement).dataset.sh === 'on') === next));
  }
  applyFilters();
  pushRoute();
}

/**
 * The grouping question belongs to the FLAT view; the shell switch belongs to
 * the 3D one. Each view shows the control that does something in it.
 *
 * This used to be one control shared by both, which was true while the 3D map
 * drew a shell per group for every grouping. It does not any more — only plane
 * puts its members anywhere near each other, so the others were ruled out — and
 * a 3D map's node POSITIONS never depended on the grouping in the first place.
 * The result was three buttons that visibly did nothing: pressing Kind in the
 * 3D view removed the shells, removed the corridors the edges were routed
 * through, and put nothing in their place.
 *
 * So the 3D map is pinned to plane and does not offer the choice. The flat view
 * still offers all four, and the URL still carries whichever was picked.
 */
function syncDimensionControls(): void {
  // One control, both views: it hides the boxes in the flat view and the shells
  // in the 3D one, which are the same thing drawn two ways.
  $('shellwrap').hidden = false;
}

function buildDimension(): void {
  // A graph generated before the 2D layouts existed carries no boxes. Offering
  // a dimension switch that lands on an empty canvas would be worse than not
  // offering one, so the whole control stays out of the rail.
  if (!graph.groups?.plane?.length) {
    $('dim').closest('.group')?.remove();
    return;
  }
  // Unhidden here, not in setMode: booting straight into the 3D map never calls
  // setMode, and the label layer belongs to both views.
  $('boxlabels').style.display = 'block';
  syncDimensionControls();
  for (const b of $('dim').querySelectorAll('button')) {
    b.addEventListener('click', () => setMode((b as HTMLElement).dataset.d as '3d' | '2d'));
  }
  for (const b of $('shellwrap').querySelectorAll('button')) {
    b.addEventListener('click', () => setShells((b as HTMLElement).dataset.sh === 'on'));
  }
}

// -- box labels --------------------------------------------------------------

const boxLayer = $('boxlabels');
/** Boxes currently behind the glass, so their labels can be frosted to match. */
const dimBoxes = new Set<string>();
/** Shells with nothing visible inside them: hidden, so their labels go too. */
const emptyFields = new Set<string>();
const boxPool: HTMLDivElement[] = [];

/** Name each box above its top-left corner, and say how much is in it. */
function drawBoxLabels(): void {
  // The 3D map names its force fields the same way the flat one names its
  // boxes: a shell with no label is decoration, not a group. It writes them on
  // the shell rather than over it, so it uses the SVG layer and the flat one
  // uses the DOM layer.
  arcLayer.style.display = state.mode === '2d' ? 'none' : 'block';
  $('boxlabels').style.display = state.mode === '2d' ? 'block' : 'none';
  if (state.mode !== '2d') {
    drawFieldLabels();
    return;
  }
  const boxes = state.shells ? view2.boxes() : [];
  const w = innerWidth;
  const h = innerHeight;

  // Project first, then place. Boxes that still hold something visible get
  // first claim on the space; a frosted box losing its label to a live one is
  // the right trade, and the reverse is not.
  // The box's whole rectangle in screen pixels, not just its corner. A label
  // has to be placed against the box as DRAWN: the box shrinks as you zoom out
  // and the text does not, so anything measured in world units stops fitting.
  const wanted = boxes
    .map((g) => {
      projected.set(g.x - g.w / 2, g.y + g.h / 2, 0).project(view2.camera);
      const left = (projected.x * 0.5 + 0.5) * w;
      const top = (-projected.y * 0.5 + 0.5) * h;
      projected.set(g.x + g.w / 2, g.y - g.h / 2, 0).project(view2.camera);
      return {
        g,
        left,
        top,
        right: (projected.x * 0.5 + 0.5) * w,
        bottom: (-projected.y * 0.5 + 0.5) * h,
        live: !dimBoxes.has(g.id),
      };
    })
    .filter((p) => p.right > -200 && p.left < w + 200 && p.bottom > -60 && p.top < h + 60)
    // Live boxes claim space first — a frosted box losing its label to a live
    // one is the right trade and the reverse is not — and within each, the
    // biggest box on screen wins. Ordering by member COUNT instead meant a
    // populous box drawn small could take the space from the large one behind
    // it, and which name survived changed as you zoomed.
    .sort((a, b) =>
      Number(b.live) - Number(a.live) ||
      (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top));

  const placed: Array<[number, number, number, number]> = [];
  let i = 0;
  for (const p of wanted) {
    if (targetGroups.has(p.g.id)) continue;
    // INSIDE the top-left corner, not above it. ELK reserves 64 units of extra
    // padding at the top of every box for exactly this, and the label used to
    // be drawn 20px above the border instead — outside the thing it names, and
    // increasingly far outside as the box shrank.
    const name = planeLabelFor(p.g);
    const avail = p.right - p.left - LABEL_PAD * 2;
    // The count is the first thing to go when the box gets narrow: a name with
    // no number still names the box, and a number with no name does not.
    let text = `${name} · ${p.g.count}`;
    let tw = labelWidth(text.toUpperCase(), GROUP_FONT) + text.length * GROUP_TRACK;
    if (tw > avail) {
      text = name;
      tw = labelWidth(text.toUpperCase(), GROUP_FONT) + text.length * GROUP_TRACK;
    }
    // A box drawn narrower or shorter than its own name has nothing useful to
    // say, and a label hanging off it says something false about where it is.
    if (tw > avail || p.bottom - p.top < 26) continue;

    const x = p.left + LABEL_PAD;
    const y = p.top + LABEL_PAD;
    const box: [number, number, number, number] = [x, y - 2, x + tw, y + 12];
    // Overlapping text is worse than missing text: the box border already says
    // the box is there.
    if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
    placed.push(box);

    let el = boxPool[i];
    if (!el) {
      el = document.createElement('div');
      boxLayer.appendChild(el);
      boxPool[i] = el;
    }
    if (el.dataset.text !== text) {
      el.textContent = text;
      el.dataset.text = text;
    }
    // The frosting happens in the shader, and these are DOM, so they have to be
    // put behind the glass by hand or they float sharply over their own blur.
    el.className = p.live ? 'boxlabel' : 'boxlabel frosted';
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    el.style.display = '';
    i++;
  }
  for (let k = i; k < boxPool.length; k++) boxPool[k].style.display = 'none';
}

/**
 * Name each 3D force field, near the top of its shell rather than at its centre
 * — the centre of a sphere is where the nodes are, and a label there sits in
 * the middle of the thing it is naming.
 *
 * Just INSIDE the rim, not on it. The label used to be placed at the projected
 * top of the sphere and drawn from that point down and to the right, so it
 * straddled the outline: half the text on the shell, half off it. Placing it
 * needs the shell's DRAWN radius in pixels, which is not something the world
 * radius can be scaled into — it depends on how far away the shell is. So a
 * second point is projected, one world radius up the CAMERA's own up axis, and
 * the distance between the two projections is the radius on screen.
 */
function drawFieldLabels(): void {
  const w = innerWidth;
  const h = innerHeight;
  const dpr = Math.min(devicePixelRatio, 2);
  if (arcLayer.width !== Math.round(w * dpr) || arcLayer.height !== Math.round(h * dpr)) {
    arcLayer.width = Math.round(w * dpr);
    arcLayer.height = Math.round(h * dpr);
  }
  arcCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  arcCtx.clearRect(0, 0, w, h);
  // Must track the values GROUP_FONT and the old stylesheet rule used, or the
  // measured widths stop matching what is drawn.
  arcCtx.font = SHELL_FONT;
  arcCtx.textAlign = 'center';
  arcCtx.textBaseline = 'middle';
  // No outline. It is on the shell, not over it, so it should sit in the same
  // light as the rim rather than being cut out of the picture.
  arcCtx.fillStyle = 'rgba(173, 195, 214, 0.42)';
  const shells = state.shells ? view.fields() : [];
  const placed: Array<[number, number, number, number]> = [];
  let i = 0;
  /**
   * How big a sphere's outline is on screen, exactly.
   *
   * The first version projected a point one world radius up the camera's up
   * axis and measured the gap. That is close to right in the middle of the view
   * and wrong everywhere else: under perspective the outline of a sphere is the
   * cone tangent to it, so its size depends only on how far away it is — but the
   * point-projection estimate also picks up how far OFF-AXIS the sphere is, and
   * that changes continuously as the map turns. Every letter is placed along an
   * arc of this radius, so a radius that breathed made the whole label crawl.
   *
   * The tangent-cone half-angle is asin(r/d), which puts the outline at
   * r / sqrt(d² - r²) in view units. This depends on d alone, so it is smooth
   * under any rotation.
   */
  const halfH = Math.tan((view.camera.fov * Math.PI) / 360);
  const screenRadius = (centre: Vector3, radius: number): number => {
    const d = view.camera.position.distanceTo(centre);
    if (d <= radius * 1.02) return 0;
    return ((h / 2) * (radius / Math.sqrt(d * d - radius * radius))) / halfH;
  };
  // Biggest shell on screen claims space first, so which name survives a
  // collision does not change as the camera moves.
  const order = shells
    .slice()
    .sort((a, b) => b.radius / b.centre.distanceTo(view.camera.position) - a.radius / a.centre.distanceTo(view.camera.position));
  const seen = new Map<string, string>();

  for (const f of order) {
    // The shell itself is hidden, so naming it would leave a label floating over
    // whatever else is behind it.
    if (emptyFields.has(f.id) || targetGroups.has(f.id)) continue;
    projected.copy(f.centre).project(view.camera);
    if (projected.z > 1) continue;
    const cx = (projected.x * 0.5 + 0.5) * w;
    const cy = (-projected.y * 0.5 + 0.5) * h;
    const rpx = screenRadius(f.centre, f.radius);
    const had = namedLast.get(f.id);
    // A shell that was named shrinks further before losing its name than an
    // unnamed one has to grow to earn one.
    if (rpx < (had ? 30 : 38)) continue;

    const name = groupLabelFor(f.id);
    const width = (t: string) => labelWidth(t.toUpperCase(), SHELL_FONT) + t.length * SHELL_TRACK;
    // The arc the text is written along, a little inside the rim. Its length is
    // what decides whether the name fits: this is a curve, not a chord.
    const r = rpx - 15;
    const full = `${name} · ${f.count}`;
    // Only the top half is legible — past the sides the letters would be running
    // vertically — so the usable run is half the circumference.
    //
    // The dead band is what stops the count blinking in and out: the long form
    // has to fit with room to spare before it comes back, and has to overrun
    // before it goes away.
    const run = Math.PI * r;
    let text = had === full ? (width(full) > run * 1.04 ? name : full) : width(full) > run * 0.94 ? name : full;
    if (width(text) > run) continue;

    // Claim the cap of the sphere rather than a text box: two names bent around
    // two rims collide when the rims do.
    const box: [number, number, number, number] = [cx - r, cy - r - 8, cx + r, cy - r * 0.55];
    // A name already on screen has to be overlapped properly before it is
    // dropped; one that is not there has to find clear space.
    const slack = had ? 0.55 : 1;
    const hit = placed.some((q) => {
      const ox = Math.min(box[2], q[2]) - Math.max(box[0], q[0]);
      const oy = Math.min(box[3], q[3]) - Math.max(box[1], q[1]);
      return ox > 0 && oy > 0 && ox * oy > (1 - slack) * (box[2] - box[0]) * (box[3] - box[1]);
    });
    if (hit) continue;
    placed.push(box);
    seen.set(f.id, text);

    // Glyph by glyph around the arc. Canvas has no text-on-a-path, and it does
    // not need one: each character is placed at its own angle and rotated to
    // stand upright on the curve, which is all a path would have done.
    // The stylesheet used to uppercase these; canvas has no text-transform, and
    // the fit was measured on the uppercase form, so it has to be drawn that way.
    const shown = text.toUpperCase();
    const advance = shown.split('').map((ch) => arcCtx.measureText(ch).width + SHELL_TRACK);
    const total = advance.reduce((a, b) => a + b, 0);
    // Centred on the top of the circle, laid out clockwise from there.
    //
    // Zero is already the top: rotating by 0 and then stepping -r along y lands
    // straight above the centre. Subtracting a quarter turn as well, which is
    // what a path-based arc would have needed, swings the whole name round to
    // the left-hand side.
    let angle = -total / r / 2;
    for (let k = 0; k < shown.length; k++) {
      const step = advance[k] / r;
      arcCtx.save();
      arcCtx.translate(cx, cy);
      arcCtx.rotate(angle + step / 2);
      arcCtx.translate(0, -r);
      arcCtx.fillText(shown[k], 0, 0);
      arcCtx.restore();
      angle += step;
    }
    i++;
  }
  namedLast.clear();
  for (const [id, t] of seen) namedLast.set(id, t);
}

/**
 * Names a 3D shell. Always a plane now — the 3D map does not follow the flat
 * view's grouping — so reading state.grouping here would label the shells with
 * raw ids the moment the flat view was set to something else.
 */
function groupLabelFor(id: string): string {
  return PLANE_LABEL[id as Plane] ?? id;
}

/** Boxes carry raw ids; the rail's vocabulary is the one people read. */
function planeLabelFor(g: Group): string {
  if (state.grouping === 'plane') return PLANE_LABEL[g.id as Plane] ?? g.label;
  if (state.grouping === 'kind') return KIND_LABEL[g.id] ?? g.label;
  return g.label;
}

function buildViews(): void {
  const box = $('views');
  for (const v of VIEWS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.view = v.id;
    b.setAttribute('aria-pressed', String(v.id === activeView));
    b.innerHTML = `<strong style="display:block;font-weight:600">${v.label}</strong><span style="color:var(--ink-faint);font-size:10px">${v.hint}</span>`;
    b.addEventListener('click', () => applyView(v.id));
    box.appendChild(b);
  }
}

/** Keep the checkbox rows in step when a preset changes the sets underneath. */
const toggleRows: Array<{ el: HTMLElement; on: () => boolean }> = [];
function syncToggleRows(): void {
  for (const r of toggleRows) r.el.classList.toggle('on', r.on());
}


/** Edges currently carrying a travelling pulse, with how bright each should be. */
let pulseTracks: Array<{ id: string; source: string; target: string; layer: Layer; weight: number }> = [];
const PULSE_BUDGET = 240;

/**
 * How many edges carry an idle pulse when nothing is selected.
 *
 * Much smaller than the selection budget, and deliberately smaller than any
 * view's edge count: the point is a few things moving somewhere on the board so
 * direction stays legible, not the whole graph in motion. At 240 the "slice"
 * was every visible edge, because no view has that many.
 */
const AMBIENT_PULSE_BUDGET = 26;

function rebuildPulseTracks(shown: (e: GraphEdge) => boolean, picked: { type: 'node' | 'edge'; id: string } | null): void {
  if (state.flow) {
    const cur = state.flow.flow.steps[state.flow.step];
    pulseTracks = [{ id: '', source: cur.from, target: cur.to, layer: cur.layer, weight: 1 }];
    return;
  }
  // A pulse travels source to target, which reads as direction. Shared code has
  // none — the pair ordering is only there to keep edge ids stable — so this
  // layer never pulses.
  const visible = graph.edges.filter((e) => shown(e) && e.layer !== 'shared-deps');
  if (picked?.type === 'node') {
    const own = visible.filter((e) => e.source === picked.id || e.target === picked.id);
    if (own.length) {
      pulseTracks = own.slice(0, PULSE_BUDGET).map((e) => ({ id: e.id, source: e.source, target: e.target, layer: e.layer, weight: 1 }));
      return;
    }
  }
  if (picked?.type === 'edge') {
    const one = visible.filter((e) => e.id === picked.id);
    if (one.length) {
      pulseTracks = one.map((e) => ({ id: e.id, source: e.source, target: e.target, layer: e.layer, weight: 1 }));
      return;
    }
  }
  // Nothing selected: animate a slice of the graph so direction is always
  // legible somewhere, without paying for a pulse on all ~900 edges.
  const step = Math.max(1, Math.ceil(visible.length / AMBIENT_PULSE_BUDGET));
  // The consumer reads source/target/layer off each track, so spreading the
  // edge is required — building { e, weight } left every ambient pulse with an
  // undefined endpoint and nothing moved when nothing was selected.
  pulseTracks = visible
    .filter((_, i) => i % step === 0)
    .map((e) => ({ id: e.id, source: e.source, target: e.target, layer: e.layer, weight: 0.38 }));
}

// -- rail --------------------------------------------------------------------

function buildToggles(): void {
  const layerBox = $('layers');
  for (const layer of Object.keys(LAYER_LABEL) as Layer[]) {
    const count = graph.edges.filter((e) => e.layer === layer).length;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `row${state.layers.has(layer) ? ' on' : ''}`;
    row.style.color = LAYER_COLOR[layer];
    const maxLayer = Math.max(...(Object.keys(LAYER_LABEL) as Layer[]).map((l) => graph.edges.filter((e) => e.layer === l).length));
    row.innerHTML = `<span class="box"></span><span class="name">${LAYER_LABEL[layer]}</span><span class="bar" style="width:${Math.round((count / maxLayer) * 34) + 2}px"></span><span class="n">${count}</span>`;
    row.addEventListener('click', () => {
      leaveFlowIfRunning();
      state.layers.has(layer) ? state.layers.delete(layer) : state.layers.add(layer);
      row.classList.toggle('on', state.layers.has(layer));
      applyFilters();
      pushRoute(true);
    });
    toggleRows.push({ el: row, on: () => state.layers.has(layer) });
    layerBox.appendChild(row);
  }

  const planeBox = $('planes');
  for (const plane of Object.keys(PLANE_LABEL) as Plane[]) {
    const count = graph.nodes.filter((n) => n.plane === plane).length;
    if (!count) continue;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row on';
    row.style.color = PLANE_COLOR[plane];
    row.className = `row${state.planes.has(plane) ? ' on' : ''}`;
    row.innerHTML = `<span class="box"></span><span class="name">${PLANE_LABEL[plane]}</span><span class="n">${count}</span>`;
    row.addEventListener('click', () => {
      leaveFlowIfRunning();
      state.planes.has(plane) ? state.planes.delete(plane) : state.planes.add(plane);
      row.classList.toggle('on', state.planes.has(plane));
      applyFilters();
      pushRoute(true);
    });
    toggleRows.push({ el: row, on: () => state.planes.has(plane) });
    planeBox.appendChild(row);
  }

  // Severity, for the advisory layer. The group hides itself when there are no
  // advisories, so a graph generated without a capture shows no dead control.
  const sevBox = $('severities');
  const SEV = ['critical', 'high', 'medium', 'low', 'unrated'];
  const catalogue = Object.values(graph.advisories ?? {});
  if (!catalogue.length) {
    sevBox.closest('.group')?.remove();
  } else {
    for (const sev of SEV) {
      const count = catalogue.filter((a) => a.severity === sev).length;
      if (!count) continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.style.color = SEVERITY_COLOR[sev];
      row.className = `row${state.severities.has(sev) ? ' on' : ''}`;
      row.innerHTML = `<span class="box"></span><span class="name">${sev}</span><span class="n">${count}</span>`;
      row.addEventListener('click', () => {
        leaveFlowIfRunning();
        state.severities.has(sev) ? state.severities.delete(sev) : state.severities.add(sev);
        row.classList.toggle('on', state.severities.has(sev));
        applyFilters();
        pushRoute(true);
      });
      toggleRows.push({ el: row, on: () => state.severities.has(sev) });
      sevBox.appendChild(row);
    }
  }

  for (const [box, key] of [['visibility', 'v'], ['status', 's']] as const) {
    $(box).addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('button');
      if (!btn) return;
      for (const b of $(box).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
      leaveFlowIfRunning();
      (state as any)[box] = btn.dataset[key];
      applyFilters();
      pushRoute(true);
    });
  }

  const scale = $<HTMLInputElement>('nodescale');
  const scaleOut = $('nodescaleout');
  const applyScale = () => {
    state.sizeScale = Number(scale.value);
    scaleOut.textContent = `${state.sizeScale.toFixed(1)}×`;
    applyFilters();
  };
  scale.addEventListener('input', applyScale);
  // the size slider is a display control, not navigation — it does not exit
  applyScale();

  const input = $<HTMLInputElement>('search');
  void input;
  input.addEventListener('input', () => {
    if (input.value.trim()) leaveFlowIfRunning();
    state.query = input.value.trim();
    renderResults();
    applyFilters();
    pushRoute(true);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const first = $('results').querySelector<HTMLElement>('.hit');
      first?.click();
    }
    if (ev.key === 'Escape') { input.value = ''; state.query = ''; renderResults(); applyFilters(); }
  });
}


/**
 * Search has to do more than dim non-matches — a match you cannot reach is not
 * found. Results are listed, and picking one flies the camera to it.
 */
function searchHits(): GraphNode[] {
  if (!state.query) return [];
  const q = state.query.toLowerCase();
  return graph.nodes
    .filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q) || (n.repo ?? '').toLowerCase().includes(q))
    .sort((a, b) => {
      const ax = a.label.toLowerCase().startsWith(q) ? 0 : 1;
      const bx = b.label.toLowerCase().startsWith(q) ? 0 : 1;
      return ax - bx || (b.degree ?? 0) - (a.degree ?? 0);
    })
    .slice(0, 8);
}

function renderResults(): void {
  const box = $('results');
  const hits = searchHits();
  if (!state.query) { box.classList.remove('show'); box.innerHTML = ''; return; }
  box.classList.add('show');
  if (!hits.length) { box.innerHTML = '<div class="none">nothing matches</div>'; return; }
  box.innerHTML = hits
    .map((n) => `<button type="button" class="hit" data-go="${esc(n.id)}" style="color:${nodeColor(n)}">
      <span class="nm">${esc(n.label)}</span><span class="kd">${esc(KIND_LABEL[n.kind] ?? n.kind)}</span></button>`)
    .join('');
  for (const el of box.querySelectorAll<HTMLElement>('[data-go]')) {
    el.addEventListener('click', () => revealNode(el.dataset.go!));
  }
}

/** Make a node visible whatever the filters say, then travel to it. */
function revealNode(id: string): void {
  const n = byId.get(id);
  if (!n) return;
  if (state.flow) exitFlow();
  if (!state.planes.has(n.plane)) { state.planes.add(n.plane); syncToggleRows(); }
  if (state.status === 'live' && !['active', 'maintenance'].includes(n.status)) {
    state.status = 'all';
    for (const b of $('status').querySelectorAll('button')) b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.s === 'all'));
  }
  if (state.visibility !== 'all' && ((state.visibility === 'public') !== (n.visibility === 'public'))) {
    state.visibility = 'all';
    for (const b of $('visibility').querySelectorAll('button')) b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.v === 'all'));
  }
  applyFilters();
  openNode(id);
  flyToNode(n);
}

// -- inspector ---------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);


/**
 * The atlas is written for machines: dense, full of versions, paths and
 * parentheticals. Split on sentence ends only — a period between digits is a
 * version number (`3.5.8`), not the end of a thought.
 */
function firstSentences(text: string, count: number): string {
  const parts: string[] = [];
  let depth = 0;
  let tick = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    cur += ch;
    if (ch === '`') tick = !tick;
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (tick || depth > 0) continue;
    if (ch === '.' || ch === '!' || ch === '?') {
      const prev = text[i - 1] ?? '';
      const next = text[i + 1] ?? ' ';
      const after = text[i + 2] ?? '';
      // not a decimal, and genuinely followed by a new sentence
      if (/\d/.test(prev) && /\d/.test(next)) continue;
      if (!/\s/.test(next)) continue;
      if (after && !/[A-Z"'`(]/.test(after)) continue;
      parts.push(cur.trim());
      cur = '';
      if (parts.length >= count) break;
    }
  }
  if (parts.length < count && cur.trim()) parts.push(cur.trim());
  return parts.join(' ').trim();
}

/** Render the atlas's inline code spans rather than showing raw backticks. */
function withCode(text: string): string {
  return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Long deploy strings and paths need to wrap without breaking the layout. */
/** A detail row whose value is a link out. Advisory ids are useless without one. */
function linkRow(label: string, href: string, text: string): string {
  return `<div class="drow"><span class="dk">${esc(label)}</span><span class="dv"><a class="out" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)} ↗</a></span></div>`;
}

function detailRow(label: string, value: string, mono = false): string {
  return `<div class="drow"><span class="dk">${esc(label)}</span><span class="dv${mono ? ' m' : ''}">${esc(value)}</span></div>`;
}

function openNode(id: string): void {
  const n = byId.get(id);
  if (!n) return;
  state.selected = { type: 'node', id };

  $('ins-kind').innerHTML =
    `<span style="color:${nodeColor(n)}">●</span> ${KIND_LABEL[n.kind] ?? n.kind}` +
    (n.repo && n.repo !== n.id ? ` · ${esc(n.repo)}` : '') +
    (n.visibility === 'public'
      ? ' · <span class="pill ok">open source</span>'
      : n.visibility === 'n/a'
        ? ''
        : ' · <span class="pill mute">internal</span>');
  $('ins-name').textContent = n.label;

  // Lead with what the thing is, in one sentence, before any detail.
  const lead = n.role || (n.tldr ? firstSentences(n.tldr, 2) : '');
  const rest = n.tldr && !n.role ? n.tldr.slice(firstSentences(n.tldr, 2).length).trim() : n.tldr ?? '';

  const chips = [n.language, n.type, n.status].filter(Boolean) as string[];

  // Group connections by kind, so you can scan "what calls this" separately
  // from "what it stores" rather than reading one undifferentiated list.
  const edges = (adjacency.get(id) ?? []).filter((e) => state.layers.has(e.layer));
  const groups = (Object.keys(LAYER_LABEL) as Layer[])
    .map((layer) => ({ layer, list: edges.filter((e) => e.layer === layer) }))
    .filter((g) => g.list.length);

  const groupHtml = groups
    .map(
      (g) => `<div class="lgroup">
        <div class="lhead" style="color:${LAYER_COLOR[g.layer]}"><span class="ldot"></span>${LAYER_LABEL[g.layer]}<span class="lct">${g.list.length}</span></div>
        ${g.list
          .map((e) => {
            const out = e.source === id;
            const other = byId.get(out ? e.target : e.source);
            return `<button type="button" class="conn" data-edge="${esc(e.id)}">
              <span class="dir" style="color:${LAYER_COLOR[g.layer]}">${out ? '→' : '←'}</span>
              <span class="peer">${esc(other?.label ?? '?')}</span>
              <span class="how">${esc(e.label)}</span>
              ${e.unverified ? '<span class="pill warn">?</span>' : ''}
            </button>`;
          })
          .join('')}
      </div>`,
    )
    .join('');

  const details = [
    n.repo ? detailRow('Repo', `${CONFIG.org.github}/${n.repo}`, true) : '',
    n.siblings?.length ? detailRow('Also ships', n.siblings.join(', ')) : '',
    n.deploy ? detailRow('Deploy', n.deploy, true) : '',
    n.doc ? detailRow('Atlas doc', n.doc, true) : '',
  ].join('');

  const carried = advisoriesOn(n);
  const advisoryHtml = carried.length
    ? `<div class="sec"><h3>Advisories<span class="lct">${carried.length}</span></h3>` +
      advisoryCards(carried) +
      `<p class="quiet">Known as of ${esc((graph.advisoriesAsOf ?? '').slice(0, 10))}. ${
        state.severities.size < 5 ? 'Filtered by the severity you have switched on.' : ''
      }</p></div>`
    : '';

  $('body').innerHTML = `
    ${lead ? `<p class="lead">${withCode(lead)}</p>` : ''}
    ${chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
    ${advisoryHtml}
    ${groupHtml ? `<div class="sec"><h3>How it connects</h3>${groupHtml}</div>` : '<div class="sec"><h3>How it connects</h3><p class="quiet">No connections on the layers you have switched on.</p></div>'}
    ${rest ? `<div class="sec"><h3>From the atlas</h3><p class="prose clamp" id="tldr">${withCode(rest)}</p><button type="button" class="more" id="moretog">Read more</button></div>` : ''}
    ${details ? `<div class="sec"><h3>Details</h3>${details}</div>` : ''}
  `;
  const tog = document.getElementById('moretog');
  tog?.addEventListener('click', () => {
    const p = document.getElementById('tldr')!;
    const open = p.classList.toggle('open');
    tog.textContent = open ? 'Show less' : 'Read more';
  });
  wireInspectorLinks();
  $('inspector').classList.add('open');
  applyFilters();
  pushRoute();
}

/** "the 8 most distinctive of 41" — silent when the list is already complete. */
function sharedNote(e: GraphEdge): string {
  // The advisory list is complete, so it has nothing to apologise for.
  if (e.layer === 'advisory') return '';
  const total = e.sharedTotal ?? 0;
  if (!e.shared || e.shared.length >= total) return '';
  return `<p class="quiet">The ${e.shared.length} most distinctive of ${total} shared packages.</p>`;
}

/**
 * One advisory, as a card: severity, affected package, what it is, where it is
 * fixed, and a link out. Written for the node inspector and reused verbatim for
 * the shared-advisory edge — the same thing described twice would drift, and a
 * bare id is not something anyone can act on either way.
 */
function advisoryCards(list: AdvisoryRecord[]): string {
  return list
    .map(
      (a) => `<div class="adv">
        <div class="advhead">
          <span class="pill sev-${esc(a.severity)}">${esc(a.severity)}${a.score ? ` ${a.score}` : ''}</span>
          <span class="advpkg">${esc(a.package)}</span>
        </div>
        ${a.summary ? `<p class="advsum">${esc(a.summary)}</p>` : ''}
        <div class="advfoot">
          ${a.fixedIn?.length ? `<span class="advfix">fixed in ${esc(a.fixedIn.join(', '))}</span>` : '<span class="advfix quiet">no fixed version stated</span>'}
          ${a.url ? `<a class="out" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.id)} ↗</a>` : `<span class="quiet">${esc(a.id)}</span>`}
        </div>
      </div>`,
    )
    .join('');
}

/**
 * What two components have in common, as a list that scrolls rather than
 * truncates.
 *
 * Advisories are worked out here rather than carried on the edge. Both nodes
 * already list their own, so intersecting them costs nothing and gives the
 * WHOLE answer — where a baked list had to be capped, and 71 capped lists cost
 * more to download than the complete one costs to compute.
 */
function sharedList(e: GraphEdge): string {
  if (e.layer === 'advisory') {
    const cards = sharedAdvisories(e);
    if (cards.length) return `<div class="sharedlist">${advisoryCards(cards)}</div>`;
  }
  if (!e.shared?.length) return '';
  return `<div class="sharedlist">${e.shared.map((s) => `<div class="shared">${esc(s)}</div>`).join('')}</div>`;
}

/** Every advisory both ends of this hop carry, worst first. */
function sharedAdvisories(e: GraphEdge): AdvisoryRecord[] {
  const a = byId.get(e.source)?.advisoryIds;
  const b = byId.get(e.target)?.advisoryIds;
  if (!a?.length || !b?.length) return [];
  const other = new Set(b);
  return a
    .filter((id) => other.has(id))
    .map((id) => graph.advisories?.[id])
    .filter((x): x is AdvisoryRecord => !!x);
}

function openEdge(id: string): void {
  const e = graph.edges.find((x) => x.id === id);
  if (!e) return;
  state.selected = { type: 'edge', id };
  const from = byId.get(e.source);
  const to = byId.get(e.target);

  $('ins-kind').innerHTML = `<span style="color:${LAYER_COLOR[e.layer]}">━</span> ${LAYER_LABEL[e.layer]}`;
  $('ins-name').textContent = e.label;
  $('body').innerHTML = `
    <p class="lead">${esc(e.detail || `${from?.label ?? e.source} ${LAYER_VERB[e.layer]} ${to?.label ?? e.target}.`)}</p>
    <div class="sec">
      <h3>The hop</h3>
      <button type="button" class="conn big" data-node="${esc(e.source)}">
        <span class="dir" style="color:${nodeColor(from!)}">●</span>
        <span class="peer">${esc(from?.label ?? e.source)}</span>
        <span class="how">${esc(KIND_LABEL[from?.kind ?? ''] ?? '')}</span>
      </button>
      <div class="hoparrow" style="color:${LAYER_COLOR[e.layer]}">↓ ${esc(LAYER_VERB[e.layer])} · ${esc(e.label)}</div>
      <button type="button" class="conn big" data-node="${esc(e.target)}">
        <span class="dir" style="color:${nodeColor(to!)}">●</span>
        <span class="peer">${esc(to?.label ?? e.target)}</span>
        <span class="how">${esc(KIND_LABEL[to?.kind ?? ''] ?? '')}</span>
      </button>
    </div>
    ${e.unverified ? '<div class="sec"><p class="quiet"><span class="pill warn">unverified</span> The atlas records this relationship but does not confirm it.</p></div>' : ''}
    ${e.derived ? '<div class="sec"><p class="quiet"><span class="pill derived">derived</span> Measured from what each component contains, not read from a document.</p></div>' : ''}
    ${e.shared?.length || e.layer === 'advisory' ? `<div class="sec"><h3>What they share</h3>${sharedList(e)}${sharedNote(e)}</div>` : ''}
    ${e.anchor ? `<div class="sec"><h3>Where this comes from</h3>${detailRow('Source', e.anchor, true)}</div>` : ''}
  `;
  wireInspectorLinks();
  $('inspector').classList.add('open');
  applyFilters();
  pushRoute();
}

function wireInspectorLinks(): void {
  for (const el of $('body').querySelectorAll<HTMLElement>('[data-node]')) {
    el.addEventListener('click', () => openNode(el.dataset.node!));
  }
  for (const el of $('body').querySelectorAll<HTMLElement>('[data-edge]')) {
    el.addEventListener('click', () => openEdge(el.dataset.edge!));
  }
}

function closeInspector(): void {
  state.selected = null;
  $('inspector').classList.remove('open');
  applyFilters();
  pushRoute();
}
$('close').addEventListener('click', closeInspector);

// -- flow player -------------------------------------------------------------

function buildFlowList(): void {
  const box = $('flowlist');
  for (const [i, flow] of graph.flows.entries()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'flowrow';
    row.dataset.flow = flow.id;
    row.style.color = PLANE_COLOR[flow.plane] ?? '#9FB2C1';
    row.innerHTML = `<span class="idx">${i + 1}</span><span class="nm">${esc(flow.name)}</span><span class="stop">stop</span>`;
    // Clicking the running flow is the most obvious way back out.
    row.addEventListener('click', () => {
      if (state.flow?.flow.id === flow.id) exitFlow();
      else startFlow(flow);
    });
    box.appendChild(row);
  }
  if (!graph.flows.length) box.innerHTML = '<div style="color:var(--ink-faint);font-size:11px">none generated</div>';
}


/** One place that always says whether a flow is running, and how to leave it. */
function syncMode(): void {
  const mode = $('mode');
  const flowing = state.flow !== null;
  mode.classList.toggle('flowing', flowing);
  $('modetag').textContent = flowing ? `Flow · ${state.flow!.flow.name}` : 'Exploring';
  for (const el of $('flowlist').querySelectorAll<HTMLElement>('[data-flow]')) {
    el.classList.toggle('active', state.flow?.flow.id === el.dataset.flow);
  }
}


// The journey plays itself until you take over, so the first thing a newcomer
// sees is the system working rather than a static frame they must decode.
let autoTimer: number | undefined;

function stopAuto(): void {
  if (autoTimer !== undefined) clearInterval(autoTimer);
  autoTimer = undefined;
  $('playpause').textContent = 'Play';
  $('player').classList.remove('playing');
}

function startAuto(): void {
  stopAuto();
  $('playpause').textContent = 'Pause';
  $('player').classList.add('playing');
  autoTimer = setInterval(() => {
    if (!state.flow) return stopAuto();
    if (state.flow.step >= state.flow.flow.steps.length - 1) return stopAuto();
    gotoStep(state.flow.step + 1, true);
  }, 4200) as unknown as number;
}

function startFlow(flow: Flow): void {
  // Whatever was selected before is not part of this story, and its panel would
  // sit over the graph we are about to frame.
  state.selected = null;
  $('inspector').classList.remove('open');
  state.flow = { flow, step: 0 };
  $('player').classList.add('show');
  $('hint').style.display = 'none'; // hint hidden with player
  syncMode();
  $('flowname').textContent = flow.name;
  $('flowsum').textContent = flow.summary;
  const track = $('track');
  track.innerHTML = '';
  flow.steps.forEach((_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Step ${i + 1}`);
    b.addEventListener('click', () => gotoStep(i));
    track.appendChild(b);
  });
  gotoStep(0, true);
  startAuto();
}

/**
 * Fit the camera to a set of nodes: their centroid, and the true radius needed
 * to contain them.
 *
 * Not half the bounding box diagonal — that circumscribes the box rather than
 * the points, and on a journey spanning two planes it pushed the camera far
 * enough back that the hop being narrated was a few pixels wide.
 */
function frameNodes(ids: Set<string>, minRadius: number): void {
  if (state.mode === '2d') {
    const vp = visibleViewport();
    view2.frameIds(ids, { left: vp.left, right: vp.right, bottom: vp.bottom });
    return;
  }
  const pts = view.nodes.filter((n) => ids.has(n.id) && n.x !== undefined);
  if (!pts.length) return;
  const center = new Vector3(
    pts.reduce((s, n) => s + n.x!, 0) / pts.length,
    pts.reduce((s, n) => s + n.y!, 0) / pts.length,
    pts.reduce((s, n) => s + n.z!, 0) / pts.length,
  );
  const radius = pts.reduce(
    (m, n) => Math.max(m, Math.hypot(n.x! - center.x, n.y! - center.y, n.z! - center.z)),
    0,
  );
  // A little air around the outermost node, and never so tight that a two-node
  // hop fills the screen.
  frameSphere(center, Math.max(minRadius, radius * 1.18));
}

/**
 * Fit the camera to the hop being narrated, plus the step either side of it.
 *
 * Not the whole journey. These flows cross four or five planes on purpose, and
 * the corpus journey spans a radius of 1100 in a graph whose entire radius is
 * 695 — fitting that puts the camera far enough out that the hop being
 * described is a few pixels wide. One step of context in each direction shows
 * where this came from and where it goes next, which is what the narration is
 * actually about.
 */
function frameFlow(): void {
  if (!state.flow) return;
  const { flow, step } = state.flow;
  const window = flow.steps.slice(Math.max(0, step - 1), step + 2);
  frameNodes(new Set(window.flatMap((s) => [s.from, s.to])), 380);
}

function gotoStep(i: number, automatic = false): void {
  if (!automatic) stopAuto();
  if (!state.flow) return;
  const { flow } = state.flow;
  state.flow.step = Math.max(0, Math.min(flow.steps.length - 1, i));
  const s = flow.steps[state.flow.step];

  for (const [j, b] of [...$('track').children].entries()) {
    b.className = j < state.flow.step ? 'done' : j === state.flow.step ? 'now' : '';
  }
  $('stepnum').textContent = `Step ${state.flow.step + 1} of ${flow.steps.length}`;
  const from = byId.get(s.from);
  const to = byId.get(s.to);
  $('stephop').innerHTML =
    `<strong>${esc(s.title)}</strong><br>` +
    `<span style="color:${nodeColor(from!)}">${esc(from?.label ?? s.from)}</span>` +
    `<span class="arrow">→</span>` +
    `<span style="color:${nodeColor(to!)}">${esc(to?.label ?? s.to)}</span>`;
  $('stepwhy').textContent = s.detail;
  pushRoute(true);

  // Ease onto the hop being described, and re-fit rather than keeping whatever
  // distance the camera happened to be at. Holding the distance meant a journey
  // framed wide at step one stayed wide for every step inside it.
  if (from?.x !== undefined && to?.x !== undefined) frameFlow();
  applyFilters();
}

function exitFlow(): void {
  stopAuto();
  state.flow = null;
  $('player').classList.remove('show');
  syncMode();
  applyFilters();
  pushRoute();
}
$('next').addEventListener('click', () => state.flow && gotoStep(state.flow.step + 1));
$('prev').addEventListener('click', () => state.flow && gotoStep(state.flow.step - 1));
$('exit').addEventListener('click', exitFlow);
$('playpause').addEventListener('click', () => {
  if (autoTimer !== undefined) stopAuto();
  else if (state.flow) {
    if (state.flow.step >= state.flow.flow.steps.length - 1) gotoStep(0, true);
    startAuto();
  }
});
$('modeexit').addEventListener('click', exitFlow);

// -- camera easing -----------------------------------------------------------

const camUp = new Vector3();
const arcLayer = $<HTMLCanvasElement>('fieldlabels');
const arcCtx = arcLayer.getContext('2d')!;
/**
 * Which shells were named on the previous frame, and in which form.
 *
 * Every threshold here — is the shell big enough, does the name fit the arc,
 * does it collide with another — is a yes/no answer to a continuous quantity,
 * and a camera move walks those quantities right along the boundary. Without
 * hysteresis a label near any threshold flickers on and off every frame, which
 * is what made them twitchy under rotation and zoom. Once a shell has its name
 * it keeps it until the case against is clear, and vice versa.
 */
const namedLast = new Map<string, string>();
/** Gap between a box border and the name sitting inside it, in pixels. */
const LABEL_PAD = 9;

/**
 * How wide a label will actually be drawn, in pixels.
 *
 * The collision passes used to multiply the character count by a constant,
 * which is exactly right for a monospace face and wrong for the proportional
 * one the map labels now use: "MMM" and "iii" are the same string length and
 * nowhere near the same width. Overestimating drops labels that would have fit,
 * underestimating stacks ones that overlap, and both were happening.
 *
 * Measured once per distinct string and cached — there are a few hundred names
 * and they do not change, so this is a few hundred measurements for the life of
 * the page rather than a text metric per label per frame.
 */
const textWidths = new Map<string, number>();
const textCtx = document.createElement('canvas').getContext('2d')!;
function labelWidth(text: string, font: string): number {
  const key = `${font}|${text}`;
  let px = textWidths.get(key);
  if (px === undefined) {
    textCtx.font = font;
    px = textCtx.measureText(text).width;
    textWidths.set(key, px);
  }
  return px;
}
/** Must track .label and .boxlabel in the stylesheet. */
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const NODE_FONT = `450 11.5px ${SANS}`;
const GROUP_FONT = `600 9.5px ${SANS}`;
/**
 * The shell names are their own size, not the box labels'.
 *
 * A name written around a sphere is a caption on a REGION, and it is competing
 * with the whole map rather than with the box it sits in — so it goes bigger and
 * much fainter, and drops the dark outline the flat labels need. It reads as
 * something printed on the surface instead of a tag stuck over it.
 */
const SHELL_FONT = `600 15px ${SANS}`;
/** Tracking is a per-character add-on that measureText does not know about. */
const NODE_TRACK = 11.5 * 0.018;
const GROUP_TRACK = 9.5 * 0.16;
const SHELL_TRACK = 15 * 0.18;
let flyFrom: Vector3 | null = null;
let flyGoal: Vector3 | null = null;
let eyeFrom: Vector3 | null = null;
let eyeGoal: Vector3 | null = null;
let flyT = 1;

function flyTo(target: Vector3, eye?: Vector3): void {
  flyFrom = view.controls.target.clone();
  flyGoal = target;
  eyeFrom = eye ? view.camera.position.clone() : null;
  eyeGoal = eye ?? null;
  flyT = 0;
}

/** Frame a single node closely enough to read its neighbourhood. */
function flyToNode(n: GraphNode): void {
  if (state.mode === '2d') {
    view2.focusNode(n);
    return;
  }
  if (n.x === undefined) return;
  const target = new Vector3(n.x, n.y!, n.z!);
  const dir = view.camera.position.clone().sub(view.controls.target).normalize();
  flyTo(target, target.clone().add(dir.multiplyScalar(360)));
}



/** The part of the canvas that is not covered by chrome. */
function visibleViewport(): { left: number; right: number; bottom: number; w: number; h: number } {
  const wide = innerWidth > 900;
  const left = wide ? $('rail').getBoundingClientRect().right + 14 : 0;
  const insp = $('inspector');
  const right = wide && insp.classList.contains('open') ? innerWidth - insp.getBoundingClientRect().left + 14 : 0;
  const player = $('player');
  const bottom = player.classList.contains('show') ? innerHeight - player.getBoundingClientRect().top + 14 : 0;
  return { left, right, bottom, w: Math.max(200, innerWidth - left - right), h: Math.max(200, innerHeight - bottom) };
}

/**
 * Frame a bounding sphere into the *visible* strip: pull back enough that it
 * fits the narrower area, then slide the camera so the content sits in the gap
 * between the panels rather than behind one of them.
 */
function frameSphere(center: Vector3, radius: number): void {
  const vp = visibleViewport();
  const fov = (view.camera.fov * Math.PI) / 180;

  // Fit against whichever axis is tighter once the chrome is accounted for.
  const fitH = radius / Math.sin(fov / 2);
  const fitW = fitH * (innerWidth / innerHeight) / Math.max(0.2, vp.w / vp.h);
  const dist = Math.max(fitH, fitW) * 0.95 * (innerHeight / Math.max(200, vp.h));

  const dir = view.camera.position.clone().sub(view.controls.target);
  if (dir.lengthSq() < 1) dir.set(0.25, 0.35, 1);
  dir.normalize();

  // Screen-space offset of the visible centre from the canvas centre, converted
  // into world units at the target plane.
  const dx = (vp.left + vp.w / 2) - innerWidth / 2;
  const dy = vp.h / 2 - innerHeight / 2;
  const worldPerPx = (2 * dist * Math.tan(fov / 2)) / innerHeight;

  const right = new Vector3().crossVectors(dir, view.camera.up).normalize();
  const up = new Vector3().crossVectors(right, dir).normalize();

  // Moving the camera's TARGET moves content the opposite way on screen, so
  // both terms want the negative of the wanted screen offset — but only one of
  // them looks negative here. `dir` runs from the target TO the camera, so
  // `cross(dir, up)` already points screen-LEFT: the horizontal term carries its
  // sign flip in the basis and reads as +dx. `up` has no such inversion, and its
  // term was the one genuinely backwards, framing content down behind the
  // player instead of up above it.
  const offset = right
    .clone()
    .multiplyScalar(dx * worldPerPx)
    .add(up.clone().multiplyScalar(dy * worldPerPx));
  const shifted = center.clone().add(offset);

  // The offset exists to dodge the chrome, so the starfield must not read it as
  // the camera having gone anywhere.
  view.setDriftOffset(offset.x, offset.y);
  flyTo(shifted, shifted.clone().add(dir.multiplyScalar(dist)));
}

/** Fit the camera to the nodes currently on screen, so a preset lands framed. */
function frameVisible(): void {
  if (state.mode === '2d') {
    const vp = visibleViewport();
    view2.frameIds(visibleNodeIds, { left: vp.left, right: vp.right, bottom: vp.bottom });
    return;
  }
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  for (const node of view.nodes) {
    if (!visibleNodeIds.has(node.id)) continue;
    xs.push(node.x!); ys.push(node.y!); zs.push(node.z!);
  }
  if (!xs.length) return;
  // Percentile bounds, not absolute: a few far-flung boxes must not shrink the
  // cluster everyone actually came to look at.
  const span = (arr: number[]): [number, number] => {
    const a = [...arr].sort((p, q) => p - q);
    const lo = a[Math.floor(a.length * 0.04)];
    const hi = a[Math.ceil(a.length * 0.96) - 1];
    return [lo, hi];
  };
  const [minX, maxX] = span(xs);
  const [minY, maxY] = span(ys);
  const [minZ, maxZ] = span(zs);
  frameSphere(
    new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
    Math.max(140, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2),
  );
}


/** A world point in the flat view, projected to canvas pixels. */
function worldToScreen(x: number, y: number, w: number, h: number): { x: number; y: number } {
  projected.set(x, y, 1).project(view2.camera);
  return { x: (projected.x * 0.5 + 0.5) * w, y: (-projected.y * 0.5 + 0.5) * h };
}

/** Perpendicular distance from a point to a 2D line segment, in pixels. */
function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}


// -- labels, hover, picking --------------------------------------------------

const labelLayer = $('labels');
const pool: HTMLDivElement[] = [];
const projected = new Vector3();
let hovered: GraphNode | null = null;
let hoveredEdge: GraphEdge | null = null;
const screenPos = new Map<string, { x: number; y: number }>();
const edgeTip = document.createElement('div');
edgeTip.className = 'edgetip';
edgeTip.style.display = 'none';
labelLayer.appendChild(edgeTip);
let pointer = { x: -1e6, y: -1e6 };

let hoverKey = '';
/** Held shift turns the pointer into a crosshair, so the gesture is visible before it is used. */
let shiftHeld = false;
addEventListener('keydown', (ev) => { if (ev.key === 'Shift') shiftHeld = true; });
addEventListener('keyup', (ev) => { if (ev.key === 'Shift') shiftHeld = false; });
addEventListener('blur', () => { shiftHeld = false; });
let pointerMoved = true;
let cameraMoved = true;
for (const el of [canvas, canvas2]) {
  el.addEventListener('pointermove', (ev) => {
    pointer = { x: ev.clientX, y: ev.clientY };
    pointerMoved = true;
  });
  el.addEventListener('pointerleave', () => {
    pointer = { x: -1e6, y: -1e6 };
    pointerMoved = true;
  });
  el.addEventListener('click', (ev) => {
    // Shift is what keeps this out of the way: plain click still inspects, and
    // left-drag still orbits, so the gesture costs the map nothing.
    // Shift drops one out of the sky at what you point at; adding alt launches
    // it from where you are standing instead. Alt on its own does the same, so
    // either mental model finds it.
    if ((ev.shiftKey || ev.altKey) && state.mode === '3d') {
      view.strike(ev.clientX, ev.clientY, ev.altKey);
      return;
    }
    if (hovered) openNode(hovered.id);
    else if (hoveredEdge) openEdge(hoveredEdge.id);
    else closeInspector();
  });
}

// Pan and zoom for the flat view. Labels re-project on the next frame anyway;
// the callback only has to mark the camera as having moved.
view2.attachControls(canvas2, () => {
  pointerMoved = true;
});

function resize(): void {
  const w = innerWidth;
  const h = innerHeight;
  const dpr = Math.min(devicePixelRatio, 2);
  view.renderer.setSize(w, h, false);
  view.camera.aspect = w / h;
  view.camera.updateProjectionMatrix();
  view.setViewportScale(h);
  view.setEdgeWidth(2.4);
  view.setResolution(w * dpr, h * dpr);

  view2.renderer.setSize(w, h, false);
  view2.setAspect(w, h);
  // The same weight as the 3D view's connectors. Routing them into corridors
  // is what keeps them legible here; thinning them was the wrong lever.
  view2.setEdgeWidth(2.4);
  view2.setResolution(w * dpr, h * dpr);
}
addEventListener('resize', resize);

const clock = { last: performance.now() };
let lastCamKey = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - clock.last) / 1000);
  clock.last = now;

  const flat = state.mode === '2d';
  if (flat) {
    view2.tick(dt * 1000);
    const camKey = view2.camera.left + view2.camera.top;
    cameraMoved = Math.abs(camKey - lastCamKey) > 0.01;
    lastCamKey = camKey;
  } else {
    if (flyGoal && flyFrom && flyT < 1) {
      flyT = Math.min(1, flyT + dt * 1.6);
      const k = 1 - Math.pow(1 - flyT, 3);
      view.controls.target.lerpVectors(flyFrom, flyGoal, k);
      if (eyeFrom && eyeGoal) view.camera.position.lerpVectors(eyeFrom, eyeGoal, k);
    }
    const camKey = view.camera.position.x + view.camera.position.y + view.camera.position.z;
    cameraMoved = Math.abs(camKey - lastCamKey) > 0.01;
    lastCamKey = camKey;
    view.controls.update();
  }
  const activeCamera = flat ? view2.camera : view.camera;
  const pxPerWorld = flat ? view2.pxPerWorld() : 1;

  // Project every node once: labels, hover and pulses all read from this pass.
  const w = innerWidth;
  const h = innerHeight;
  const candidates: Array<{ n: GraphNode; x: number; y: number; d: number }> = [];
  screenPos.clear();
  let best: { n: GraphNode; x: number; y: number; d2: number } | null = null;

  for (const n of view.nodes) {
    if (!visibleNodeIds.has(n.id)) continue;
    const world = nodePos(n);
    projected.copy(world).project(activeCamera);
    if (projected.z > 1) continue;
    const sx = (projected.x * 0.5 + 0.5) * w;
    const sy = (-projected.y * 0.5 + 0.5) * h;
    if (sx < -80 || sx > w + 80 || sy < -40 || sy > h + 40) continue;
    // In 2D nothing is nearer than anything else, so label priority falls back
    // to distance from the centre of the screen — what you are looking at.
    const dist = flat
      ? Math.hypot(sx - w / 2, sy - h / 2)
      : view.camera.position.distanceTo(world);
    candidates.push({ n, x: sx, y: sy, d: dist });
    screenPos.set(n.id, { x: sx, y: sy });

    const dx = sx - pointer.x;
    const dy = sy - pointer.y;
    const d2 = dx * dx + dy * dy;
    // The node's target tracks how big it is actually DRAWN. A fixed radius
    // meant that zoomed out, where a node is a couple of pixels across, it
    // still claimed 26 and swallowed every line passing near it — and a hovered
    // node suppresses the connection test entirely, so those lines could not be
    // pointed at however carefully you aimed.
    const pick = flat ? Math.min(26, Math.max(9, (nodeSizeById.get(n.id) ?? 12) * pxPerWorld * 0.5 + 5)) : 26;
    if (d2 < pick * pick && (!best || d2 < best.d2)) best = { n, x: sx, y: sy, d2 };
  }

  hovered = best?.n ?? null;

  // Connections are clickable too, so hit-test the visible segments whenever
  // the cursor is not already over a node.
  if (pointerMoved || cameraMoved) {
    hoveredEdge = null;
    pointerMoved = false;
    if (!hovered && pointer.x > -1e5) {
      let bestD = 9;
      for (const e of visibleEdges) {
        // Test the polyline the edge is actually DRAWN as. Approximating it by
        // two segments through its midpoint was close enough for a single
        // curve, but an orthogonal route is an L or a Z: its midpoint can sit
        // nowhere near the chord, so the pointer matched a line it was not over
        // and missed the one it was.
        //
        // Deliberately NOT gated on both endpoints being on screen. That gate
        // is what made hovering zoom-dependent: `screenPos` only holds nodes
        // that survived viewport culling, so zooming in far enough that an end
        // left the viewport killed the whole connection — including the long
        // middle of it crossing the view.
        let d = Infinity;
        const path = flat ? view2.pathOf(e) : null;
        if (!flat) {
          // Bundled edges bow away from the chord between their ends, so the
          // two-endpoint test would match a line the pointer is nowhere near
          // and miss the one it is over. Same reasoning as the flat view.
          //
          // Deliberately NOT gated on both ends being on screen: that gate is
          // what made hovering zoom-dependent. A point behind the camera
          // projects to nonsense, and skipping only that point still leaves
          // the rest of the curve pointable.
          const p3 = view.pathOf(e);
          if (!p3) continue;
          let ax = 0;
          let ay = 0;
          let have = false;
          for (let k = 0; k < p3.length; k++) {
            projected.copy(p3[k]).project(view.camera);
            if (projected.z > 1) {
              have = false;
              continue;
            }
            const bx = (projected.x * 0.5 + 0.5) * w;
            const by = (-projected.y * 0.5 + 0.5) * h;
            if (have) d = Math.min(d, pointSegmentDistance(pointer.x, pointer.y, ax, ay, bx, by));
            ax = bx;
            ay = by;
            have = true;
          }
        } else if (path && path.length > 1) {
          // Projected in place rather than through a helper: this runs over
          // every visible edge on every pointer move, and an object per point
          // would be thousands of allocations a second for nothing.
          projected.set(path[0][0], path[0][1], 1).project(view2.camera);
          let ax = (projected.x * 0.5 + 0.5) * w;
          let ay = (-projected.y * 0.5 + 0.5) * h;
          for (let k = 1; k < path.length; k++) {
            projected.set(path[k][0], path[k][1], 1).project(view2.camera);
            const bx = (projected.x * 0.5 + 0.5) * w;
            const by = (-projected.y * 0.5 + 0.5) * h;
            d = Math.min(d, pointSegmentDistance(pointer.x, pointer.y, ax, ay, bx, by));
            ax = bx;
            ay = by;
          }
        }
        if (d < bestD) {
          bestD = d;
          hoveredEdge = e;
        }
      }
    }
  }

  // Repaint only when what the pointer is over actually changes: applyFilters
  // walks every node and edge, and running it on every frame the pointer moves
  // would cost far more than it buys. A node wins over an edge under it — the
  // node is the smaller, more deliberate target.
  // Not gated to the flat view. The focus machinery is shared, and a dense 3D
  // map wants "what is this wired to" at least as much as a flat one does; it
  // was only ever 2D because that is where it was built.
  const want =
    !state.selected && !state.flow
      ? hovered
        ? ({ type: 'node' as const, id: hovered.id })
        : hoveredEdge
          ? ({ type: 'edge' as const, id: hoveredEdge.id })
          : null
      : null;
  const wantKey = want ? `${want.type}:${want.id}` : '';
  if (wantKey !== hoverKey) {
    hoverKey = wantKey;
    state.hover = want;
    applyFilters();
  }

  if (hoveredEdge) {
    const from = byId.get(hoveredEdge.source);
    const to = byId.get(hoveredEdge.target);
    edgeTip.textContent = `${from?.label ?? ''} → ${to?.label ?? ''} · ${hoveredEdge.label}`;
    edgeTip.style.color = LAYER_COLOR[hoveredEdge.layer];
    edgeTip.style.transform = `translate(${(pointer.x + 14).toFixed(0)}px, ${(pointer.y + 12).toFixed(0)}px)`;
    edgeTip.style.display = '';
  } else {
    edgeTip.style.display = 'none';
  }

  liveCanvas().style.cursor = shiftHeld && state.mode === '3d' ? 'crosshair' : hovered || hoveredEdge ? 'pointer' : 'grab';

  // Label the most important nodes on screen, not all of them.
  const inFlow = flowSets();
  // A delivery target is a destination and there are only a handful: it is
  // named before anything else competes for the space.
  candidates.sort((a, b) => {
    const pa = (inFlow.nodes.has(a.n.id) ? 1e6 : 0) + (a.n.kind === 'outlet' ? 1e5 : 0) + (a.n.degree ?? 0) * 60 - a.d;
    const pb = (inFlow.nodes.has(b.n.id) ? 1e6 : 0) + (b.n.kind === 'outlet' ? 1e5 : 0) + (b.n.degree ?? 0) * 60 - b.d;
    return pb - pa;
  });
  // Place labels greedily, skipping any that would collide with one already
  // placed. Overlapping text is worse than missing text.
  const placed: Array<[number, number, number, number]> = [];
  const budget = state.flow ? 30 : 34;
  const shortlist: Array<{ n: GraphNode; x: number; y: number }> = [];
  const hits = (b: [number, number, number, number]) =>
    placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);

  for (const c of candidates) {
    if (shortlist.length >= budget) break;
    const w = labelWidth(c.n.label, NODE_FONT) + c.n.label.length * NODE_TRACK + 12;
    // Inside a flow every participant is part of the narration, so it must be
    // named. Elsewhere a colliding label is better dropped than stacked.
    const must =
      c.n === hovered ||
      (state.flow ? inFlow.nodes.has(c.n.id) || inFlow.later.has(c.n.id) : inFlow.head.has(c.n.id));

    let dy = 0;
    let box: [number, number, number, number] = [c.x - w / 2, c.y - 24, c.x + w / 2, c.y - 8];
    if (hits(box)) {
      // Try nudging above and below before giving up on the label.
      const nudges = must ? [-16, 16, -32, 32, -48, 48] : [];
      let ok = false;
      for (const d of nudges) {
        const trial: [number, number, number, number] = [box[0], box[1] + d, box[2], box[3] + d];
        if (!hits(trial)) {
          box = trial;
          dy = d;
          ok = true;
          break;
        }
      }
      if (!ok && !must) continue;
    }
    placed.push(box);
    shortlist.push({ n: c.n, x: c.x, y: c.y + dy });
  }
  const cap = shortlist.length;

  for (let i = 0; i < cap; i++) {
    const { n, x, y } = shortlist[i];
    let el = pool[i];
    if (!el) {
      el = document.createElement('div');
      el.className = 'label';
      labelLayer.appendChild(el);
      pool[i] = el;
    }
    if (el.dataset.id !== n.id) {
      el.textContent = n.label;
      el.dataset.id = n.id;
    }
    const hot = n === hovered || inFlow.head.has(n.id) || (state.selected?.type === 'node' && state.selected.id === n.id);
    // Inside a flow no participant is dimmed — the current hop is highlighted
    // instead, so emphasis never costs readability.
    const faded = !hot && focusIds !== null && !focusIds.has(n.id);
    el.className = `label${hot ? ' hot' : ''}${faded ? ' dim' : ''}`;
    el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px,${(y - 16).toFixed(1)}px)`;
    el.style.display = '';
  }
  for (let i = cap; i < pool.length; i++) pool[i].style.display = 'none';

  // Pulses travel from source to target, which is how direction reads at a
  // glance. Each track carries a couple of dots at staggered offsets.
  if (pulseTracks.length) {
    const list: Array<{ pos: Vector3; color: string; strength: number }> = [];
    const focused = state.flow !== null || state.selected !== null;
    const perTrack = focused ? 5 : 3;
    // Seconds for a dot to travel a whole hop. Slower than it was: routing the
    // hops orthogonally made them noticeably longer without changing the time
    // allowed, so the dots quietly got faster to keep up.
    const period = focused ? 2.6 : 5.2;
    for (const { id, source, target, layer, weight } of pulseTracks) {
      const a = byId.get(source);
      const b = byId.get(target);
      if (a?.x === undefined || b?.x === undefined) continue;
      const from = nodePos(a);
      const to = nodePos(b);
      // Neither view draws a hop as a straight line any more — the flat one
      // routes it through corridors, the 3D one bundles it toward a channel —
      // so the dot has to travel the curve or it leaves the line it belongs to.
      const along = (t: number): Vector3 => {
        if (!flat) return view.curveAt(source, target, t) ?? from.clone().lerp(to, t);
        const p = view2.curveAt(id, source, target, t);
        return p ? new Vector3(p[0], p[1], 4) : from.clone().lerp(to, t);
      };
      // A network call is a round trip: the request goes out and a response
      // comes back. Queues, writes and delivery hops are genuinely one-way.
      const roundTrip = layer === 'network';
      for (let k = 0; k < perTrack; k++) {
        // A stable per-edge phase offset so pulses do not march in lockstep.
        // Must be a positive modulo: a negative t would place the dot outside
        // the segment and read as travelling the wrong way.
        const phase = (((a.x! * 0.37 + a.z! * 0.11) % 1) + 1) % 1;
        const tt = ((now / 1000 / period + k / perTrack + phase) % 1 + 1) % 1;
        // Stay bright for most of the trip rather than peaking only at the
        // midpoint, so the dot is legible the whole way along the edge.
        list.push({
          pos: along(tt),
          color: LAYER_COLOR[layer],
          strength: Math.pow(Math.sin(tt * Math.PI), 0.35) * weight,
        });
        if (roundTrip) {
          // A network call is a round trip. The response trails the request and
          // reads quieter, so you can still tell who initiated the call.
          const rt = (tt + 0.5) % 1;
          list.push({
            pos: along(1 - rt),
            color: LAYER_COLOR[layer],
            strength: Math.pow(Math.sin(rt * Math.PI), 0.35) * weight * 0.45,
          });
        }
      }
    }
    (flat ? view2 : view).setPulses(list);
  } else {
    (flat ? view2 : view).setPulses([]);
  }

  drawBoxLabels();

  if (flat) view2.render(now);
  else view.render(now);
  requestAnimationFrame(frame);
}


// -- routing -----------------------------------------------------------------
//
// Every navigable state lives in the URL so a view can be linked and reloaded.
// Routes are hierarchical path segments rather than query pairs:
//
//   #/view/storage                     a preset
//   #/view/storage/node/notes-db       a preset with something selected
//   #/custom/network,data/product      hand-tuned layers / planes
//   #/flow/customer-survey/4           a guided flow, paused on step 4
//   #/find/notes-api                   a search
//
// They are hash segments rather than real paths because this ships as one
// static file: a real path would 404 on reload anywhere it is hosted.

const LAYER_SLUG: Record<string, Layer> = {
  network: 'network', queue: 'queue', data: 'data', build: 'build', delivery: 'delivery',
  shared: 'shared-deps',
  advisory: 'advisory',
};
const layerToSlug = (l: Layer) => Object.keys(LAYER_SLUG).find((k) => LAYER_SLUG[k] === l) ?? l;
const PLANE_SLUG: Record<string, Plane> = Object.fromEntries(CONFIG.planes.map((p) => [p.slug, p.id]));
const planeToSlug = (p: Plane) => Object.keys(PLANE_SLUG).find((k) => PLANE_SLUG[k] === p) ?? p;

let applyingRoute = false;

function currentRoute(): string {
  const seg: string[] = [];
  if (state.flow) {
    seg.push('flow', state.flow.flow.id, String(state.flow.step + 1));
    // The dimension travels with a flow too, or reloading a flow link drops
    // whoever sent it back into the 3D map.
    if (state.mode === '2d') seg.push('flat');
    if (!state.shells) seg.push('bare');
    return '/' + seg.join('/');
  }
  if (activeView && VIEWS.some((v) => v.id === activeView && sameAsPreset(v))) {
    seg.push('view', activeView);
  } else {
    seg.push(
      'custom',
      [...state.layers].map(layerToSlug).sort().join(',') || 'none',
      [...state.planes].map(planeToSlug).sort().join(',') || 'none',
    );
  }
  if (state.mode === '2d') seg.push('flat');
  if (!state.shells) seg.push('bare');
  if (state.selected) seg.push(state.selected.type, state.selected.id);
  if (state.query) seg.push('find', state.query);
  return '/' + seg.map((s, i) => (i > 1 ? encodeURIComponent(s) : s)).join('/');
}

/** True when the live filters still match the preset they came from. */
function sameAsPreset(v: (typeof VIEWS)[number]): boolean {
  const eq = (a: Set<string>, b: string[]) => a.size === b.length && b.every((x) => a.has(x));
  return eq(state.layers as Set<string>, v.layers) && eq(state.planes as Set<string>, v.planes);
}

function pushRoute(replace = false): void {
  if (applyingRoute) return;
  const next = '#' + currentRoute();
  if (location.hash === next) return;
  if (replace) history.replaceState(null, '', next);
  else history.pushState(null, '', next);
}

function applyRoute(): void {
  const raw = location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  applyingRoute = true;
  try {
    // A route is absolute state, so the ABSENCE of a segment has to mean
    // something too. Both of these only ever set their non-default before, so
    // once anything had switched to the flat view or hidden the shells, no link
    // could switch back — and pushRoute then wrote the stale mode straight back
    // into the URL, which reads as the address bar fighting you.
    setShells(!parts.includes('bare'));
    setMode(parts.includes('flat') ? '2d' : '3d');
    if (!parts.length) {
      applyView(DEFAULT_VIEW);
      return;
    }
    let i = 0;
    if (parts[0] === 'flow') {
      const flow = graph.flows.find((f) => f.id === parts[1]);
      if (flow) {
        // Dimension before the flow: startFlow frames the first hop, and it has
        // to frame it in the view the link actually asked for.
        if (parts.includes('flat')) setMode('2d');
        startFlow(flow);
        const step = Number(parts[2]);
        if (Number.isFinite(step)) gotoStep(step - 1);
        return;
      }
      applyView(DEFAULT_VIEW);
      return;
    }
    if (state.flow) exitFlow();
    if (parts[0] === 'view') {
      applyView(parts[1] ?? DEFAULT_VIEW);
      i = 2;
    } else if (parts[0] === 'custom') {
      const layers = (parts[1] ?? '').split(',').filter((x) => LAYER_SLUG[x]);
      const planes = (parts[2] ?? '').split(',').map((x) => PLANE_SLUG[x]).filter(Boolean);
      state.layers = new Set(layers as Layer[]);
      state.planes = new Set(planes as Plane[]);
      activeView = '';
      for (const b of $('views').querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
      syncToggleRows();
      applyFilters();
      frameVisible();
      i = 3;
    } else {
      applyView(DEFAULT_VIEW);
    }
    for (; i < parts.length; i++) {
      if (parts[i] === 'flat') {
        // Links written before the flat view was pinned to plane carry a
        // grouping after 'flat'. Step over it rather than reading it as a node.
        if (['plane', 'kind', 'status', 'deploy', 'repo', 'boundary'].includes(parts[i + 1])) i++;
        setMode('2d');
      }
      else if (parts[i] === 'node' && parts[i + 1]) { openNode(parts[++i]); }
      else if (parts[i] === 'edge' && parts[i + 1]) { openEdge(parts[++i]); }
      else if (parts[i] === 'find' && parts[i + 1]) {
        state.query = parts[++i];
        $<HTMLInputElement>('search').value = state.query;
        renderResults();
        applyFilters();
      }
    }
  } finally {
    applyingRoute = false;
  }
}

addEventListener('hashchange', applyRoute);

// -- boot --------------------------------------------------------------------

$('stamp').textContent = `atlas ${graph.atlasCommit} · generated ${graph.generatedAt.slice(0, 10)}`;
buildToggles();
buildDimension();
buildViews();
buildFlowList();
syncMode();
resize();
applyRoute();
if (!location.hash) applyFilters();
frameVisible();
flyT = 1; // land on the opening frame immediately rather than easing in
if (flyGoal && eyeGoal) { view.controls.target.copy(flyGoal); view.camera.position.copy(eyeGoal); }
requestAnimationFrame(frame);

const fullBtn = $('full');
fullBtn.addEventListener('click', toggleFullscreen);

function toggleFullscreen(): void {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

addEventListener('keydown', (ev) => {
  if (ev.key === 'f' && !(ev.target instanceof HTMLInputElement)) toggleFullscreen();
  if (ev.key === 'r' && !(ev.target instanceof HTMLInputElement)) frameVisible();
  if ((ev.key === 'm' || ev.key === 'M') && state.mode === '3d' && !(ev.target instanceof HTMLInputElement)) view.strike();
  if (ev.key === 'Escape') { state.flow ? exitFlow() : closeInspector(); }
  if (state.flow && ev.key === 'ArrowRight') gotoStep(state.flow.step + 1);
  if (state.flow && ev.key === 'ArrowLeft') gotoStep(state.flow.step - 1);
});

setTimeout(() => { $('hint').style.opacity = '0'; }, 7000);
