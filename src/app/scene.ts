// WebGL layer: one draw call for every node, one for every edge.
//
// Positions are precomputed by the generator, so nothing simulates at runtime.
// Toggling a layer rewrites an alpha attribute in place rather than rebuilding
// geometry, which keeps filtering instant even on the full graph.

import {
  AdditiveBlending,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// Plain GL lines are clamped to 1px by the driver, so edges are drawn as
// screen-space quads instead — that is the only way to get real thickness.
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Graph, GraphEdge, GraphNode, GroupKey, Layer, Plane } from '../model/types.ts';
import { TARGET_SHELL_RADIUS } from '../model/types.ts';

/**
 * Layers dense enough that an additive halo per edge would blow the field out
 * behind the labels. They still draw the crisp line, just no glow.
 */
const GLOWLESS = new Set<Layer>(['shared-deps', 'advisory']);

export const LAYER_COLOR: Record<Layer, string> = {
  network: '#58CBFF',
  queue: '#FFB765',
  data: '#C39BFF',
  build: '#6F8598',
  delivery: '#FF7189',
  'shared-deps': '#7FD44C',
  advisory: '#FF5FA2',
};

/** Plane colors, from the config embedded in the page (setPlaneColors before the first draw). */
export const PLANE_COLOR: Record<Plane, string> = {};
export function setPlaneColors(colors: Record<Plane, string>): void {
  for (const [k, v] of Object.entries(colors)) PLANE_COLOR[k] = v;
}

/** Non-component nodes read as infrastructure regardless of plane. */
export function nodeColor(n: GraphNode): string {
  if (n.kind === 'queue') return '#FFB765';
  if (n.kind === 'broker') return '#FFCE96';
  if (n.kind === 'store') return '#C39BFF';
  if (n.kind === 'external' || n.kind === 'registry') return '#93A6B6';
  if (n.kind === 'env' || n.kind === 'outlet') return '#FF7189';
  if (n.kind === 'machine') return '#9FB2C1';
  return PLANE_COLOR[n.plane] ?? '#8496A4';
}

/** 0 hexagon · 1 square · 2 diamond · 3 ring · 4 small disc · 5 hollow square */
export function nodeShape(n: GraphNode): number {
  switch (n.kind) {
    case 'store':
      return 1;
    case 'machine':
      return 5;
    case 'queue':
    case 'broker':
      return 2;
    case 'external':
    case 'registry':
    case 'env':
    case 'outlet':
      return 3;
    case 'library':
      return 4;
    default:
      // Our own services get the most distinctive mark on the board.
      return 0;
  }
}

export function nodeRadius(n: GraphNode, degree = n.degree ?? 0): number {
  const base =
    n.kind === 'component' ? 11 :
    n.kind === 'library' ? 7.5 :
    n.kind === 'queue' ? 11 :
    n.kind === 'broker' ? 14 :
    n.kind === 'store' ? 13 :
    n.kind === 'env' || n.kind === 'outlet' ? 16 :
    n.kind === 'machine' ? 12 : 9.5;
  // How connected a thing is should be legible at a glance: the central API and
  // the engine ought to look like hubs before you read a single label.
  return base + Math.min(36, Math.sqrt(degree) * 5.6);
}

const NODE_VERT = `
  attribute float size;
  attribute float alpha;
  attribute vec3 tint;
  attribute float shape;
  uniform float uScale;
  uniform float uMinSize;
  varying float vAlpha;
  varying vec3 vTint;
  varying float vShape;
  void main() {
    vAlpha = alpha;
    vTint = tint;
    vShape = shape;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // uScale is (viewportHeight / 2) / tan(fov / 2): a node keeps its apparent
    // size instead of collapsing to a speck when the camera pulls back.
    gl_PointSize = clamp(size * (uScale / -mv.z), uMinSize, 220.0);
    gl_Position = projectionMatrix * mv;
  }
`;

// A soft radial falloff plus a brighter core: reads as a glowing body without
// the cost of a post-processing bloom pass.
const NODE_FRAG = `
  varying float vAlpha;
  varying vec3 vTint;
  varying float vShape;

  float hexDist(vec2 p) {
    p = abs(p);
    return max(p.x * 0.8660254 + p.y * 0.5, p.y);
  }

  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d;
    if (vShape < 0.5)      d = hexDist(p * 2.0);              // hexagon: our service
    else if (vShape < 1.5) d = max(abs(p.x), abs(p.y)) * 2.0; // square: a store
    else if (vShape < 2.5) d = (abs(p.x) + abs(p.y)) * 2.0;   // diamond: a conduit
    else if (vShape < 4.5) d = length(p) * 2.0;               // ring / small disc
    else if (vShape > 5.5) d = length(p) * 2.0;               // pulse
    else                   d = max(abs(p.x), abs(p.y)) * 2.0; // hollow square: a machine
    if (d > 1.0) discard;

    float halo = pow(1.0 - d, 2.4);
    float core = smoothstep(0.55, 0.0, d);
    float white = 0.5;

    if (vShape > 2.5 && vShape < 3.5) {
      float band = smoothstep(0.34, 0.6, d) * smoothstep(1.0, 0.72, d);
      halo = band * 1.5;
      core = band * 0.45;
    } else if (vShape > 3.5 && vShape < 4.5) {
      halo = pow(1.0 - d, 5.0) * 0.7;
      core = smoothstep(0.4, 0.0, d);
    } else if (vShape > 5.5) {
      // travelling pulse: bright enough to read against a lit edge
      halo = pow(1.0 - d, 1.5) * 1.35;
      core = smoothstep(0.8, 0.0, d);
      white = 0.85;
    } else if (vShape > 4.5) {
      float band = smoothstep(0.55, 0.78, d) * smoothstep(1.0, 0.86, d);
      halo = band * 1.6;
      core = band * 0.5;
    } else if (vShape < 0.5) {
      // A bright rim on the hexagon so a service reads as a built unit,
      // not an undifferentiated glow.
      float rim = smoothstep(0.62, 0.9, d) * smoothstep(1.0, 0.9, d);
      core = max(core * 0.75, rim * 1.15);
      halo = halo * 0.85;
    }

    vec3 c = mix(vTint, vec3(1.0), core * white);
    gl_FragColor = vec4(c, (halo * 0.85 + core * 0.95) * vAlpha);
  }
`;


