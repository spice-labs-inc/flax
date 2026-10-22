// WebGL layer for the 2D view: boxes, edges, nodes, on an orthographic camera.
//
// Deliberately its own module rather than a mode inside scene.ts. The two views
// want opposite things from the GPU. The 3D scene is additive and luminous,
// because depth is carried by glow and occlusion; this one is flat and opaque,
// because containment is carried by an outline and a node has to read clearly
// against the box it sits in. Sharing a material between those two would mean
// one of them compromising.
//
// Positions come baked from the layout2d stage, one set per grouping, so
// switching grouping rewrites a buffer and never simulates.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Graph, GraphEdge, GraphNode, Group, GroupKey, Layer } from '../model/types.ts';
import { BG_FRAG, FG_FRAG, LAYER_COLOR, nodeColor, nodeRadius, nodeShape, PLANE_COLOR } from './scene.ts';

const BG = 0x0a0f16;

/** Upper bound on drawn boxes, so the box buffers can be sized once. */
const MAX_BOXES = 96;

/**
 * Frosting is asked for, not inferred: a NEGATIVE alpha means "this is context,
 * draw it behind the glass at |a|", a positive one means "draw it sharp".
 *
 * Inferring it from a threshold was wrong in a way that took a while to see.
 * Quiet is not the same as excluded. Build edges rest at 0.24 and shared
 * dependencies at 0.22 because they are BACKGROUND, not because they are
 * filtered out — and Shared code is the one view built entirely from those two
 * layers, so a threshold at 0.5 frosted every connection it had. It reported a
 * hundred and nineteen connections and showed none.
 */
const isContext = (a: number) => a < 0;
/** The frosted layer renders at half resolution; it is about to be blurred. */
const FROST_SCALE = 0.5;
/**
 * How much a dimmed thing is lifted before being blurred. Blur spreads its
 * light out, so the alpha that read as faint when sharp reads as nothing at all
 * once frosted.
 */
const FROST_LIFT = 2.6;
/** Nodes carry more ink than a line does, so they need less of a lift. */
const FROST_LIFT_NODE = 1.7;

/** World units of padding kept between the field and the viewport edge. */
const FRAME_PAD = 90;
/** Extra headroom at the top, so a box label is never clipped by the frame. */
const FRAME_TOP_PAD = 70;

// -- node pass ---------------------------------------------------------------
//
// Same shape vocabulary as the 3D scene, drawn solid instead of glowing: a
// filled body, a bright rim, and no additive stacking. Two nodes that overlap
// in 2D must still read as two nodes.

const NODE_VERT = `
  attribute float size;
  attribute float alpha;
  attribute vec3 tint;
  attribute float shape;
  uniform float uPxPerWorld;
  varying float vAlpha;
  varying vec3 vTint;
  varying float vShape;
  varying float vPx;
  void main() {
    vAlpha = alpha;
    vTint = tint;
    vShape = shape;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(6.0, size * uPxPerWorld);
    vPx = gl_PointSize;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * Signed distance to the shape's edge, in point-sprite units. Positive inside.
 * Shapes match {@link nodeShape}: 0 hexagon, 1 square, 2 diamond, 3 ring,
 * 4 small disc, 5 hollow square, 6 pulse dot.
 */
const NODE_FRAG = `
  precision highp float;
  varying float vAlpha;
  varying vec3 vTint;
  varying float vShape;
  varying float vPx;

  float sdHex(vec2 p, float r) {
    const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
    p = abs(p);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
    return length(p) * sign(p.y);
  }

  void main() {
    if (vAlpha <= 0.004) discard;
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float d;                       // negative inside
    if (vShape < 0.5)      d = sdHex(p, 0.86);
    else if (vShape < 1.5) d = max(abs(p.x), abs(p.y)) - 0.80;
    else if (vShape < 2.5) d = abs(p.x) + abs(p.y) - 1.02;
    else if (vShape < 3.5) d = abs(length(p) - 0.72) - 0.19;
    else if (vShape < 4.5) d = length(p) - 0.60;
    else if (vShape < 5.5) d = abs(max(abs(p.x), abs(p.y)) - 0.76) - 0.16;
    else                   d = length(p) - 0.5;

    // One device pixel expressed in the sprite's own units, so the outline
    // stays a hairline at every zoom instead of thickening as nodes grow.
    float px = 2.0 / max(6.0, vPx);
    float body = 1.0 - smoothstep(-px, px, d);

    // A rim brighter than the fill separates touching nodes without needing a
    // drop shadow, and a short falloff outside the body carries the same
    // luminosity the 3D view gets from additive blending — without the
    // stacking, so two overlapping nodes stay two nodes.
    float rim = 1.0 - smoothstep(-px * 2.6, -px * 0.6, d);
    float halo = exp(-max(0.0, d) * 7.0) * (1.0 - body);
    vec3 fill = vTint * 0.80;
    vec3 col = mix(fill, vTint * 1.45, rim);
    float a = (body + halo * 0.45) * vAlpha;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(col, a);
  }
`;

// -- box pass ----------------------------------------------------------------
//
// One quad per group, drawn as a rounded rectangle: a very faint wash inside so
// membership reads as an area, and a solid hairline border so the boundary is
// unambiguous where two boxes sit close together.

const BOX_VERT = `
  attribute vec2 corner;
  attribute vec2 halfSize;
  attribute float alpha;
  attribute vec3 tint;
  varying vec2 vCorner;
  varying vec2 vHalf;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    vCorner = corner;
    vHalf = halfSize;
    vAlpha = alpha;
    vTint = tint;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// -- frosted glass -----------------------------------------------------------
//
// Filtered-out content is drawn into its own buffer, blurred, and composited
// underneath the live diagram. Dimming alone leaves a legible second graph
// competing for attention; blurring puts it behind glass, where it still says
// "there is more here" without asking to be read.

const BLUR_FRAG = `
  precision highp float;
  uniform sampler2D uTex;
  uniform vec2 uStep;      // one tap, in UV
  varying vec2 vUv;
  void main() {
    // Nine taps, gaussian-ish. Two passes at right angles make it separable,
    // which is the difference between 9 samples and 81.
    vec4 sum = texture2D(uTex, vUv) * 0.20;
    sum += texture2D(uTex, vUv + uStep * 1.0) * 0.166;
    sum += texture2D(uTex, vUv - uStep * 1.0) * 0.166;
    sum += texture2D(uTex, vUv + uStep * 2.0) * 0.121;
    sum += texture2D(uTex, vUv - uStep * 2.0) * 0.121;
    sum += texture2D(uTex, vUv + uStep * 3.0) * 0.065;
    sum += texture2D(uTex, vUv - uStep * 3.0) * 0.065;
    sum += texture2D(uTex, vUv + uStep * 4.0) * 0.048;
    sum += texture2D(uTex, vUv - uStep * 4.0) * 0.048;
    gl_FragColor = sum;
  }
`;