// Ambient depth behind the graph. Deliberately smooth and very low contrast:
// no discrete specks, because a bright point in the background reads as a node.
export const BG_FRAG = `
  uniform float uTime;
  uniform float uAspect;
  uniform vec2 uDrift;
  uniform float uZoom;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  // Rare, slow blooms in the deep field. Large and soft, so they can never be
  // mistaken for a node: a node is small, sharp-edged and stationary.
  float novas(vec2 uv, float t) {
    float acc = 0.0;
    for (int i = 0; i < 2; i++) {
      float fi = float(i);
      float cycle = 23.0 + fi * 9.0;
      float k = floor(t / cycle + fi * 0.5);
      float local = fract(t / cycle + fi * 0.5);
      vec2 c = vec2(hash(vec2(k, fi + 2.0)) * 2.6 - 1.3, hash(vec2(fi + 5.0, k)) * 1.8 - 0.9);
      float r = length(uv - c);
      float life = smoothstep(0.0, 0.10, local) * smoothstep(1.0, 0.45, local);
      float ring = exp(-pow((r - local * 0.55) * 14.0, 2.0));
      float core = exp(-r * 16.0) * (1.0 - local);
      acc += (ring * 0.45 + core * 0.8) * life;
    }
    return acc;
  }

  // A ship crossing the deep field, now and then.
  //
  // Deliberately tiny and far: two pixels of hull and a flare behind it. Big
  // enough to notice on a long look, never big enough to be mistaken for
  // something on the map. It crosses on its own long cycle, mostly absent.
  vec3 ship(vec2 uv, float t) {
    // Coprime periods keep the two from settling into a shared rhythm, but they
    // still both start at t = 0 — so the first crossings coincided, which reads
    // as one timer. An arbitrary phase on each pulls them apart from the start.
    float cycle = 47.0;
    float phase = 0.19;
    float k = floor(t / cycle + phase);
    float local = fract(t / cycle + phase);
    // Most of the cycle is empty sky; the crossing is a short window in it.
    float pass = smoothstep(0.62, 0.68, local) * smoothstep(0.94, 0.88, local);
    if (pass <= 0.001) return vec3(0.0);

    // Entry and exit are picked independently, so the crossing is a slanted
    // chord rather than a horizontal wipe, with a slow arc bowed off the
    // straight line between them. A ship travelling dead level reads as a
    // scrolling texture; a ship on a course reads as a ship.
    float travel = (local - 0.62) / 0.32;
    vec2 a = vec2(mix(-2.1, 2.1, step(0.5, hash(vec2(k, 3.0)))), (hash(vec2(k, 7.0)) - 0.5) * 2.0);
    vec2 b = vec2(-a.x, (hash(vec2(k, 11.0)) - 0.5) * 2.0);
    vec2 straight = mix(a, b, travel);
    vec2 axis = normalize(b - a);
    vec2 normalAxis = vec2(-axis.y, axis.x);
    float bow = (hash(vec2(k, 13.0)) - 0.5) * 0.9;
    vec2 p = straight + normalAxis * bow * sin(travel * 3.14159);

    // Heading is the tangent of that arc, so the flare always trails correctly.
    vec2 heading = normalize(axis + normalAxis * bow * 3.14159 * cos(travel * 3.14159) * 0.35);

    vec2 d = uv - p;
    // The hull: a hard little point.
    float hull = exp(-dot(d, d) * 9000.0);
    // The flare: a tail streaming off the back along the heading, tapering as it
    // goes. Working in the ship's own frame keeps it behind the hull whatever
    // direction the course happens to run.
    float behind = -dot(d, heading);
    float across = dot(d, vec2(-heading.y, heading.x));
    float along = clamp(behind / 0.085, 0.0, 1.0);
    float flare = exp(-(behind * behind + across * across * 36.0) * 900.0)
                * (1.0 - along) * step(0.0, behind);

    vec3 col = vec3(0.85, 0.92, 1.0) * hull * 1.4;
    col += mix(vec3(1.0, 0.72, 0.35), vec3(0.55, 0.75, 1.0), along) * flare * 0.9;
    return col * pass;
  }

  // A satellite train, on its own much longer cycle than the ship.
  //
  // The opposite character deliberately: no flare, no manoeuvre, a dead-straight
  // track and a string of identical points at even spacing, all moving as one.
  // A ship is going somewhere; these are just passing over.
  vec3 train(vec2 uv, float t) {
    float cycle = 71.0;
    float phase = 0.63;
    float k = floor(t / cycle + phase);
    float local = fract(t / cycle + phase);
    float pass = smoothstep(0.30, 0.34, local) * smoothstep(0.58, 0.52, local);
    if (pass <= 0.001) return vec3(0.0);

    // One straight chord, shallow rather than level, reseeded each pass.
    float ang = (hash(vec2(k, 17.0)) - 0.5) * 1.1 + (hash(vec2(k, 19.0)) > 0.5 ? 3.14159 : 0.0);
    vec2 dir = vec2(cos(ang), sin(ang) * 0.42);
    vec2 mid = vec2(0.0, (hash(vec2(k, 23.0)) - 0.5) * 1.4);
    float travel = (local - 0.30) / 0.28;

    float acc = 0.0;
    for (int i = 0; i < 9; i++) {
      // Each follows the one ahead down the same track, a fixed gap behind.
      float lead = travel - float(i) * 0.055;
      if (lead < 0.0 || lead > 1.0) continue;
      vec2 p = mid + dir * mix(-2.4, 2.4, lead);
      vec2 d = uv - p;
      // Ends of the train fade, so it enters and leaves rather than snapping on.
      float ends = smoothstep(0.0, 0.12, lead) * smoothstep(1.0, 0.88, lead);
      acc += exp(-dot(d, d) * 46000.0) * ends;
    }
    return vec3(0.78, 0.86, 0.98) * acc * pass * 0.42;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0) * (2.2 * uZoom) + uDrift;
    float n = fbm(uv + vec2(uTime * 0.055, uTime * 0.022));
    float m = fbm(uv * 0.55 + vec2(3.2, 1.7) + n * 0.45 - vec2(uTime * 0.038, uTime * 0.013));

    // Two overlapping fronts keep it from looking like a single tiling texture.
    float cloud = smoothstep(0.34, 1.0, n * 0.62 + m * 0.58);
    float deep = smoothstep(0.25, 0.95, fbm(uv * 0.28 - 7.0 + uTime * 0.018));
    vec3 cool = vec3(0.10, 0.215, 0.325);
    vec3 warm = vec3(0.175, 0.105, 0.285);
    vec3 col = vec3(0.039, 0.059, 0.086) + mix(cool, warm, m) * cloud * 1.45 + cool * deep * 0.5;

    col += vec3(0.42, 0.30, 0.62) * novas(uv, uTime) * 0.16;
    col += ship(uv, uTime);
    col += train(uv, uTime);

    // A slight vignette pushes attention back to the middle of the field.
    float d = length(vUv - 0.5);
    col *= 1.0 - d * 0.45;
    gl_FragColor = vec4(col, 1.0);
  }
`;


export /**
 * A group as a force field: a translucent shell that is invisible where it faces
 * you and bright where it turns away, so it reads as a volume you are looking
 * INTO rather than a ball sitting in front of the graph.
 *
 * The 3D map has no boxes to draw — depth already does that job — so containment
 * here is a region of space rather than a rectangle. A sphere is also honest
 * about the layout: these positions come from a force simulation, so a plane is
 * a soft cloud with a centre and a spread, not a crisp boundary.
 */
const FIELD_VERT = `
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vObj;
  void main() {
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-mv.xyz);
    // The direction in the sphere's OWN space. The sparkle has to be keyed off
    // this rather than the view-space normal, or every grain slides across the
    // skin as you orbit instead of sitting on it.
    vObj = normalize(position);
    gl_Position = projectionMatrix * mv;
  }
`;