const COMPOSITE_FRAG = `
  precision highp float;
  uniform sampler2D uTex;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    // Added, not blended over. The frosted layer is light on a dark field, and
    // adding it can only brighten; blending it over paints the buffer's own
    // dark RGB into every partly-covered pixel, which reads as soot rather than
    // as haze.
    vec4 c = texture2D(uTex, vUv);
    gl_FragColor = vec4(c.rgb * c.a * uOpacity, 1.0);
  }
`;

const FULLSCREEN_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

/**
 * A box as a piece of translucent board: a tinted substrate, a grid etched into
 * it, a brighter rim, and a bevel just inside the edge.
 *
 * The routing already draws right-angled traces in shared corridors, so the
 * boards are the substrate that vocabulary implies. Two rules keep it from
 * becoming noise. The grid is drawn in SCREEN space, not world space, so it
 * holds a constant pitch instead of turning into moiré when you zoom out; and
 * it fades out below a legible pitch, so a box seen small is a plain tinted
 * pane. It is also skipped entirely on the frosted pass — texture behind glass
 * is just haze, and it would compete with the diagram in focus.
 */
const BOX_FRAG = `
  precision highp float;
  varying vec2 vCorner;
  varying vec2 vHalf;
  varying float vAlpha;
  varying vec3 vTint;
  uniform float uPxPerWorld;
  uniform float uEtch;      // 0 on the frosted pass, 1 on the sharp one

  void main() {
    if (vAlpha <= 0.004) discard;
    float r = min(26.0, min(vHalf.x, vHalf.y) * 0.28);
    vec2 p = abs(vCorner * vHalf) - vHalf + r;
    float d = min(max(p.x, p.y), 0.0) + length(max(p, 0.0)) - r;  // world units

    float w = 1.0 / max(0.00001, uPxPerWorld);   // one device pixel in world units
    float border = 1.0 - smoothstep(0.0, w * 2.0, abs(d + w));
    float inside = 1.0 - smoothstep(-w, w, d);

    // A bevel a few pixels in from the rim, the way a board's edge catches
    // light. Gives the pane a thickness the flat wash never had.
    float bevel = (1.0 - smoothstep(w * 3.0, w * 9.0, abs(d + w * 6.0))) * inside;

    // Etched grid. Screen-space pitch, so it never aliases; faded out when the
    // squares get too small to read as squares.
    vec2 screen = vCorner * vHalf * uPxPerWorld;
    float pitch = 26.0;
    vec2 gg = abs(fract(screen / pitch) - 0.5) / fwidth(screen / pitch);
    float line = 1.0 - min(min(gg.x, gg.y), 1.0);
    float legible = smoothstep(0.10, 0.30, uPxPerWorld);
    float grid = line * inside * legible * uEtch;

    vec3 col = mix(vTint * 0.30, vTint, max(border, bevel * 0.5));
    col = mix(col, vTint * 1.15, grid * 0.55);

    float a = max(max(inside * 0.085, grid * 0.16), max(border, bevel * 0.22)) * vAlpha;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(col, a);
  }
`;

export interface Scene2DHandles {
  renderer: WebGLRenderer;
  camera: OrthographicCamera;
  scene: Scene;
  nodes: GraphNode[];
  /** The boxes currently drawn, for labelling and hit-testing in the DOM layer. */
  boxes: () => Group[];
  grouping: () => GroupKey;
  setGrouping: (key: GroupKey) => void;
  /** Baked 2D position of a node under the current grouping. */
  positionOf: (n: GraphNode) => Vector3;
  /** A point along the route a hop is drawn on, so pulses ride their own line. */
  curveAt: (id: string, source: string, target: string, t: number) => [number, number] | null;
  /** The exact polyline an edge is drawn as, in world space, for hit-testing. */
  pathOf: (e: GraphEdge) => Array<[number, number]> | null;
  /** True when both ends of an edge sit in the same box under this grouping. */
  sameBox: (e: GraphEdge) => boolean;
  /** CSS pixels per world unit at the current zoom, for sizing hit targets. */
  pxPerWorld: () => number;
  setNodeAlpha: (fn: (n: GraphNode, i: number) => number) => void;
  setNodeSize: (fn: (n: GraphNode, i: number) => number) => void;
  setNodeTint: (fn: (n: GraphNode, i: number) => string) => void;
  setEdgeAlpha: (fn: (e: GraphEdge, i: number) => number) => void;
  setHighlight: (links: Array<{ source: string; target: string; layer: Layer }>) => void;
  setPulses: (points: Array<{ pos: Vector3; color: string; strength: number }>) => void;
  /** Dim boxes that hold nothing visible, so filtering empties them honestly. */
  setBoxAlpha: (fn: (g: Group, members: GraphNode[]) => number) => void;
  setEdgeWidth: (px: number) => void;
  setResolution: (w: number, h: number) => void;
  /** Match the camera frustum to the canvas. */
  setAspect: (w: number, h: number) => void;
  /** Fit these nodes into the given screen rectangle, in CSS pixels. */
  frameIds: (ids: Set<string>, vp: { left: number; right: number; bottom: number }) => void;
  frameAll: () => void;
  /** Centre one node without changing zoom. */
  focusNode: (n: GraphNode) => void;
  /** Ease the camera toward its goal; call once per frame. */
  tick: (dtMs: number) => void;
  /** True while the camera is still moving, so labels keep re-projecting. */
  moving: () => boolean;
  render: (nowMs?: number) => void;
  /** Pointer interaction. Returns true when the gesture consumed the event. */
  attachControls: (el: HTMLElement, onChange: () => void) => () => void;
}