const FIELD_FRAG = `
  precision highp float;
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uTime;
  /** xyz: where something struck, in the shell's own space. w: when. */
  uniform vec4 uImpact;
  /** When the shell took the hit that finished it. 0 while it is still alive. */
  uniform float uDead;
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vObj;

  float hash31(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
  }

  /** Value noise on a lattice: smooth, cheap, and enough to build filaments from. */
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(i);
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }

  /**
   * Ridged noise: the CREASE of a noise field rather than its peaks.
   *
   * Folding the field about its midline with 1 - abs(2n - 1) means that wherever
   * the noise crosses one half it makes a sharp edge; raising that to a power
   * thins the edge into a filament. Three octaves, each finer and fainter, give
   * a vein that branches, which is the whole reason an arc looks electric rather
   * than like a drawn line.
   */
  float filaments(vec3 p) {
    float v = 0.0;
    float a = 1.0;
    for (int i = 0; i < 3; i++) {
      v += a * pow(1.0 - abs(vnoise(p) * 2.0 - 1.0), 7.0);
      p = p * 2.03 + 11.7;
      a *= 0.55;
    }
    return v;
  }

  void main() {
    if (uAlpha <= 0.004) discard;
    vec3 N = normalize(vN);
    vec3 V = normalize(vView);
    float ndv = abs(dot(N, V));
    // Grazing angles glow, head-on is clear. This is what stops nine overlapping
    // spheres turning the middle of the map into fog. Eased from 3.4 to 2.4 so
    // the rim widens into an actual skin rather than a drawn outline — which is
    // most of what makes it read as a bubble.
    float f = pow(1.0 - ndv, 2.4);

    // A key light, fixed in VIEW space so it does not swing around as the map is
    // orbited — the shells should feel lit by the room, not by a lamp bolted to
    // the graph.
    //
    // It rides the skin rather than filling the body. A lit interior would put
    // nine lampshades over the nodes, which is the fog the fresnel exists to
    // prevent; brightening one side and letting the other fall away is what
    // actually reads as a sphere rather than as a circle.
    vec3 L = normalize(vec3(-0.42, 0.78, 0.46));
    float key = 0.42 + 0.58 * (0.5 + 0.5 * dot(N, L));

    // A sheen where the surface faces the light, held to the skin by the same
    // fresnel so it cannot become a hotspot sitting over the nodes.
    float sheen = pow(max(dot(N, L), 0.0), 16.0) * f;

    // Thin-film interference, which is what makes a soap bubble a soap bubble.
    // Light entering the film and light reflecting off it travel different
    // distances, so some wavelength cancels — and WHICH one cancels depends on
    // how far through the film the light went, which is to say on the viewing
    // angle. Hence 1/ndv: the path is longest where the surface turns away.
    //
    // The thickness is not uniform either — a real film pools and drifts — so a
    // slow noise term rides along and the bands crawl instead of sitting in
    // fixed rings.
    float drift = sin(vObj.y * 3.4 + uTime * 0.21) * 0.5 + sin(vObj.x * 2.7 - uTime * 0.17) * 0.5;
    float phase = 1.0 / max(0.22, ndv) * 0.42 + drift * 0.16;
    vec3 iris = 0.5 + 0.5 * cos(6.2831853 * (phase + vec3(0.0, 0.33, 0.67)));
    // Pushed away from grey: the raw palette sits around 0.5 on every channel,
    // and a film that never leaves mid-grey is a film you cannot see.
    iris = clamp((iris - 0.5) * 1.7 + 0.5, 0.0, 1.0);
    // The group's own colour still has to identify the group, so the film tints
    // it rather than replacing it. Two thirds film is where the shells still
    // read as product-green and infra-grey at a glance.
    vec3 skin = mix(uColor, iris, 0.62);

    // Dying is an EVENT, not a state: the shell overloads, discharges
    // everything it has at once, and the electricity drains out of it over the
    // next couple of seconds. A flag that simply switched the filaments off
    // read as the shell breaking rather than as it being killed.
    //
    // And what is left is still a bubble. It keeps its shape, its film and most
    // of its brightness — the group is still there and still means something —
    // it just does not crackle any more. Dimming it to a third made it look
    // like it had gone away, which it has not.
    float dead = 0.0;
    float flare = 0.0;
    if (uDead > 0.0) {
      float da = uTime - uDead;
      dead = smoothstep(0.3, 2.1, da);
      flare = exp(-da * 2.4) * smoothstep(0.0, 0.07, da);
    }
    float grey = dot(skin, vec3(0.33, 0.5, 0.17));
    skin = mix(skin, vec3(grey * 0.95), dead * 0.65);

    // Sparkle: a sparse grid of grains on the surface, each twinkling on its own
    // schedule. Keyed to the OBJECT-space direction so a grain stays where it is
    // while the camera moves, and weighted toward the rim so it reads as
    // something ON the skin rather than dust floating in the volume.
    // The sizzle: branching filaments crawling over the skin, gated so they
    // strike and die rather than sitting there.
    //
    // The domain drifts on all three axes at rates that do not divide into each
    // other, which is what keeps it from looping visibly — a field that repeats
    // stops reading as electricity the moment you notice the repeat.
    vec3 q = vObj * 5.2 + vec3(uTime * 0.13, uTime * -0.09, uTime * 0.17);
    float arc = filaments(q);

    // A separate, much coarser field moving much faster decides WHERE the arcs
    // are alight at any moment. Without it every filament burns steadily and
    // the shell reads as cracked glass instead of as something energised.
    float gate = smoothstep(0.34, 0.72, vnoise(vObj * 2.6 + vec3(0.0, uTime * 1.45, uTime * 0.9)));
    // A fast flicker on top, so a live arc still stutters.
    float flick = 0.62 + 0.38 * vnoise(vObj * 7.0 + vec3(uTime * 6.1, 0.0, 0.0));
    arc = arc * gate * flick;

    // Grain between the arcs: one texture at one frequency reads as a pattern,
    // and the dust is what keeps the filaments looking like discharge rather
    // than like veins on a leaf.
    float r = hash31(floor(vObj * 96.0));
    float dust = smoothstep(0.955, 0.995, r) * (0.5 + 0.5 * sin(uTime * (1.1 + r * 3.4) + r * 51.0));

    // Where something has just burned up against the skin, the field is briefly
    // overloaded: a hot core at the point of contact and a ring of discharge
    // spreading out from it, both dying away.
    //
    // Distance is the straight chord between two points on the unit sphere
    // rather than the arc between them — being exact costs an acos, and over
    // the radius a storm actually reaches the difference is not visible.
    float storm = 0.0;
    float age = uTime - uImpact.w;
    if (uImpact.w > 0.0 && age > 0.0 && age < 5.0) {
      float dist = length(vObj - uImpact.xyz);
      // Two fronts, not one. A single expanding ring reads as a ripple in a
      // pond; a fast thin shock followed by a slower, broader discharge reads
      // as something having gone off.
      float shock = exp(-pow((dist - (0.10 + age * 0.78)) / 0.13, 2.0));
      float wake = exp(-pow((dist - (0.13 + age * 0.40)) / 0.24, 2.0));
      float core = exp(-dist * 4.6) * exp(-age * 2.0);
      storm = (shock * 0.55 + wake * 0.9 + core * 1.25) * exp(-age * 0.62);
    }

    // Weighted toward the rim so it reads as something ON the skin rather than
    // suspended in the volume, but never zero in the middle — a force field
    // crackles where it faces you too.
    // A dead shell keeps its shape and loses everything that made it live: no
    // filaments, no grain, no storms. It is still there, it just does not do
    // anything any more.
    float sizzle = (arc * 1.15 + dust * 0.4) * (0.32 + f)
      * (1.0 + storm * 13.0 * (1.0 - dead))
      * (1.0 - dead)
      * (1.0 + flare * 11.0);

    // The skin under a strike lifts too, not only the filaments on it: a shell
    // that discharges without brightening reads as a decal rather than as the
    // surface being hit.
    float body = f * key * (1.0 + storm * 1.4 * (1.0 - dead)) * (1.0 - dead * 0.15) + flare * f * 0.6;
    // The sizzle is deliberately NOT scaled by uAlpha the way the body is. The
    // shells rest under half opacity, and an arc multiplied down by that as well
    // as by its own falloff lands around 8% — which is to say, not on screen at
    // all. It fades with the shell, just not as steeply.
    float sizzleA = min(0.95, sizzle * 0.5) * sqrt(uAlpha) + storm * 0.34;
    // Arcs run hotter than the film they sit on: white at the core, the group's
    // own colour at the edges, which is how a discharge actually reads.
    vec3 arcColor = mix(skin, vec3(0.90, 0.96, 1.0), 0.72);
    gl_FragColor = vec4(
      skin * body * uAlpha + vec3(0.72, 0.84, 1.0) * sheen * 0.55 * uAlpha + arcColor * sizzleA,
      (body + sheen * 0.4) * uAlpha + sizzleA
    );
  }
`;

export const FG_FRAG = `
  uniform float uTime;
  uniform float uAspect;
  uniform float uZoom;
  uniform vec2 uDrift;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.07; a *= 0.5; }
    return v;
  }

  // Fast, thin streaks that cross the frame occasionally. Movement and the
  // tail are what keep these legible as weather rather than as data.
  float meteors(vec2 uv, float t) {
    float acc = 0.0;
    for (int i = 0; i < 2; i++) {
      float fi = float(i);
      float cycle = 47.0 + fi * 31.0;
      float k = floor(t / cycle + fi * 0.37);
      float local = fract(t / cycle + fi * 0.37);

      vec2 dir = normalize(vec2(-1.0, -0.34 - hash(vec2(k, fi)) * 0.5));
      vec2 start = vec2(1.5, hash(vec2(k + 3.0, fi)) * 1.7 - 0.5);
      vec2 p = start + dir * local * 19.0;

      vec2 d = uv - p;
      float along = dot(d, -dir);
      float perp = length(d + dir * along);
      float tail = exp(-perp * 150.0) * exp(-max(0.0, along) * 9.0) * step(0.0, along);
      float head = exp(-length(d) * 210.0);
      float life = smoothstep(0.0, 0.012, local) * smoothstep(0.16, 0.09, local);
      acc += (tail * 0.75 + head) * life;
    }
    return acc;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0) * (1.5 * uZoom) + uDrift;

    // Two scales drifting against the background at different rates: wispy
    // tendrils over slower, larger masses. That difference is what makes it
    // read as cloud passing in front rather than a tint over the whole page.
    float wisp = fbm(uv * 1.25 + vec2(-uTime * 0.090, uTime * 0.032) + 11.0);
    float mass = fbm(uv * 0.48 + vec2(-uTime * 0.048, uTime * 0.016) + 41.0);
    float veil = smoothstep(0.50, 0.96, wisp) * 0.8 + smoothstep(0.54, 1.02, mass) * 0.6;

    // Thinned toward the centre rather than removed, so the graph you are
    // reading keeps its contrast but is not sitting in a clean bubble.
    float d = length(vUv - 0.5);
    float edge = mix(0.45, 1.0, smoothstep(0.08, 0.66, d));

    vec3 tint = mix(vec3(0.30, 0.52, 0.80), vec3(0.46, 0.40, 0.74), mass);
    vec3 col = tint * veil * edge * 0.17;
    col += vec3(0.72, 0.86, 1.0) * meteors(uv, uTime) * 0.42;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface SceneHandles {
  renderer: WebGLRenderer;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  scene: Scene;
  nodes: GraphNode[];
  setNodeAlpha: (fn: (n: GraphNode, i: number) => number) => void;
  /** Resize nodes — used to scale them by their *visible* connection count. */
  setNodeSize: (fn: (n: GraphNode, i: number) => number) => void;
  /** Recolour every node. Used when a view means something other than plane. */
  setNodeTint: (fn: (n: GraphNode, i: number) => string) => void;
  /**
   * World-space offset the camera carries purely to dodge the HUD panels.
   * Subtracted before the background parallax is computed, so opening a panel
   * slides the graph without dragging the starfield with it.
   */
  setDriftOffset: (x: number, y: number) => void;
  setEdgeAlpha: (fn: (e: GraphEdge, i: number) => number) => void;
  setPulses: (points: Array<{ pos: Vector3; color: string; strength: number }>) => void;
  /** Recompute the point-size scale after a resize. */
  setViewportScale: (heightPx: number) => void;
  /** Edge thickness in screen pixels. */
  setEdgeWidth: (px: number) => void;
  /** Draw these links thicker and on top, for the focused hop or selection. */
  setHighlight: (links: Array<{ source: string; target: string; layer: Layer }>) => void;
  /** LineMaterial needs the drawing-buffer size to size its quads. */
  setResolution: (w: number, h: number) => void;
  frameAll: () => void;
  /** Draws the background field, then the graph. */
  render: (nowMs: number) => void;
  /** The group shells: centre and radius, for labelling them in the DOM. */
  fields: () => Array<{ id: string; centre: Vector3; radius: number; count: number }>;
  /** How strongly each group's force field shows, 0 to hide it. */
  setFieldAlpha: (fn: (id: string, members: GraphNode[]) => number) => void;
  /** Rebuild the shells around a different grouping. */
  setFieldGrouping: (key: GroupKey) => void;
  /**
   * Send a meteor in. With screen coordinates it strikes the shell under them;
   * without, it picks a shell and a point at random. `fromEye` launches it
   * from the camera instead of letting it fall in from the dark.
   */
  strike: (clientX?: number, clientY?: number, fromEye?: boolean) => void;
  /** The polyline an edge is actually drawn as — bundled edges are curves. */
  pathOf: (e: GraphEdge) => Vector3[] | null;
  /** A point along the curve one hop is drawn on, at 0 <= t <= 1. */
  curveAt: (source: string, target: string, t: number) => Vector3 | null;
}

export function buildScene(canvas: HTMLCanvasElement, graph: Graph): SceneHandles {
  const scene = new Scene();
  const camera = new PerspectiveCamera(52, 1, 1, 12000);
  camera.position.set(0, 220, 1750);

  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x0a0f16, 1);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.9;
  controls.minDistance = 90;
  controls.maxDistance = 5200;

  // -- background ------------------------------------------------------------
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
  const driftOffset = { x: 0, y: 0 };

  const nodes = graph.nodes.filter((n) => typeof n.x === 'number');
  const index = new Map(nodes.map((n, i) => [n.id, i]));

  // -- nodes ----------------------------------------------------------------
  const count = nodes.length;
  const pos = new Float32Array(count * 3);
  const tint = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const alpha = new Float32Array(count).fill(1);
  const shape = new Float32Array(count);
  const c = new Color();

  nodes.forEach((n, i) => {
    pos[i * 3] = n.x!;
    pos[i * 3 + 1] = n.y!;
    pos[i * 3 + 2] = n.z!;
    c.set(nodeColor(n));
    tint[i * 3] = c.r;
    tint[i * 3 + 1] = c.g;
    tint[i * 3 + 2] = c.b;
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
    uniforms: { uScale: { value: 800 }, uMinSize: { value: 11 } },
    vertexShader: NODE_VERT,
    fragmentShader: NODE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  scene.add(new Points(nodeGeom, nodeMat));

  // -- group force fields ----------------------------------------------------
  //
  // One shell per plane, sized to hold most of its members. Most, not all: the
  // radius is a percentile rather than a maximum, because the layout lets hubs
  // wander toward whatever they talk to and a single stray node would inflate a
  // sphere until it swallowed the map.
  // Detail 12, not 4. The fresnel puts all the shell's ink on a rim about a
  // pixel wide, and at detail 4 a silhouette chord bulges ~1.6px off the true
  // circle at the size these are drawn — so the outline read as a polygon. This
  // is 3380 triangles against 500, which is nothing across nine shells, and
  // takes the error under a quarter pixel.
  const fieldGeom = new IcosahedronGeometry(1, 12);
  const fieldGroup = new Group();
  scene.add(fieldGroup);
  let fields: Array<{ id: string; centre: Vector3; radius: number; mesh: Mesh; members: GraphNode[] }> = [];
  /**
   * Which grouping the shells currently describe. Edge bundling reads it too:
   * the trunk an edge leans into is the channel between the two shells its ends
   * sit in, so the two must be answering the same question.
   */
  let groupKey: GroupKey = 'plane';
  const fieldById = new Map<string, { centre: Vector3; radius: number }>();
  /**
   * Direct hits taken from meteors the user launched, per group.
   *
   * Only the ones asked for. Weather does not wear a shell out, or one left open
   * long enough would go dark on its own and read as a rendering fault.
   */
  const hitsTaken = new Map<string, number>();
  const deadShells = new Set<string>();
  /** How many it takes. */
  const SHELL_HP = 20;

  /**
   * Rebuild the shells for a grouping. Cheap: a handful of spheres.
   *
   * PLANE ONLY, and that is a statement about the data rather than a shortcut.
   * The 3D layout anchors planes apart, so a plane is a PLACE: a shell around
   * one encloses something, and the corridor between two of them crosses a real
   * gap. Every other grouping cuts across the map — services, libraries and
   * registries are scattered through all of it — so its shells come out nearly
   * concentric, which is nine overlapping spheres of fog around a corridor with
   * no gap to cross. Those groupings draw no shells, and their edges take the
   * plain staircase.
   */
  function buildFields(key: GroupKey): void {
    groupKey = key;
    fieldById.clear();
    for (const f of fields) {
      fieldGroup.remove(f.mesh);
      (f.mesh.material as ShaderMaterial).dispose();
    }
    fields = [];
    if (key !== 'plane') return;

    const buckets = new Map<string, GraphNode[]>();
    for (const n of nodes) {
      const g = n.groupOf?.[key];
      if (!g) continue;
      if (!buckets.has(g)) buckets.set(g, []);
      buckets.get(g)!.push(n);
    }

    for (const [id, members] of buckets) {
      // A delivery target is a shell of one: the place it names, not a spread.
      const target = members.every((n) => n.kind === 'outlet');
      if (members.length < 3 && !target) continue;
      const cx = members.reduce((s, n) => s + n.x!, 0) / members.length;
      const cy = members.reduce((s, n) => s + n.y!, 0) / members.length;
      const cz = members.reduce((s, n) => s + n.z!, 0) / members.length;
      // A percentile, not a maximum: the layout lets hubs drift toward whatever
      // they talk to, and one stray member would inflate a shell until it
      // swallowed the map.
      //
      // The 80th, not the 70th. The 70th left 51 of 304 nodes sitting outside
      // their own shell, and disproportionately the HUBS: the secrets store, the
      // CLI and the engine are exactly the nodes you look for inside a group, and
      // exactly the ones the layout drags outward toward everything they talk
      // to. The 80th brings all three in for 34 strays instead of 51, and costs
      // nothing: shell overlap is unchanged at 3 of 36 pairs. Past the 85th it
      // stops being free — the 90th doubles the strays it fixes and takes
      // overlapping pairs from 4 to 12, which is the fog this percentile exists
      // to prevent.
      const spread = members.map((n) => Math.hypot(n.x! - cx, n.y! - cy, n.z! - cz)).sort((a, b) => a - b);
      const radius = target ? TARGET_SHELL_RADIUS : spread[Math.floor(spread.length * 0.8)] * 1.05 + 26;

      c.set(key === 'plane' ? PLANE_COLOR[id as Plane] ?? PLANE_COLOR[members[0].plane] ?? '#8496A4' : '#8FA6B8');
      const mesh = new Mesh(
        fieldGeom,
        new ShaderMaterial({
          uniforms: {
            uColor: { value: new Vector3(c.r, c.g, c.b) },
            uAlpha: { value: 0 },
            uTime: { value: 0 },
            uImpact: { value: new Vector4(0, 1, 0, -1) },
            uDead: { value: deadShells.has(id) ? 1 : 0 },
          },
          vertexShader: FIELD_VERT,
          fragmentShader: FIELD_FRAG,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
          side: DoubleSide,
        }),
      );
      mesh.position.set(cx, cy, cz);
      mesh.scale.setScalar(radius);
      mesh.frustumCulled = false;
      // Behind the graph: a shell is context for the nodes, never over them.
      mesh.renderOrder = -1;
      fieldGroup.add(mesh);
      fields.push({ id, centre: new Vector3(cx, cy, cz), radius, mesh, members });
      fieldById.set(id, { centre: new Vector3(cx, cy, cz), radius });
    }
  }
  buildFields('plane');

  // -- meteors ----------------------------------------------------------------
  //
  // Every so often something falls in out of the dark, burns up against a shell
  // and sets off a small electric storm where it hits. It carries no data and
  // means nothing — it is weather, and its whole job is to make the field feel
  // like a place with an atmosphere rather than a diagram that happens to move.
  //
  // Which is also why it is rare, small, and always aimed at a shell that is
  // actually being drawn: an ambient flourish that pulls the eye off the graph
  // is a bug, not atmosphere.
  // Point sprites, NOT a line.
  //
  // The first version drew the trail as a polyline and it read as a spear:
  // LineMaterial has ONE linewidth for the whole mesh, so a trail built from it
  // is a constant-width rod however its colour tapers, and the rounded cap on
  // every segment doubles against its neighbour under additive blending. A
  // meteor tapers in WIDTH — that is most of what makes it a meteor — and a
  // fading string of soft round sprites gives that for free, with the sprites
  // overlapping into a continuous streak rather than a chain of beads.
  const MAX_METEORS = 6;
  const TRAIL = 48;
  const METEOR_POINTS = MAX_METEORS * TRAIL;
  /**
   * How long the tail is in WORLD units, rather than as a fraction of the
   * flight. The shells differ in size by a factor of three, and a tail measured
   * as a fraction of the approach would be three times longer coming into the
   * big one — same object, different meteor.
   */
  const TAIL_LENGTH = 430;
  interface Meteor {
    field: number;
    from: Vector3;
    to: Vector3;
    /** 0 at the start of the fall, 1 at the moment of contact. */
    t: number;
    rate: number;
    /** The whole approach, in world units, so the tail can be sized against it. */
    span: number;
    /** Asked for, rather than weather. Only these wear a shell down. */
    manual: boolean;
  }
  let meteors: Meteor[] = [];
  let nextFall = 1.6;
  let lastFrame = 0;
  /**
   * The opening few come quickly, then it settles into weather.
   *
   * Something that happens once every fifteen seconds is something most people
   * never learn is there — they look away, it falls, and the page looks static.
   * A short burst up front shows what the thing does; after that, rarity is the
   * whole point.
   */
  let demoLeft = 3;

  const mpos = new Float32Array(METEOR_POINTS * 3);
  const mtint = new Float32Array(METEOR_POINTS * 3);
  const msize = new Float32Array(METEOR_POINTS);
  const malpha = new Float32Array(METEOR_POINTS);
  const meteorGeom = new BufferGeometry();
  meteorGeom.setAttribute('position', new BufferAttribute(mpos, 3));
  meteorGeom.setAttribute('tint', new BufferAttribute(mtint, 3));
  meteorGeom.setAttribute('size', new BufferAttribute(msize, 1));
  meteorGeom.setAttribute('alpha', new BufferAttribute(malpha, 1));
  meteorGeom.setAttribute('shape', new BufferAttribute(new Float32Array(METEOR_POINTS).fill(6), 1));
  // The pulse material: same soft round sprite, and no floor on the size — a
  // tail whose sprites cannot shrink past six pixels does not taper.
  const meteorMat = nodeMat.clone();
  meteorMat.uniforms = { uScale: nodeMat.uniforms.uScale, uMinSize: { value: 0 } };
  const meteorMesh = new Points(meteorGeom, meteorMat);
  meteorMesh.frustumCulled = false;
  meteorMesh.renderOrder = 2;
  scene.add(meteorMesh);

  const scratch = new Vector3();
  const scratchB = new Vector3();

  /** A unit vector with no preferred direction. */
  function randomDirection(out: Vector3): Vector3 {
    // Sampling the z coordinate uniformly and the angle uniformly is what gives
    // an even spread over a sphere; picking two angles crowds the poles.
    const z = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return out.set(Math.cos(a) * r, Math.sin(a) * r, z);
  }

  /**
   * Send one in. With no arguments it picks a shell and a point at random;
   * given a shell and a direction on it, it strikes exactly there.
   */
  function spawnMeteor(target?: { field: (typeof fields)[number]; dir: Vector3 }, fromEye = false, manual = false): void {
    // Only shells that are actually on screen. A storm on an invisible sphere is
    // a bright ring hanging in empty space.
    const lit = fields.filter((f) => (f.mesh.material as ShaderMaterial).uniforms.uAlpha.value > 0.02);
    if (meteors.length >= MAX_METEORS) return;
    if (!target && !lit.length) return;
    const f = target ? target.field : lit[Math.floor(Math.random() * lit.length)];
    const hit = target ? target.dir.clone() : randomDirection(new Vector3());
    // Coming in at a slant rather than straight down the radius: a meteor on a
    // radial approach reads as aimed, and weather is not aimed.
    const approach = randomDirection(new Vector3()).multiplyScalar(1.5).add(hit).normalize();
    const to = hit.clone().multiplyScalar(f.radius).add(f.centre);

    // A requested meteor differs from an ambient one in SPEED, not in where it
    // comes from. Both fall in out of the dark on their own slant; asking for
    // one does not mean asking for it to be launched from your own shoulder,
    // and coming in from the same place every time made them read as fired.
    //
    // Speed is what carries the causality. The first version gave a requested
    // meteor the ambient six-to-eleven second fall, so the click produced
    // nothing and something wandered in from off-screen long after with no
    // visible connection to having asked for it. Arriving inside a second is
    // what makes it yours; the direction it arrives from does not have to.
    const near = target !== undefined;
    let from: Vector3;
    if (fromEye) {
      // Launched rather than fallen: it leaves from in front of you and flies
      // away into the point you picked.
      //
      // The offset has to be small AND well forward, and forward is the part
      // that matters. A sideways offset applied at the camera's own position
      // subtends an enormous angle — the start point is at zero depth, so any
      // lateral distance at all throws it into a corner of the screen, which is
      // where these used to appear. Pushing the start a fifth of the way to the
      // target first means the same offset subtends about twelve degrees, and it
      // leaves from near the middle of the view.
      //
      // Not zero, though: straight down the eyeline it is a dot that grows,
      // which reads as nothing at all.
      const reach = camera.position.distanceTo(to);
      const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      from = camera.position
        .clone()
        .addScaledVector(to.clone().sub(camera.position).normalize(), reach * 0.22)
        .addScaledVector(right, -reach * 0.05)
        .addScaledVector(up, reach * 0.035);
    } else {
      from = approach
        .clone()
        .multiplyScalar(f.radius * (near ? 2.8 : 4.5))
        .add(f.centre);
    }
    // Slow for weather — a streak that crosses the field in a second reads as a
    // glitch, and one you can watch fall reads as sky. Fast when it was asked for.
    const rate = near ? 1.5 + Math.random() * 0.6 : 0.09 + Math.random() * 0.08;
    meteors.push({ field: fields.indexOf(f), to, from, t: 0, rate, span: from.distanceTo(to), manual });
  }

  /**
   * Which shell a screen point is over, and where on it.
   *
   * Solved against the sphere directly rather than through a Raycaster and the
   * icosahedron's 3380 triangles: the shells ARE spheres, the closed form is
   * four lines, and it gives an exact surface point instead of a facet.
   *
   * A miss still strikes something — the shell the ray passes nearest, at its
   * closest point. Aiming at empty space and getting nothing back reads as the
   * gesture being broken rather than as having missed.
   */
  function aimAt(clientX: number, clientY: number): { field: (typeof fields)[number]; dir: Vector3 } | null {
    const lit = fields.filter((f) => (f.mesh.material as ShaderMaterial).uniforms.uAlpha.value > 0.02);
    if (!lit.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const dir = new Vector3(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
      0.5,
    ).unproject(camera).sub(camera.position).normalize();

    let best: { field: (typeof fields)[number]; dir: Vector3 } | null = null;
    let bestKey = Infinity;
    for (const f of lit) {
      const toCentre = scratch.copy(f.centre).sub(camera.position);
      const along = toCentre.dot(dir);
      const perp2 = toCentre.lengthSq() - along * along;
      const r2 = f.radius * f.radius;
      if (perp2 <= r2 && along > 0) {
        // A real hit: the near intersection, which is the face you can see.
        const t = along - Math.sqrt(r2 - perp2);
        // Hits beat near-misses outright, ranked by how close the camera is.
        const key = -1e6 + t;
        if (key < bestKey) {
          bestKey = key;
          best = { field: f, dir: scratchB.copy(camera.position).addScaledVector(dir, t).sub(f.centre).normalize().clone() };
        }
      } else if (bestKey >= 0) {
        const miss = Math.sqrt(Math.max(0, perp2)) - f.radius;
        if (miss < bestKey) {
          bestKey = miss;
          const closest = scratchB.copy(camera.position).addScaledVector(dir, Math.max(0, along));
          best = { field: f, dir: closest.sub(f.centre).normalize().clone() };
        }
      }
    }
    return best;
  }

  function advanceMeteors(dt: number, now: number): void {
    nextFall -= dt;
    if (nextFall <= 0) {
      spawnMeteor();
      // Irregular on purpose. A fixed cadence is a metronome, and a metronome in
      // the corner of the eye is the thing you end up watching.
      if (demoLeft > 0) {
        demoLeft--;
        nextFall = 2.2 + Math.random() * 1.6;
      } else {
        nextFall = 7 + Math.random() * 11;
      }
    }

    let seg = 0;
    const alive: Meteor[] = [];
    for (const m of meteors) {
      m.t += dt * m.rate;
      const f = fields[m.field];
      if (m.t >= 1 || !f) {
        // Contact: hand the shell the point it was struck at, in its OWN space,
        // and let the shader run the storm from there. Nothing about the storm
        // needs the meteor to still exist.
        if (f) {
          const mat = f.mesh.material as ShaderMaterial;
          scratchB.copy(m.to).sub(f.centre).normalize();
          mat.uniforms.uImpact.value.set(scratchB.x, scratchB.y, scratchB.z, now);
          if (m.manual && !deadShells.has(f.id)) {
            const taken = (hitsTaken.get(f.id) ?? 0) + 1;
            hitsTaken.set(f.id, taken);
            if (taken >= SHELL_HP) {
              deadShells.add(f.id);
              // Right now, on the frame it lands: the shader runs the overload
              // from this timestamp, and the storm from the killing blow plays
              // over the top of it.
              mat.uniforms.uDead.value = now;
            }
          }
        }
        continue;
      }
      alive.push(m);

      const step = TAIL_LENGTH / m.span / TRAIL;
      // These have to match the meteors already crossing the background field,
      // because they are the same thing seen closer: cool blue-white rather than
      // ember, a tight head, and a tail that fades out exponentially instead of
      // tapering to a visible end. The background pair are drawn in FG_FRAG with
      // exp(-along * 9) down the tail and vec3(0.72, 0.86, 1.0) for colour; this
      // is the same falloff and the same hue, in geometry rather than in a
      // fragment shader.
      //
      // Only a slight build as it falls. The background ones do not brighten at
      // all — they fade in, cross, and fade out — but these end in an impact,
      // and arriving at the same brightness they set off with reads as a line
      // stopping rather than as something hitting.
      const glow = 0.5 + m.t * m.t * 0.85;
      const heatAt = (k: number) => Math.exp(-(k / TRAIL) * 4.2) * glow;
      // The gap between two sprites is in WORLD units and their size is in
      // SCREEN pixels, so they pull apart as the camera comes in and the streak
      // turns into a string of beads. Sizing each sprite against the gap in
      // pixels is what keeps them overlapping at every zoom: a sprite is never
      // allowed to be smaller than the distance to its neighbour.
      //
      // ALPHA carries the taper, not size. Sprites that shrink to nothing leave
      // gaps at the thin end however bright they are; sprites that hold their
      // size and fade blend into the smooth exponential falloff the background
      // meteors are drawn with, which is the look being matched.
      const perPx = meteorMat.uniforms.uScale.value / Math.max(1, camera.position.distanceTo(m.to));
      const gapPx = (TAIL_LENGTH / TRAIL) * perPx;
      for (let k = 0; k < TRAIL; k++) {
        if (seg >= METEOR_POINTS) break;
        scratch.lerpVectors(m.from, m.to, Math.max(0, m.t - k * step));
        const o = seg * 3;
        mpos[o] = scratch.x; mpos[o + 1] = scratch.y; mpos[o + 2] = scratch.z;
        // One hue the whole way down — the background meteors do not change
        // colour along their length either.
        mtint[o] = 0.74; mtint[o + 1] = 0.88; mtint[o + 2] = 1.0;
        const fade = heatAt(k);
        // Sprite sizes are world units in the attribute and pixels after the
        // vertex shader scales them, so the wanted pixel size divides back out.
        const wantPx = Math.max(gapPx * 2.4, 3 + fade * 13);
        msize[seg] = wantPx / perPx;
        malpha[seg] = fade;
        seg++;
      }
    }
    meteors = alive;
    for (let k = seg; k < METEOR_POINTS; k++) malpha[k] = 0;
    meteorGeom.attributes.position.needsUpdate = true;
    meteorGeom.attributes.tint.needsUpdate = true;
    meteorGeom.attributes.size.needsUpdate = true;
    meteorGeom.attributes.alpha.needsUpdate = true;
  }

  // -- edges ------------------------------------------------------------------
  //
  // Orthogonal routing, the flat view's transit map lifted into three
  // dimensions: axis-aligned runs, right angles, rounded corners, and a shared
  // corridor for every pair of groups so a hundred separate crossings read as
  // one trunk you can count the strands of.
  //
  // The one thing 3D changes is where a corridor can go. A trunk has to be
  // axis-aligned or the right angles are pointless, but the channel between two
  // shells points in an arbitrary direction — so the trunk runs along whichever
  // world axis that channel most nearly follows. In exchange, 3D has TWO
  // perpendicular directions to spread lanes across where the flat view had one,
  // so a corridor is a ribbon rather than a row.
  const drawable = graph.edges.filter((e) => index.has(e.source) && index.has(e.target));

  /**
   * Highlights and flow pulses know a pair of nodes, not an edge id, and an
   * edge id is what picks a lane out of a corridor. First one wins, in both
   * directions: a flow often describes a hop the way round the edge does not.
   */
  const pairEdge = new Map<string, GraphEdge>();
  for (const e of drawable) {
    for (const k of [`${e.source}|${e.target}`, `${e.target}|${e.source}`]) {
      if (!pairEdge.has(k)) pairEdge.set(k, e);
    }
  }

  /**
   * Corridor spacing between neighbouring lanes, and the corner radius. Both in
   * world units; the 3D field is roughly 3000 units across.
   */
  const LANE = 18;
  const CORNER_RADIUS = 34;
  /**
   * Two, not six.
   *
   * Every JOINT between two segments puts two rounded caps on top of each other,
   * and under additive blending that is double brightness at the joint. On a
   * straight run there are no interior joints, so the only place it shows is the
   * corners — which is exactly where six steps were packing seven joints into a
   * few pixels and lighting every inflection point up like a bead.
   *
   * A right angle a few pixels across does not need six segments to read as
   * round. This is the same trap the flat view hit with dense sampling, and the
   * same answer: put geometry only where the eye needs it.
   */
  const CORNER_STEPS = 2;

  /** Which world axis a direction most points along. */
  function dominantAxis(v: Vector3): 0 | 1 | 2 {
    const ax = Math.abs(v.x);
    const ay = Math.abs(v.y);
    const az = Math.abs(v.z);
    return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
  }

  const AXIS = ['x', 'y', 'z'] as const;

  /**
   * The shared corridor for one pair of groups: an axis-aligned line every
   * crossing between those two groups runs along, plus a lane per edge.
   *
   * A corridor has to be axis-aligned or the right angles are pointless, but the
   * channel between two shells points in an arbitrary direction — so the trunk
   * runs along whichever world axis that channel most nearly follows, through
   * the midpoint between the two shells. Edges fan onto it and off it.
   */
  interface Corridor {
    /** The axis the trunk runs along. */
    k: 0 | 1 | 2;
    /** The other two axes, and this edge's lane offset on each. */
    a: 0 | 1 | 2;
    b: 0 | 1 | 2;
    la: number;
    lb: number;
  }
  const corridors = new Map<string, Corridor>();

  /**
   * Lay out the lanes for every group pair that has crossings.
   *
   * Lanes are the whole reason a corridor reads as a corridor: thirty edges on
   * one line are one line, and thirty lines a lane apart are a ribbon you can
   * count. They are packed into a square grid across the two axes the trunk
   * does not use — 3D has two perpendicular directions to spend where the flat
   * view had one.
   */
  function buildCorridors(): void {
    corridors.clear();
    const pairs = new Map<string, GraphEdge[]>();
    for (const e of drawable) {
      const a = nodes[index.get(e.source)!];
      const b = nodes[index.get(e.target)!];
      const ga = a.groupOf?.[groupKey];
      const gb = b.groupOf?.[groupKey];
      if (!ga || !gb || ga === gb) continue;
      if (!fieldById.has(ga) || !fieldById.has(gb)) continue;
      const key = ga < gb ? `${ga}|${gb}` : `${gb}|${ga}`;
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key)!.push(e);
    }

    for (const [key, list] of pairs) {
      const [ga, gb] = key.split('|');
      const fa = fieldById.get(ga)!;
      const fb = fieldById.get(gb)!;
      const k = dominantAxis(fb.centre.clone().sub(fa.centre));
      const a = ((k + 1) % 3) as 0 | 1 | 2;
      const b = ((k + 2) % 3) as 0 | 1 | 2;
      // The trunk sits midway between the two shells on the axes it does not
      // travel along.
      const baseA = (fa.centre[AXIS[a]] + fb.centre[AXIS[a]]) / 2;
      const baseB = (fa.centre[AXIS[b]] + fb.centre[AXIS[b]]) / 2;
      const cols = Math.ceil(Math.sqrt(list.length));
      const rows = Math.ceil(list.length / cols);
      list.forEach((e, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        corridors.set(e.id, {
          k,
          a,
          b,
          la: baseA + (col - (cols - 1) / 2) * LANE,
          lb: baseB + (row - (rows - 1) / 2) * LANE,
        });
      });
    }
  }

  /** Append a move along one axis, skipping it when there is nothing to move. */
  function step(out: Vector3[], axis: 0 | 1 | 2, to: number): void {
    const last = out[out.length - 1];
    if (Math.abs(last[AXIS[axis]] - to) < 0.01) return;
    const next = last.clone();
    next[AXIS[axis]] = to;
    out.push(next);
  }

  /**
   * Round each corner, leaving the straight runs alone. Only corners get
   * geometry, so a long trunk stays one segment however long it is — and a
   * straight run drawn as one segment cannot bead under additive blending.
   */
  function roundCorners(pts: Vector3[]): Vector3[] {
    if (pts.length < 3) return pts;
    const out: Vector3[] = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1];
      const q = pts[i];
      const r = pts[i + 1];
      const v1 = q.clone().sub(p);
      const v2 = r.clone().sub(q);
      const l1 = v1.length();
      const l2 = v2.length();
      if (l1 < 0.01 || l2 < 0.01) continue;
      // Never more than whichever leg is shortest can spare, or neighbouring
      // corners eat each other and the trace wanders off its lane.
      const rad = Math.min(CORNER_RADIUS, l1 * 0.45, l2 * 0.45);
      const s = q.clone().addScaledVector(v1.divideScalar(l1), -rad);
      const t = q.clone().addScaledVector(v2.divideScalar(l2), rad);
      out.push(s);
      // A quadratic with the corner itself as the control point: the arc leaves
      // one leg and rejoins the other exactly tangentially.
      for (let n = 1; n < CORNER_STEPS; n++) {
        const u = n / CORNER_STEPS;
        const w = 1 - u;
        out.push(
          new Vector3(
            w * w * s.x + 2 * w * u * q.x + u * u * t.x,
            w * w * s.y + 2 * w * u * q.y + u * u * t.y,
            w * w * s.z + 2 * w * u * q.z + u * u * t.z,
          ),
        );
      }
      out.push(t);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /**
   * The polyline an edge is drawn as: axis-aligned runs and right angles, the
   * flat view's transit routing lifted into three dimensions.
   *
   * A crossing between two groups fans onto its pair's shared corridor, runs the
   * trunk in its own lane, and fans off at the far end — five runs, four
   * corners. An edge inside one group, or touching a node the grouping cannot
   * place, has no corridor to join and takes a plain three-run staircase with
   * its longest leg first, which is the most direct orthogonal path there is.
   */
  function pathFor(id: string, source: string, target: string): Vector3[] | null {
    const ia = index.get(source);
    const ib = index.get(target);
    if (ia === undefined || ib === undefined) return null;
    const na = nodes[ia];
    const nb = nodes[ib];
    if (na.x === undefined || nb.x === undefined) return null;
    const from = new Vector3(na.x, na.y!, na.z!);
    const to = new Vector3(nb.x, nb.y!, nb.z!);

    const out: Vector3[] = [from];
    const corridor = corridors.get(id);
    if (corridor) {
      const { k, a, b, la, lb } = corridor;
      // Onto the lane first, then the long run, then off it. Entering on its own
      // k means each edge joins the trunk beside its own node rather than being
      // dragged to a common entry point, which is the fan the flat view gets
      // inside a box.
      step(out, a, la);
      step(out, b, lb);
      step(out, k, to[AXIS[k]]);
      step(out, a, to[AXIS[a]]);
      step(out, b, to[AXIS[b]]);
    } else {
      // Longest leg first: the run you notice should be the one that covers the
      // distance, not a short jog off the node.
      const order = ([0, 1, 2] as Array<0 | 1 | 2>).sort(
        (p, q) => Math.abs(to[AXIS[q]] - from[AXIS[q]]) - Math.abs(to[AXIS[p]] - from[AXIS[p]]),
      );
      for (const axis of order) step(out, axis, to[AXIS[axis]]);
    }
    if (out[out.length - 1].distanceTo(to) > 0.01) out.push(to);
    return roundCorners(out);
  }

  /** Sample a polyline at 0 <= t <= 1, by ARC LENGTH rather than segment index. */
  function alongPath(path: Vector3[], t: number): Vector3 {
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) total += path[i].distanceTo(path[i + 1]);
    if (total <= 0) return path[0].clone();
    let want = Math.min(1, Math.max(0, t)) * total;
    for (let i = 0; i < path.length - 1; i++) {
      const len = path[i].distanceTo(path[i + 1]);
      if (want <= len || i === path.length - 2) {
        return path[i].clone().lerp(path[i + 1], len > 0 ? want / len : 0);
      }
      want -= len;
    }
    return path[path.length - 1].clone();
  }

  // Every edge carries as many segments as its own path has, tracked by a span
  // into shared buffers, so a straight edge still costs one segment.
  let epos = new Float32Array(0);
  let baseCol = new Float32Array(0);
  let shownCol = new Float32Array(0);
  let glowCol = new Float32Array(0);
  /** Where each edge's segments start, and how many it has. */
  const spans: Array<{ start: number; count: number }> = drawable.map(() => ({ start: 0, count: 0 }));

  function writeEdgePositions(): void {
    buildCorridors();
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
    }

    paths.forEach((path, i) => {
      if (!path) return;
      c.set(LAYER_COLOR[drawable[i].layer]);
      const { start, count } = spans[i];
      for (let s = 0; s < count; s++) {
        const o = (start + s) * 6;
        epos[o] = path[s].x;
        epos[o + 1] = path[s].y;
        epos[o + 2] = path[s].z;
        epos[o + 3] = path[s + 1].x;
        epos[o + 4] = path[s + 1].y;
        epos[o + 5] = path[s + 1].z;
        // Fade toward the target so direction reads without arrowheads, spread
        // along the whole path rather than end to end.
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

  const edgeMat = new LineMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    linewidth: 2.4, // screen pixels
    dashed: false,
  });
  edgeMat.resolution.set(1, 1);
  const edgeMesh = new LineSegments2(edgeGeom, edgeMat);
  edgeMesh.frustumCulled = false;
  edgeMesh.renderOrder = 1;
  scene.add(edgeMesh);

  // A wider, dimmer pass behind the same geometry gives each line an outer
  // glow, so edges read as luminous rather than as flat tape.
  //
  // It carries its own colour buffer rather than sharing the line's. The halo is
  // roughly fifteen times the area of the line, and under additive blending a
  // dense layer stacks those halos until the field behind the labels goes white.
  // Dense layers therefore draw the crisp line and skip the glow.
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
  glowMesh.renderOrder = 0;
  scene.add(glowMesh);

  /** Push the rebuilt buffers at both edge passes. */
  function uploadEdges(): void {
    edgeGeom.setPositions(epos);
    edgeGeom.setColors(shownCol);
    glowGeom.setPositions(epos);
    glowGeom.setColors(glowCol);
  }

  // -- highlight overlay ------------------------------------------------------
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
  hlMesh.renderOrder = 3;
  const hlGlowMat = new LineMaterial({ vertexColors: true, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, linewidth: 17, opacity: 0.14 });
  hlGlowMat.resolution.set(1, 1);
  const hlGlow = new LineSegments2(hlGeom, hlGlowMat);
  hlGlow.frustumCulled = false;
  hlGlow.renderOrder = 2;
  hlGlow.visible = false;
  scene.add(hlGlow);
  hlMesh.visible = false;
  scene.add(hlMesh);



  // -- flow pulses ----------------------------------------------------------
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
  const pulseMat = nodeMat.clone();
  pulseMat.uniforms = { uScale: nodeMat.uniforms.uScale, uMinSize: { value: 6 } };
  const pulses = new Points(pulseGeom, pulseMat);
  pulses.frustumCulled = false;
  pulses.renderOrder = 5; // always on top of the edges they travel
  scene.add(pulses);

  return {
    renderer,
    camera,
    controls,
    scene,
    nodes,
    setNodeAlpha(fn) {
      for (let i = 0; i < count; i++) alpha[i] = fn(nodes[i], i);
      nodeGeom.attributes.alpha.needsUpdate = true;
    },
    setNodeSize(fn) {
      for (let i = 0; i < count; i++) size[i] = fn(nodes[i], i);
      nodeGeom.attributes.size.needsUpdate = true;
    },
    setDriftOffset(x, y) {
      driftOffset.x = x;
      driftOffset.y = y;
    },
    setNodeTint(fn) {
      for (let i = 0; i < count; i++) {
        c.set(fn(nodes[i], i));
        tint[i * 3] = c.r;
        tint[i * 3 + 1] = c.g;
        tint[i * 3 + 2] = c.b;
      }
      nodeGeom.attributes.tint.needsUpdate = true;
    },
    setEdgeAlpha(fn) {
      // Under additive blending, scaling the colour is the same as scaling
      // alpha — so visibility rides the colour buffer and stays one draw call.
      for (let i = 0; i < drawable.length; i++) {
        const a = fn(drawable[i], i);
        const halo = GLOWLESS.has(drawable[i].layer) ? 0 : a;
        const { start, count } = spans[i];
        for (let k = start * 6; k < (start + count) * 6; k++) {
          shownCol[k] = baseCol[k] * a;
          glowCol[k] = baseCol[k] * halo;
        }
      }
      edgeGeom.setColors(shownCol);
      glowGeom.setColors(glowCol);
    },
    setHighlight(list) {
      if (!list.length) {
        hlMesh.visible = false;
        hlGlow.visible = false;
        return;
      }
      // A highlight takes the same curve its edge is drawn on. A straight line
      // over a bundled edge would cut across the trunk the eye is following.
      const paths = list.map((e) => pathFor(pairEdge.get(`${e.source}|${e.target}`)?.id ?? '', e.source, e.target));
      const total = paths.reduce((n, path) => n + (path ? path.length - 1 : 0), 0);
      const p = new Float32Array(total * 6);
      const col = new Float32Array(total * 6);
      let at = 0;
      paths.forEach((path, i) => {
        if (!path) return;
        c.set(LAYER_COLOR[list[i].layer]);
        for (let k = 0; k < path.length - 1; k++) {
          const o = at * 6;
          p[o] = path[k].x;
          p[o + 1] = path[k].y;
          p[o + 2] = path[k].z;
          p[o + 3] = path[k + 1].x;
          p[o + 4] = path[k + 1].y;
          p[o + 5] = path[k + 1].z;
          col.set([c.r, c.g, c.b, c.r, c.g, c.b], o);
          at++;
        }
      });
      hlGeom.setPositions(p);
      hlGeom.setColors(col);
      hlMesh.visible = true;
      hlGlow.visible = true;
    },
    setPulses(list) {
      const n = Math.min(list.length, MAX_PULSES);
      for (let i = 0; i < MAX_PULSES; i++) {
        if (i < n) {
          const p = list[i];
          ppos[i * 3] = p.pos.x;
          ppos[i * 3 + 1] = p.pos.y;
          ppos[i * 3 + 2] = p.pos.z;
          c.set(p.color);
          ptint[i * 3] = c.r;
          ptint[i * 3 + 1] = c.g;
          ptint[i * 3 + 2] = c.b;
          psize[i] = 16 + p.strength * 14;
          palpha[i] = p.strength;
        } else {
          palpha[i] = 0;
        }
      }
      pulseGeom.attributes.position.needsUpdate = true;
      pulseGeom.attributes.tint.needsUpdate = true;
      pulseGeom.attributes.size.needsUpdate = true;
      pulseGeom.attributes.alpha.needsUpdate = true;
    },
    render(nowMs) {
      // A gentle parallax tied to where the camera looks, so the field feels
      // like space the graph sits inside rather than wallpaper behind it.
      const dir = camera.position.clone().sub(controls.target).normalize();
      const u = bgMat.uniforms;
      u.uTime.value = reduceMotion ? 0 : nowMs / 1000;
      u.uAspect.value = camera.aspect;
      // Zooming in should pull the field closer too. The far layer resists the
      // change; the near veil follows it much more, which is what sells depth.
      const dist = camera.position.distanceTo(controls.target);
      const rel = Math.min(4, Math.max(0.22, dist / 1900));
      u.uZoom.value = Math.pow(rel, 0.35);
      fgMat.uniforms.uZoom.value = Math.pow(rel, 0.72);

      // Panning (right-drag) moves the camera and its target by the same
      // vector, so orientation alone never changes. Fold the target position in
      // as well, or the field sits still while the graph slides under it.
      // Where we are actually LOOKING, with the panel dodge taken back out:
      // that offset is a fact about the chrome, not about the world, and the
      // field must not move for it.
      const tx = controls.target.x - driftOffset.x;
      const ty = controls.target.y - driftOffset.y;
      u.uDrift.value = {
        x: dir.x * 0.35 - tx * 0.00045,
        y: dir.y * 0.35 - ty * 0.00045,
      };
      fgMat.uniforms.uDrift.value = { x: -tx * 0.0013, y: -ty * 0.0013 };

      for (const f of fields) (f.mesh.material as ShaderMaterial).uniforms.uTime.value = u.uTime.value;
      // Weather is motion, so it stops entirely when motion is not wanted.
      if (!reduceMotion) {
        advanceMeteors(Math.min(0.05, lastFrame ? (nowMs - lastFrame) / 1000 : 0), u.uTime.value);
      }
      lastFrame = nowMs;
      fgMat.uniforms.uTime.value = u.uTime.value;
      fgMat.uniforms.uAspect.value = camera.aspect;

      renderer.autoClear = false;
      renderer.clear();
      renderer.render(bgScene, bgCam);   // behind
      renderer.render(scene, camera);    // the graph
      renderer.render(fgScene, bgCam);   // a thin veil in front
    },
    setViewportScale(heightPx) {
      const fov = (camera.fov * Math.PI) / 180;
      const dpr = renderer.getPixelRatio();
      // A little extra presence on large canvases, damped so a 4K window does
      // not get comically large nodes.
      const viewportBoost = Math.min(1.35, Math.max(0.85, Math.pow(heightPx / 820, 0.35)));
      nodeMat.uniforms.uScale.value = ((heightPx * 0.5) / Math.tan(fov / 2)) * dpr * viewportBoost;
    },
    setEdgeWidth(px) {
      edgeMat.linewidth = px;
      glowMat.linewidth = px * 3.75;
      // A node must never render thinner than the connector meeting it.
      nodeMat.uniforms.uMinSize.value = Math.max(14, px * 6) * renderer.getPixelRatio();
    },
    setResolution(w, h) {
      edgeMat.resolution.set(w, h);
      glowMat.resolution.set(w, h);

      hlMat.resolution.set(w, h);
      hlGlowMat.resolution.set(w, h);
    },
    fields: () => fields.map((f) => ({ id: f.id, centre: f.centre, radius: f.radius, count: f.members.length })),
    setFieldAlpha(fn) {
      for (const f of fields) (f.mesh.material as ShaderMaterial).uniforms.uAlpha.value = fn(f.id, f.members);
    },
    strike(clientX, clientY, fromEye = false) {
      const at = clientX === undefined || clientY === undefined ? undefined : aimAt(clientX, clientY) ?? undefined;
      spawnMeteor(at, fromEye && at !== undefined, true);
    },
    setFieldGrouping(key) {
      // Shells first: an edge cannot find its channel until the shells it runs
      // between exist at their new centres.
      buildFields(key);
      writeEdgePositions();
      uploadEdges();
      hlMesh.visible = false;
      hlGlow.visible = false;
    },
    pathOf: (e) => pathFor(e.id, e.source, e.target),
    curveAt(source, target, t) {
      // The edge's OWN lane matters: several edges can join the same two nodes
      // and each gets its own strand of the corridor, so borrowing a sibling's
      // route would put the pulse a lane away from the line it belongs to.
      const e = pairEdge.get(`${source}|${target}`);
      // Some curated flow steps name a hop with no edge behind it in either
      // direction. They still get a route — pathFor works from node ids alone —
      // and it is the same one setHighlight draws, so the dot rides the line.
      const path = e ? pathFor(e.id, e.source, e.target) : pathFor('', source, target);
      if (!path) return null;
      // A route runs from ITS edge's source to ITS target. Borrowing one that
      // runs the other way without reversing sends the dot off to the far node,
      // back along the corridor, and home again.
      return alongPath(path, !e || e.source === source ? t : 1 - t);
    },
    frameAll() {
      camera.position.set(0, 260, 1900);
      controls.target.set(0, 0, 0);
      controls.update();
    },
  };
}

export { Vector3 };
export type { GraphEdge, GraphNode };