export function buildScene2d(canvas: HTMLCanvasElement, graph: Graph): Scene2DHandles {
  const scene = new Scene();
  // Frustum is set properly by setAspect before the first frame.
  const camera = new OrthographicCamera(-1000, 1000, 1000, -1000, -1000, 1000);
  camera.position.set(0, 0, 500);

  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setClearColor(BG, 1);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  // The same ambient field the 3D view sits in. A flat diagram on flat black
  // reads as a screenshot; the field is what makes both views one place.
  const bgScene = new Scene();
  const bgCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bgMat = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uAspect: { value: 1 },
      uDrift: { value: { x: 0, y: 0 } },
      uZoom: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: BG_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  bgScene.add(new Mesh(new PlaneGeometry(2, 2), bgMat));

  // The thin luminous veil and its meteors, drawn in front of everything. Same
  // pass as the 3D view: it is the atmosphere both views share.
  const fgScene = new Scene();
  const fgMat = new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uAspect: { value: 1 }, uZoom: { value: 1 }, uDrift: { value: { x: 0, y: 0 } } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: FG_FRAG,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: AdditiveBlending,
  });
  fgScene.add(new Mesh(new PlaneGeometry(2, 2), fgMat));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // -- frosted-glass plumbing -------------------------------------------------
  // Two targets to ping-pong the separable blur through, plus the quads that
  // do the blurring and the compositing. Half resolution: it is a blur.
  const rtA = new WebGLRenderTarget(1, 1);
  const rtB = new WebGLRenderTarget(1, 1);
  const blurMat = new ShaderMaterial({
    uniforms: { uTex: { value: null as unknown as Texture }, uStep: { value: new Vector2() } },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: BLUR_FRAG,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  const blurScene = new Scene();
  blurScene.add(new Mesh(new PlaneGeometry(2, 2), blurMat));

  const frostMat = new ShaderMaterial({
    // Slightly under full strength: the glass should say there is more here, not
    // compete with what is in focus.
    uniforms: { uTex: { value: null as unknown as Texture }, uOpacity: { value: 0.72 } },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: COMPOSITE_FRAG,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: AdditiveBlending,
  });
  const frostScene = new Scene();
  frostScene.add(new Mesh(new PlaneGeometry(2, 2), frostMat));

  const groupings = graph.groups ?? {};
  let key: GroupKey = 'plane';

  const nodes = graph.nodes.filter((n) => n.pos2d && n.pos2d[key]);
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const count = nodes.length;
  const c = new Color();

  const at = (n: GraphNode): [number, number] => n.pos2d?.[key] ?? [0, 0];

  // -- nodes -----------------------------------------------------------------
  const pos = new Float32Array(count * 3);
  const tint = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const alpha = new Float32Array(count).fill(1);
  const shape = new Float32Array(count);

  nodes.forEach((n, i) => {
    const [x, y] = at(n);
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = 2;
    c.set(nodeColor(n));
    tint.set([c.r, c.g, c.b], i * 3);
    size[i] = nodeRadius(n);
    shape[i] = nodeShape(n);
  });

  const nodeGeom = new BufferGeometry();
  nodeGeom.setAttribute('position', new BufferAttribute(pos, 3));
  nodeGeom.setAttribute('tint', new BufferAttribute(tint, 3));
  nodeGeom.setAttribute('size', new BufferAttribute(size, 1));
  nodeGeom.setAttribute('alpha', new BufferAttribute(alpha, 1));
  nodeGeom.setAttribute('shape', new BufferAttribute(shape, 1));

  const nodeMat = new ShaderMaterial({
    uniforms: { uPxPerWorld: { value: 1 } },
    vertexShader: NODE_VERT,
    fragmentShader: NODE_FRAG,
    transparent: true,
    depthWrite: false,
  });
  const nodePoints = new Points(nodeGeom, nodeMat);
  nodePoints.frustumCulled = false;
  nodePoints.renderOrder = 3;
  scene.add(nodePoints);

  // The dimmed half of the graph, drawn into its own buffer so it can be put
  // behind glass. It shares every attribute with the live half except alpha —
  // an item is in exactly one of the two, so nothing is ever drawn twice.
  const dimScene = new Scene();
  const dimAlpha = new Float32Array(count);
  const dimNodeGeom = new BufferGeometry();
  dimNodeGeom.setAttribute('position', nodeGeom.attributes.position);
  dimNodeGeom.setAttribute('tint', nodeGeom.attributes.tint);
  dimNodeGeom.setAttribute('size', nodeGeom.attributes.size);
  dimNodeGeom.setAttribute('alpha', new BufferAttribute(dimAlpha, 1));
  dimNodeGeom.setAttribute('shape', nodeGeom.attributes.shape);
  const dimNodes = new Points(dimNodeGeom, nodeMat);
  dimNodes.frustumCulled = false;
  dimNodes.renderOrder = 3;
  dimScene.add(dimNodes);

  // -- box membership --------------------------------------------------------
  //
  // Computed before the edges, because an edge needs to know which boxes its
  // ends sit in before it can be routed.
  let shownBoxes: Group[] = [];
  let boxMembers: GraphNode[][] = [];
  const boxOf = new Map<string, Group>();

  function computeMembership(): void {
    shownBoxes = (groupings[key] ?? []).slice(0, MAX_BOXES);
    boxOf.clear();
    boxMembers = shownBoxes.map((g) => {
      const members = nodes.filter((n) => inBox(n, g));
      for (const n of members) boxOf.set(n.id, g);
      return members;
    });
  }
  computeMembership();

  // -- edges -----------------------------------------------------------------
  //
  // Screen-space width is the one thing plain GL lines cannot do, and three's
  // line quads already solve it correctly.
  //
  // Edges between two boxes are routed through a trunk, not drawn point to
  // point. Every edge from box A to box B leaves its node, converges on one
  // exit port on A's boundary, crosses the gap along a single shared line to
  // one entry port on B's boundary, and fans out to its node inside B.
  //
  // The shared middle is the whole point: thirty edges from thirty product
  // components to the registries they call cross the gap as ONE line, because
  // the middle span is literally the same two points for all of them. Pulling
  // thirty separate curves toward a common midpoint — the obvious first
  // attempt — narrows the waist but still crosses the gap thirty times, which
  // is no fewer lines than going straight. Fanning survives only inside each
  // box, where it is short and where the labels explain it.
  //
  // Edges inside a box stay straight; there is no gap to cross.
  const drawable = graph.edges.filter((e) => index.has(e.source) && index.has(e.target));

  // Every edge gets as many segments as its own smoothed path has, rather than
  // a fixed budget resampled out of it. A fixed budget was the reason the curves
  // looked chewed: a route smoothed to forty points was then redrawn as
  // eighteen chords picked by index, which throws away most of the smoothing and
  // spends the same number of samples on a long span as on a short one. A
  // straight edge is still one segment, so this costs nothing where nothing is
  // bent.
  let epos = new Float32Array(0);
  let baseCol = new Float32Array(0);
  let shownCol = new Float32Array(0);
  let glowCol = new Float32Array(0);
  /** Colours for the frosted copy: an edge is bright in one buffer or the other. */
  let dimCol = new Float32Array(0);
  /**
   * Whether anything is behind the glass at all. The frost costs three
   * full-screen passes — draw, blur, blur — and running them over an empty
   * buffer is pure waste. It is free on a desktop GPU at 60fps and it is not
   * free on a laptop.
   */
  let frostNodes = false;
  let frostEdges = false;
  let frostBoxes = false;
  /** Where each edge's segments start, and how many it has. */
  const spans: Array<{ start: number; count: number }> = drawable.map(() => ({ start: 0, count: 0 }));

  /** Bend points for the current grouping, keyed by edge id. */
  let routes: Record<string, number[]> = graph.routes?.[key] ?? {};
  /**
   * Hover and flow pulses know a pair of nodes, not an edge id. Where several
   * edges join the same two nodes they were routed into the same channel, so
   * the first one's route stands in for all of them.
   */
  const edgeById = new Map(drawable.map((e) => [e.id, e]));
  const pairEdge = new Map<string, GraphEdge>();
  function rebuildPairIds(): void {
    pairEdge.clear();
    // Routed edges first. Several edges can join the same two nodes (a CLI and
    // the library it drives can have three) and the shared-dependency layer is deliberately
    // left out of the layout, so it has no route. Picking one of those to stand
    // for the pair drew a straight diagonal across a diagram that has none.
    for (const routed of [true, false]) {
      for (const e of drawable) {
        if ((routes[e.id] !== undefined) !== routed) continue;
        // Both directions: a corridor between two nodes is the same channel
        // whichever way the hop is described, and a flow often describes it
        // backwards.
        for (const k of [`${e.source}|${e.target}`, `${e.target}|${e.source}`]) {
          if (!pairEdge.has(k)) pairEdge.set(k, e);
        }
      }
    }
  }
  rebuildPairIds();


  /**
   * Round each corner of a routed polyline, leaving the straight runs alone.
   *
   * This is the transit-map treatment, and it replaces a global spline that was
   * wrong twice over. A spline curves the whole line, including the long
   * straight runs that should stay straight, and it emits evenly spaced points
   * along them — which then bead, because every segment carries its own rounded
   * cap and the caps double under additive blending. Worse, simplifying those
   * points away afterwards deleted the very curvature the spline had added: on
   * a gentle arc, closely spaced samples sit well inside any sane
   * distance-from-chord threshold.
   *
   * Only corners get geometry. A straight run stays one segment however long.
   */
  const CORNER_RADIUS = 26;
  const CORNER_STEPS = 6;
  function roundCorners(pts: Array<[number, number]>): Array<[number, number]> {
    if (pts.length < 3) return pts;
    const out: Array<[number, number]> = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i - 1];
      const [qx, qy] = pts[i];
      const [rx, ry] = pts[i + 1];
      const v1x = qx - px;
      const v1y = qy - py;
      const v2x = rx - qx;
      const v2y = ry - qy;
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      if (l1 < 0.01 || l2 < 0.01) continue;
      // Near-parallel: not a corner, and rounding it would only add beading.
      if ((v1x * v2x + v1y * v2y) / (l1 * l2) > 0.9995) continue;

      // Back off along both legs by the same distance, never more than
      // whichever leg is shortest can spare.
      const rad = Math.min(CORNER_RADIUS, l1 * 0.45, l2 * 0.45);
      const ax = qx - (v1x / l1) * rad;
      const ay = qy - (v1y / l1) * rad;
      const bx = qx + (v2x / l2) * rad;
      const by = qy + (v2y / l2) * rad;
      out.push([ax, ay]);
      // A quadratic with the corner itself as the control point: the arc leaves
      // one leg and joins the other exactly tangentially.
      for (let s = 1; s < CORNER_STEPS; s++) {
        const t = s / CORNER_STEPS;
        const u = 1 - t;
        out.push([u * u * ax + 2 * u * t * qx + t * t * bx, u * u * ay + 2 * u * t * qy + t * t * by]);
      }
      out.push([bx, by]);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /** The full route one hop takes, as a polyline in world space. */
  function pathFor(id: string, source: string, target: string): Array<[number, number]> | null {
    const ia = index.get(source);
    const ib = index.get(target);
    if (ia === undefined || ib === undefined) return null;
    const a = at(nodes[ia]);
    const b = at(nodes[ib]);
    // The route was decided by the layout engine in the generator, which had
    // the whole graph in front of it. All the viewer does is join the dots.
    // By edge id first. Failing that, by node pair — a guided-flow step is a
    // curated claim about a journey and does not have to correspond to an edge
    // the extraction found, and some steps name a hop the graph only has in the
    // opposite direction. Both used to fall through to a straight line, which is
    // why a flow would throw a diagonal across an otherwise square diagram.
    let bends = routes[id];
    // A route runs from ITS edge's source to ITS edge's target. Draw it for a
    // hop that goes the other way and the bends arrive in reverse — the line
    // leaves one node, jumps to the far node's exit point, works back, and
    // finishes at the near node. That is what put a diagonal on
    // API -> web app: the flow step goes that way, the only edge between
    // them is web app -> API, and its route was used unreversed.
    let flip = bends?.length ? edgeById.get(id)?.source !== source : false;
    // Its own route first. Failing that, a sibling's: several edges can join the
    // same two nodes (a CLI and the library it drives can have three) and the
    // shared-dependency layer is deliberately left out of the layout, so it has
    // none. In a guided flow every edge between the two nodes is drawn, and the
    // unrouted one was cutting a straight diagonal beside its routed siblings.
    if (!bends?.length) {
      const sub = pairEdge.get(`${source}|${target}`);
      if (sub && sub.id !== id && routes[sub.id]?.length) {
        bends = routes[sub.id];
        flip = sub.source !== source;
      }
    }
    if (!bends?.length) bends = routes[`pair:${source}|${target}`];
    if (!bends?.length) {
      bends = routes[`pair:${target}|${source}`];
      flip = bends !== undefined;
    }
    if (!bends?.length) return [a, b];
    // Stored as a start point plus deltas: these are orthogonal routes, so one
    // of each pair is almost always zero, which is a character instead of a
    // coordinate and compresses to nearly nothing.
    const mid: Array<[number, number]> = [[bends[0], bends[1]]];
    for (let i = 2; i < bends.length; i += 2) {
      const prev = mid[mid.length - 1];
      mid.push([prev[0] + bends[i], prev[1] + bends[i + 1]]);
    }
    if (flip) mid.reverse();
    const pts: Array<[number, number]> = [a, ...mid];
    pts.push(b);
    // Simplify FIRST, then round. The other order deletes its own curvature.
    return roundCorners(simplify(pts));
  }

  /**
   * Drop points that sit on the line between their neighbours.
   *
   * Each segment is drawn as its own quad with a rounded cap, so where two
   * segments meet the caps overlap and additive blending doubles the brightness
   * there. On a straight run smoothed into a dozen collinear points that reads
   * as a dashed line. Collapsing them back to one segment removes the beading
   * and most of the geometry along with it.
   */
  function simplify(pts: Array<[number, number]>): Array<[number, number]> {
    if (pts.length < 3) return pts;
    const out: Array<[number, number]> = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const [ax, ay] = out[out.length - 1];
      const [bx, by] = pts[i];
      const [cx, cy] = pts[i + 1];
      // Twice the triangle area over the base length: the point's distance from
      // the chord its neighbours span.
      const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
      const base = Math.hypot(cx - ax, cy - ay);
      if (base > 0 && area / base < 0.6) continue;
      out.push(pts[i]);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /** Sample a polyline at 0 <= t <= 1, by segment index rather than arc length. */
  function alongPath(path: Array<[number, number]>, t: number): [number, number] {
    // By ARC LENGTH, not by segment index. An orthogonal route is a couple of
    // short stubs and one long run; stepping by index spends most of its samples
    // on the stubs, so a flow's dots bunched up on the short pieces and crawled
    // across the long one. Travel should be even along the line you can see.
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) {
      total += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    }
    if (total <= 0) return path[0];
    let want = Math.min(1, Math.max(0, t)) * total;
    for (let i = 0; i < path.length - 1; i++) {
      const len = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
      if (want <= len || i === path.length - 2) {
        const k = len > 0 ? want / len : 0;
        return [path[i][0] + (path[i + 1][0] - path[i][0]) * k, path[i][1] + (path[i + 1][1] - path[i][1]) * k];
      }
      want -= len;
    }
    return path[path.length - 1];
  }

  /** A point along the route one hop is drawn on, at 0 <= t <= 1. */
  function curveAt(id: string, source: string, target: string, t: number): [number, number] | null {
    // The edge's OWN id matters here. Several edges can join the same two nodes
    // and each gets its own lane in the corridor, so borrowing a sibling's route
    // put the pulse a lane away from the line it belongs to.
    const path = pathFor(id || (pairEdge.get(`${source}|${target}`)?.id ?? ''), source, target);
    return path ? alongPath(path, t) : null;
  }

  /**
   * Rebuild the edge buffers from the current grouping's routes. Segment counts
   * vary per edge, so the arrays are sized to fit rather than to a worst case.
   */
  function writeEdgePositions(): void {
    const paths = drawable.map((e) => pathFor(e.id, e.source, e.target));
    let total = 0;
    paths.forEach((p, i) => {
      const count = p ? p.length - 1 : 0;
      spans[i] = { start: total, count };
      total += count;
    });

    if (epos.length !== total * 6) {
      epos = new Float32Array(total * 6);
      baseCol = new Float32Array(total * 6);
      shownCol = new Float32Array(total * 6);
      glowCol = new Float32Array(total * 6);
      dimCol = new Float32Array(total * 6);
    }

    paths.forEach((path, i) => {
      if (!path) return;
      c.set(LAYER_COLOR[drawable[i].layer]);
      const { start, count } = spans[i];
      for (let s = 0; s < count; s++) {
        const o = (start + s) * 6;
        epos[o] = path[s][0];
        epos[o + 1] = path[s][1];
        epos[o + 2] = 1;
        epos[o + 3] = path[s + 1][0];
        epos[o + 4] = path[s + 1][1];
        epos[o + 5] = 1;
        // Same fade toward the target the 3D view uses, so direction reads the
        // same way in both — spread along the route rather than end to end.
        const f0 = 1 - (s / count) * 0.5;
        const f1 = 1 - ((s + 1) / count) * 0.5;
        baseCol[o] = c.r * f0;
        baseCol[o + 1] = c.g * f0;
        baseCol[o + 2] = c.b * f0;
        baseCol[o + 3] = c.r * f1;
        baseCol[o + 4] = c.g * f1;
        baseCol[o + 5] = c.b * f1;
      }
    });
    shownCol.set(baseCol);
    glowCol.set(baseCol);
  }

  writeEdgePositions();

  const edgeGeom = new LineSegmentsGeometry();
  edgeGeom.setPositions(epos);
  edgeGeom.setColors(shownCol);
  // Additive, like the 3D view: scaling an edge colour toward black is then the
  // same as hiding it. Under normal blending a hidden edge paints black instead,
  // which drew the whole graph as dark spaghetti over the field.
  const edgeMat = new LineMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    linewidth: 2.4,
  });
  edgeMat.resolution.set(1, 1);
  const edgeMesh = new LineSegments2(edgeGeom, edgeMat);
  edgeMesh.frustumCulled = false;
  edgeMesh.renderOrder = 2;
  scene.add(edgeMesh);

  // Dimmed edges, same geometry, own colours. No halo pass for these: they are
  // about to be blurred, and a halo under a blur is just more haze.
  const dimEdgeGeom = new LineSegmentsGeometry();
  dimEdgeGeom.setPositions(epos);
  dimEdgeGeom.setColors(dimCol);
  const dimEdgeMesh = new LineSegments2(dimEdgeGeom, edgeMat);
  dimEdgeMesh.frustumCulled = false;
  dimEdgeMesh.renderOrder = 2;
  dimScene.add(dimEdgeMesh);

  // The halo pass, as in the 3D view — but much tighter. Flat on one plane,
  // dozens of edges run near-parallel out of a tier toward a distant box, and a
  // wide halo on each of them sums under additive blending into broad bands
  // that pool where the fan converges. Depth is what keeps them apart in 3D.
  // Narrow enough to hug its own line, the glow reads as luminosity again.
  const glowGeom = new LineSegmentsGeometry();
  glowGeom.setPositions(epos);
  glowGeom.setColors(glowCol);
  const glowMat = new LineMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    linewidth: 9,
    opacity: 0.16,
  });
  glowMat.resolution.set(1, 1);
  const glowMesh = new LineSegments2(glowGeom, glowMat);
  glowMesh.frustumCulled = false;
  glowMesh.renderOrder = 1.5;
  scene.add(glowMesh);

  const hlGeom = new LineSegmentsGeometry();
  const hlMat = new LineMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
    linewidth: 5.5,
  });
  hlMat.resolution.set(1, 1);
  const hlMesh = new LineSegments2(hlGeom, hlMat);
  hlMesh.frustumCulled = false;
  hlMesh.renderOrder = 4;
  hlMesh.visible = false;
  scene.add(hlMesh);

  // -- boxes -----------------------------------------------------------------
  const bpos = new Float32Array(MAX_BOXES * 6 * 3);
  const bcorner = new Float32Array(MAX_BOXES * 6 * 2);
  const bhalf = new Float32Array(MAX_BOXES * 6 * 2);
  const btint = new Float32Array(MAX_BOXES * 6 * 3);
  const balpha = new Float32Array(MAX_BOXES * 6);
  const boxGeom = new BufferGeometry();
  boxGeom.setAttribute('position', new BufferAttribute(bpos, 3));
  boxGeom.setAttribute('corner', new BufferAttribute(bcorner, 2));
  boxGeom.setAttribute('halfSize', new BufferAttribute(bhalf, 2));
  boxGeom.setAttribute('tint', new BufferAttribute(btint, 3));
  boxGeom.setAttribute('alpha', new BufferAttribute(balpha, 1));
  const boxMat = new ShaderMaterial({
    uniforms: { uPxPerWorld: { value: 1 }, uEtch: { value: 1 } },
    vertexShader: BOX_VERT,
    fragmentShader: BOX_FRAG,
    transparent: true,
    depthWrite: false,
  });
  // The frosted copy shares the scale uniform but etches nothing: a grid behind
  // glass is haze, and it would compete with the boards that are in focus.
  const dimBoxMat = new ShaderMaterial({
    uniforms: { uPxPerWorld: boxMat.uniforms.uPxPerWorld, uEtch: { value: 0 } },
    vertexShader: BOX_VERT,
    fragmentShader: BOX_FRAG,
    transparent: true,
    depthWrite: false,
  });
  const boxMesh = new Mesh(boxGeom, boxMat);
  boxMesh.frustumCulled = false;
  boxMesh.renderOrder = 1;
  scene.add(boxMesh);

  const dimBoxAlpha = new Float32Array(MAX_BOXES * 6);
  const dimBoxGeom = new BufferGeometry();
  for (const a of ['position', 'corner', 'halfSize', 'tint']) {
    dimBoxGeom.setAttribute(a, boxGeom.attributes[a]);
  }
  dimBoxGeom.setAttribute('alpha', new BufferAttribute(dimBoxAlpha, 1));
  const dimBoxMesh = new Mesh(dimBoxGeom, dimBoxMat);
  dimBoxMesh.frustumCulled = false;
  dimBoxMesh.renderOrder = 1;
  dimScene.add(dimBoxMesh);

  /** Corner order for the two triangles making one quad. */
  const QUAD: Array<[number, number]> = [
    [-1, -1], [1, -1], [1, 1],
    [-1, -1], [1, 1], [-1, 1],
  ];

  function writeBoxes(): void {
    balpha.fill(0);
    shownBoxes.forEach((g, i) => {
      const hw = g.w / 2;
      const hh = g.h / 2;
      // Grouping by plane means the boxes ARE the planes, so they carry the
      // plane's colour and the map keeps the palette people already read.
      c.set(key === 'plane' ? PLANE_COLOR[(g.within ?? g.id) as keyof typeof PLANE_COLOR] ?? '#8FA6B8' : '#8FA6B8');
      QUAD.forEach(([cx, cy], k) => {
        const v = (i * 6 + k);
        bpos.set([g.x + cx * hw, g.y + cy * hh, 0], v * 3);
        bcorner.set([cx, cy], v * 2);
        bhalf.set([hw, hh], v * 2);
        btint.set([c.r, c.g, c.b], v * 3);
        balpha[v] = 1;
      });
    });
    boxGeom.setDrawRange(0, MAX_BOXES * 6);
    for (const a of ['position', 'corner', 'halfSize', 'tint', 'alpha']) {
      boxGeom.attributes[a].needsUpdate = true;
    }
  }
  writeBoxes();

  // -- pulses ----------------------------------------------------------------
  const MAX_PULSES = 2600;
  const ppos = new Float32Array(MAX_PULSES * 3);
  const ptint = new Float32Array(MAX_PULSES * 3);
  const psize = new Float32Array(MAX_PULSES);
  const palpha = new Float32Array(MAX_PULSES);
  const pshape = new Float32Array(MAX_PULSES).fill(6);
  const pulseGeom = new BufferGeometry();
  pulseGeom.setAttribute('position', new BufferAttribute(ppos, 3));
  pulseGeom.setAttribute('tint', new BufferAttribute(ptint, 3));
  pulseGeom.setAttribute('size', new BufferAttribute(psize, 1));
  pulseGeom.setAttribute('alpha', new BufferAttribute(palpha, 1));
  pulseGeom.setAttribute('shape', new BufferAttribute(pshape, 1));
  const pulseMat = new ShaderMaterial({
    uniforms: { uPxPerWorld: nodeMat.uniforms.uPxPerWorld },
    vertexShader: NODE_VERT,
    fragmentShader: NODE_FRAG,
    transparent: true,
    depthWrite: false,
  });
  const pulses = new Points(pulseGeom, pulseMat);
  pulses.frustumCulled = false;
  pulses.renderOrder = 5;
  scene.add(pulses);

  // -- camera ----------------------------------------------------------------
  //
  // Pan and zoom only: rotating a containment diagram would defeat the point of
  // having one. Zoom is a half-height in world units; the frustum is rebuilt
  // from it and the canvas aspect.

  let canvasW = 1;
  let canvasH = 1;
  const cam = { x: 0, y: 0, halfH: 1400 };
  const goal = { x: 0, y: 0, halfH: 1400 };
  let easing = false;

  function applyCamera(): void {
    const aspect = canvasW / Math.max(1, canvasH);
    // The frustum is symmetric about the camera and the camera carries the pan.
    // Putting the pan in both places offsets the view twice.
    camera.left = -cam.halfH * aspect;
    camera.right = cam.halfH * aspect;
    camera.top = cam.halfH;
    camera.bottom = -cam.halfH;
    camera.position.set(cam.x, cam.y, 500);
    camera.updateProjectionMatrix();
    const pxPerWorld = (canvasH * renderer.getPixelRatio()) / (cam.halfH * 2);
    nodeMat.uniforms.uPxPerWorld.value = pxPerWorld;
    boxMat.uniforms.uPxPerWorld.value = pxPerWorld;
  }

  function bounds(ids?: Set<string>): { cx: number; cy: number; w: number; h: number } | null {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let seen = 0;
    for (const n of nodes) {
      if (ids && !ids.has(n.id)) continue;
      const [x, y] = at(n);
      const r = nodeRadius(n);
      minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
      minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
      seen++;
    }
    // Boxes that still hold something visible must fit too, or filtering to one
    // group frames the nodes and clips the border around them.
    for (const g of shownBoxes) {
      if (ids && !nodes.some((n) => ids.has(n.id) && inBox(n, g))) continue;
      minX = Math.min(minX, g.x - g.w / 2); maxX = Math.max(maxX, g.x + g.w / 2);
      minY = Math.min(minY, g.y - g.h / 2); maxY = Math.max(maxY, g.y + g.h / 2);
    }
    if (!seen) return null;
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
  }

  function inBox(n: GraphNode, g: Group): boolean {
    const [x, y] = at(n);
    return Math.abs(x - g.x) <= g.w / 2 && Math.abs(y - g.y) <= g.h / 2;
  }

  /**
   * Fit a rectangle of content into the strip of canvas the chrome leaves open,
   * then offset the camera so the content sits in that strip rather than behind
   * a panel. The orthographic equivalent of the 3D view's frameSphere.
   */
  function frameRect(b: { cx: number; cy: number; w: number; h: number }, vp: { left: number; right: number; bottom: number }): void {
    const availW = Math.max(200, canvasW - vp.left - vp.right);
    const availH = Math.max(200, canvasH - vp.bottom);
    const worldPerPxW = (b.w + FRAME_PAD * 2) / availW;
    const worldPerPxH = (b.h + FRAME_PAD * 2 + FRAME_TOP_PAD) / availH;
    const worldPerPx = Math.max(worldPerPxW, worldPerPxH);

    goal.halfH = Math.max(60, (worldPerPx * canvasH) / 2);
    // Centre of the open strip, as an offset from the canvas centre in pixels.
    const dx = vp.left + availW / 2 - canvasW / 2;
    const dy = availH / 2 - canvasH / 2;
    goal.x = b.cx - dx * worldPerPx;
    // Half the extra headroom is above, so the shift is half of it.
    goal.y = b.cy + dy * worldPerPx + (FRAME_TOP_PAD * worldPerPx) / 2;
    easing = true;
  }

  function screenToWorld(px: number, py: number): [number, number] {
    const aspect = canvasW / Math.max(1, canvasH);
    const halfW = cam.halfH * aspect;
    return [
      cam.x + (px / canvasW - 0.5) * halfW * 2,
      cam.y - (py / canvasH - 0.5) * cam.halfH * 2,
    ];
  }

  applyCamera();

  return {
    renderer,
    camera,
    scene,
    nodes,
    boxes: () => shownBoxes,
    grouping: () => key,
    setGrouping(next) {
      if (next === key || !groupings[next]) return;
      key = next;
      nodes.forEach((n, i) => {
        const [x, y] = at(n);
        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
      });
      nodeGeom.attributes.position.needsUpdate = true;
      // Membership first: an edge cannot be routed until it knows which boxes
      // its ends now sit in.
      computeMembership();
      routes = graph.routes?.[key] ?? {};
      rebuildPairIds();
      writeEdgePositions();
      edgeGeom.setPositions(epos);
      dimEdgeGeom.setPositions(epos);
      dimEdgeGeom.setColors(dimCol);
      edgeGeom.setColors(shownCol);
      glowGeom.setPositions(epos);
      glowGeom.setColors(glowCol);
      writeBoxes();
      hlMesh.visible = false;
    },
    positionOf(n) {
      const [x, y] = at(n);
      return new Vector3(x, y, 2);
    },
    curveAt,
    pathOf: (e) => pathFor(e.id, e.source, e.target),
    sameBox(e) {
      const a = boxOf.get(e.source);
      // Two ungrouped nodes are not "in the same box", they are in no box.
      return a !== undefined && a === boxOf.get(e.target);
    },
    pxPerWorld: () => nodeMat.uniforms.uPxPerWorld.value / renderer.getPixelRatio(),
    setNodeAlpha(fn) {
      // Each node lands in exactly one of the two passes. Below the cut it is
      // context and goes behind the glass; above it, it is what you are reading.
      let any = false;
      for (let i = 0; i < count; i++) {
        const a = fn(nodes[i], i);
        const live = !isContext(a);
        const mag = Math.abs(a);
        alpha[i] = live ? mag : 0;
        // Lift the dimmed ones back up: blurring spreads their light out, so
        // the alpha that read as "faint" when sharp reads as nothing at all.
        dimAlpha[i] = live ? 0 : Math.min(1, mag * FROST_LIFT_NODE);
        if (!live && mag > 0) any = true;
      }
      nodeGeom.attributes.alpha.needsUpdate = true;
      dimNodeGeom.attributes.alpha.needsUpdate = true;
      frostNodes = any;
    },
    setNodeSize(fn) {
      for (let i = 0; i < count; i++) size[i] = fn(nodes[i], i);
      nodeGeom.attributes.size.needsUpdate = true;
    },
    setNodeTint(fn) {
      for (let i = 0; i < count; i++) {
        c.set(fn(nodes[i], i));
        tint.set([c.r, c.g, c.b], i * 3);
      }
      nodeGeom.attributes.tint.needsUpdate = true;
    },
    setEdgeAlpha(fn) {
      let any = false;
      // Additive blending means scaling the colour is the same as scaling
      // alpha, so visibility rides the colour buffer and stays one draw call.
      for (let i = 0; i < drawable.length; i++) {
        const a = fn(drawable[i], i);
        const live = !isContext(a);
        const mag = Math.abs(a);
        const { start, count } = spans[i];
        for (let k = start * 6; k < (start + count) * 6; k++) {
          shownCol[k] = live ? baseCol[k] * mag : 0;
          glowCol[k] = live ? baseCol[k] * mag : 0;
          dimCol[k] = live ? 0 : baseCol[k] * Math.min(1, mag * FROST_LIFT);
        }
        if (!live && mag > 0) any = true;
      }
      frostEdges = any;
      edgeGeom.setColors(shownCol);
      glowGeom.setColors(glowCol);
      dimEdgeGeom.setColors(dimCol);
    },
    setHighlight(list) {
      if (!list.length) {
        hlMesh.visible = false;
        return;
      }
      // Highlights take the same route the edge is drawn on. Anything else
      // would cut across the channel the eye is already following.
      const paths = list.map((e) => pathFor(pairEdge.get(`${e.source}|${e.target}`)?.id ?? '', e.source, e.target));
      const total = paths.reduce((n, path) => n + (path ? path.length - 1 : 0), 0);
      const p = new Float32Array(total * 6);
      const col = new Float32Array(total * 6);
      let at = 0;
      paths.forEach((path, i) => {
        if (!path) return;
        c.set(LAYER_COLOR[list[i].layer]);
        for (let s = 0; s < path.length - 1; s++) {
          const o = at * 6;
          p[o] = path[s][0];
          p[o + 1] = path[s][1];
          p[o + 2] = 3;
          p[o + 3] = path[s + 1][0];
          p[o + 4] = path[s + 1][1];
          p[o + 5] = 3;
          col.set([c.r, c.g, c.b, c.r, c.g, c.b], o);
          at++;
        }
      });
      hlGeom.setPositions(p);
      hlGeom.setColors(col);
      hlMesh.visible = true;
    },
    setPulses(list) {
      const n = Math.min(list.length, MAX_PULSES);
      for (let i = 0; i < MAX_PULSES; i++) {
        if (i < n) {
          const p = list[i];
          ppos.set([p.pos.x, p.pos.y, 4], i * 3);
          c.set(p.color);
          ptint.set([c.r, c.g, c.b], i * 3);
          // Sized in SCREEN pixels, unlike everything else here. A pulse is a
          // moving marker, not a thing in the diagram, and at world size it
          // shrank to the six-pixel floor whenever you were zoomed out far
          // enough to see a whole flow — which is exactly when you need it.
          const px = 10 + p.strength * 11;
          psize[i] = px / Math.max(0.0001, nodeMat.uniforms.uPxPerWorld.value);
          palpha[i] = Math.min(1, 0.45 + p.strength * 0.75);
        } else palpha[i] = 0;
      }
      for (const a of ['position', 'tint', 'size', 'alpha']) pulseGeom.attributes[a].needsUpdate = true;
    },
    setBoxAlpha(fn) {
      let any = false;
      shownBoxes.forEach((g, i) => {
        const a = fn(g, boxMembers[i] ?? []);
        const live = !isContext(a);
        const mag = Math.abs(a);
        for (let k = 0; k < 6; k++) {
          balpha[i * 6 + k] = live ? mag : 0;
          dimBoxAlpha[i * 6 + k] = live ? 0 : Math.min(1, mag * FROST_LIFT);
        }
        if (!live && mag > 0) any = true;
      });
      frostBoxes = any;
      boxGeom.attributes.alpha.needsUpdate = true;
      dimBoxGeom.attributes.alpha.needsUpdate = true;
    },
    setEdgeWidth(px) {
      edgeMat.linewidth = px;
      glowMat.linewidth = px * 3.75;
      hlMat.linewidth = px * 2.3;
    },
    setResolution(w, h) {
      edgeMat.resolution.set(w, h);
      glowMat.resolution.set(w, h);
      hlMat.resolution.set(w, h);
    },
    setAspect(w, h) {
      canvasW = w;
      canvasH = h;
      applyCamera();
    },
    frameIds(ids, vp) {
      const b = bounds(ids.size ? ids : undefined);
      if (b) frameRect(b, vp);
    },
    frameAll() {
      const b = bounds();
      if (b) frameRect(b, { left: 0, right: 0, bottom: 0 });
    },
    focusNode(n) {
      const [x, y] = at(n);
      goal.x = x;
      goal.y = y;
      goal.halfH = Math.min(cam.halfH, 520);
      easing = true;
    },
    tick(dtMs) {
      if (!easing) return;
      // Frame-rate independent ease, same feel as the 3D fly-to.
      const k = 1 - Math.pow(0.0022, dtMs / 1000);
      cam.x += (goal.x - cam.x) * k;
      cam.y += (goal.y - cam.y) * k;
      cam.halfH += (goal.halfH - cam.halfH) * k;
      if (Math.abs(goal.x - cam.x) < 0.4 && Math.abs(goal.y - cam.y) < 0.4 && Math.abs(goal.halfH - cam.halfH) < 0.4) {
        cam.x = goal.x;
        cam.y = goal.y;
        cam.halfH = goal.halfH;
        easing = false;
      }
      applyCamera();
    },
    moving: () => easing,
    render(nowMs = 0) {
      const u = bgMat.uniforms;
      u.uTime.value = reduceMotion ? 0 : nowMs / 1000;
      u.uAspect.value = canvasW / Math.max(1, canvasH);
      // Panning slides the field with the diagram, and zooming pulls it closer,
      // exactly as orbiting and dollying do in the 3D view.
      const rel = Math.min(4, Math.max(0.22, cam.halfH / 1400));
      u.uZoom.value = Math.pow(rel, 0.35);
      u.uDrift.value = { x: -cam.x * 0.00045, y: -cam.y * 0.00045 };

      // The near veil answers to panning and zooming much more than the far
      // field does; that difference is what sells the depth.
      fgMat.uniforms.uTime.value = u.uTime.value;
      fgMat.uniforms.uAspect.value = u.uAspect.value;
      fgMat.uniforms.uZoom.value = Math.pow(rel, 0.72);
      fgMat.uniforms.uDrift.value = { x: -cam.x * 0.0013, y: -cam.y * 0.0013 };

      renderer.autoClear = false;

      // Everything filtered out goes through the glass: drawn small, blurred
      // twice at right angles, then laid down under the live diagram.
      const dpr = renderer.getPixelRatio();
      const fw = Math.max(1, Math.round(canvasW * dpr * FROST_SCALE));
      const fh = Math.max(1, Math.round(canvasH * dpr * FROST_SCALE));
      if (rtA.width !== fw || rtA.height !== fh) {
        rtA.setSize(fw, fh);
        rtB.setSize(fw, fh);
      }

      const frosted = frostNodes || frostEdges || frostBoxes;

      if (frosted) {
      renderer.setRenderTarget(rtA);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(dimScene, camera);

      blurMat.uniforms.uTex.value = rtA.texture;
      blurMat.uniforms.uStep.value.set(1 / fw, 0);
      renderer.setRenderTarget(rtB);
      renderer.clear();
      renderer.render(blurScene, bgCam);

      blurMat.uniforms.uTex.value = rtB.texture;
      blurMat.uniforms.uStep.value.set(0, 1 / fh);
      renderer.setRenderTarget(rtA);
      renderer.clear();
      renderer.render(blurScene, bgCam);

      }

      renderer.setRenderTarget(null);
      renderer.setClearColor(BG, 1);
      renderer.clear();
      renderer.render(bgScene, bgCam);    // behind
      if (frosted) {
        frostMat.uniforms.uTex.value = rtA.texture;
        renderer.render(frostScene, bgCam); // the graph behind glass
      }
      renderer.render(scene, camera);     // the diagram you are reading
      renderer.render(fgScene, bgCam);    // a thin veil in front
    },
    attachControls(el, onChange) {
      let dragging = false;
      let lastX = 0;
      let lastY = 0;

      const down = (ev: PointerEvent) => {
        if (ev.button !== 0 && ev.button !== 2) return;
        dragging = true;
        lastX = ev.clientX;
        lastY = ev.clientY;
        el.setPointerCapture(ev.pointerId);
      };
      const move = (ev: PointerEvent) => {
        if (!dragging) return;
        const worldPerPx = (cam.halfH * 2) / Math.max(1, canvasH);
        cam.x -= (ev.clientX - lastX) * worldPerPx;
        cam.y += (ev.clientY - lastY) * worldPerPx;
        lastX = ev.clientX;
        lastY = ev.clientY;
        goal.x = cam.x;
        goal.y = cam.y;
        goal.halfH = cam.halfH;
        easing = false;
        applyCamera();
        onChange();
      };
      const up = (ev: PointerEvent) => {
        dragging = false;
        if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      };
      const wheel = (ev: WheelEvent) => {
        ev.preventDefault();
        const rect = el.getBoundingClientRect();
        // Zoom about the cursor: the world point under it must not move.
        const [wx, wy] = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
        const factor = Math.exp(ev.deltaY * 0.0014);
        const next = Math.min(4200, Math.max(70, cam.halfH * factor));
        const ratio = next / cam.halfH;
        cam.x = wx + (cam.x - wx) * ratio;
        cam.y = wy + (cam.y - wy) * ratio;
        cam.halfH = next;
        goal.x = cam.x;
        goal.y = cam.y;
        goal.halfH = cam.halfH;
        easing = false;
        applyCamera();
        onChange();
      };

      el.addEventListener('pointerdown', down);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('wheel', wheel, { passive: false });
      return () => {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.removeEventListener('wheel', wheel);
      };
    },
  };
}
