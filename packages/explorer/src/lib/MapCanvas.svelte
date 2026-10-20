<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    CODE_COLOR,
    CODE_LABEL,
    ENV_LABEL,
    ENVS,
    ENV_ORDER,
    formatPacificDay,
    type Code,
    type EnvChoice,
    type Item,
    type SurfaceInfo,
    N_ENVS,
  } from "./data.ts";
  import {
    focusBox,
    focusDistrict,
    parentOf,
    stepToward,
    type Focus,
  } from "./focus.ts";
  import {
    HEX,
    EDGE_DIR,
    buildWorld,
    cellAt,
    corner,
    islandAt,
    type Box,
    type Cell,
    type District,
    type Island,
    type World,
  } from "./layout.ts";
  import type { Model } from "./model.ts";
  import { verdictLines } from "./verdict.ts";
  import { shortCount } from "./counts.ts";
  import { sectorPoints } from "./glyph.ts";

  let {
    model,
    running = new Set<number>(),
    alert = new Set<number>(),
    spot = null,
    spotFrom = new Set<number>(),
    env,
    snap,
    focus,
    flyKey,
    lens = "all",
    world = $bindable(null),
    surfaces,
    items,
    place = null,
    levelKey = "",
    inside = false,
    enterable = new Set<number>(),
    ties = [],
    onfocus,
    onenter,
    onleave,
    clearTop = () => 100,
  }: {
    model: Model;
    /** Items the scenarios running right now touch; their hexes breathe until the run moves on. */
    running?: Set<number>;
    /** Items failing somewhere on show; their hexes pulse so the eye lands on them first. */
    alert?: Set<number>;
    /** When set, only these items stay lit; the rest of the map sinks under a veil. */
    spot?: Set<number> | null;
    /** Where the veil spreads from when the spotlight changes, such as the hexes a failure blocks. */
    spotFrom?: Set<number>;
    env: EnvChoice;
    snap: number;
    focus: Focus;
    /** Changes whenever the camera should fly to the focus; selecting by click alone does not move it. */
    flyKey: number;
    /** "orphans" dims every item some persona journey uses, "planned" dims everything built. */
    lens?: "all" | "orphans" | "planned";
    world?: World | null;
    /** The islands and items this level of the map draws: the product, or one holder's contents. */
    surfaces: SurfaceInfo[];
    items: Item[];
    /** Inside a holder, the district each item takes. */
    place?: Map<number, string> | null;
    /** Names the level on show; a new key fits the camera to the new world. */
    levelKey?: string;
    /** Whether the map shows a holder's contents, so zooming out can leave it. */
    inside?: boolean;
    /** Items that open as a sub-map of their own. */
    enterable?: Set<number>;
    /** Pairs of items tied on this level, such as a thing and the docs page that documents it, drawn as dotted lines. */
    ties?: [number, number][];
    onfocus: (f: Focus, fly: boolean) => void;
    onenter: (cell: Cell) => void;
    onleave: () => void;
    /** How far down the controls over the map reach, read when the camera moves. */
    clearTop?: () => number;
  } = $props();
  let {
    claimed,
    itemFailures,
    boardSource,
    status,
    holdCount,
    cellNote,
    staleCells,
    verdict,
    runGaps,
  } = $derived(model);

  interface Camera {
    x: number;
    y: number;
    k: number;
  }
  interface Palette {
    ground: string;
    grid: string;
    contour: string;
    land: string;
    landEdge: string;
    ink: string;
    ink2: string;
    ink3: string;
    accent: string;
    pass: string;
    passGlow: string;
    fail: string;
    planned: string;
    issue: string;
    none: string;
    never: string;
  }

  const WAVE_MS = 900;
  /** Hex size on screen, in pixels, from which each hex carries its item label. */
  const LABEL_PX = 26;
  /** Inside a holder the names are the point, so they show at a smaller hex. */
  const labelPx = () => (inside ? 17 : LABEL_PX);
  // A pointy hex split into one sector per env, the first env centered on top (three envs: the three rhombi).
  const SECTORS = ENVS.map((_, i) => sectorPoints(i, ENVS.length, 1));

  let canvas: HTMLCanvasElement;
  let stage: HTMLDivElement;
  let ctx: CanvasRenderingContext2D;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let colors: Palette;
  let glow: HTMLCanvasElement;
  let cam: Camera = { x: 0, y: 0, k: 1 };
  let camAnim: { from: Camera; to: Camera; t0: number; dur: number } | null =
    null;
  /** How the map arrives at the next level: opening a hex, closing one, or a plain route change. */
  let arriving: "in" | "out" | null = null;
  /** Where on the stage the hex being opened, or the island being closed, sat: the next level starts right there. */
  let arriveAt: { sx: number; sy: number; r: number } | null = null;
  /** The camera was placed by an animated arrival, so the first fly after it animates rather than cuts. */
  let settling = false;
  /** When the current level appeared; it fades in over the first moments. */
  let levelFade = 0;
  const FADE_MS = 160;
  let shownSnap = untrack(() => snap);
  let waveStart = 0;
  let pulse: { cell: Cell; t0: number } | null = null;
  let spotWave: { t0: number; from: Cell[]; reach: number } | null = null;
  const SPOT_MS = 1100;
  let raf = 0;
  let drag: { x: number; y: number; cam: Camera; moved: boolean } | null = null;
  let dragging = $state(false);
  let hover = $state.raw<Cell | null>(null);
  let tip = $state<{ x: number; y: number; cell: Cell } | null>(null);
  let tipEl: HTMLDivElement | undefined = $state();
  const coastPaths = new Map<Island, Path2D>();

  const reduceMotion = () =>
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const codeAt = (s: number, c: Cell, ei: number): Code =>
    status[s]![c.item.idx]![ei]!;
  const colorFor = (code: Code) =>
    code === 3
      ? colors.pass
      : code === 2
        ? colors.fail
        : code === -1
          ? colors.never
          : colors.none;
  const toScreen = (x: number, y: number): [number, number] => [
    (x - cam.x) * cam.k + W / 2,
    (y - cam.y) * cam.k + H / 2,
  ];
  const toWorld = (sx: number, sy: number): [number, number] => [
    (sx - W / 2) / cam.k + cam.x,
    (sy - H / 2) / cam.k + cam.y,
  ];

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    colors = {
      ground: v("--ground"),
      grid: v("--grid"),
      contour: v("--contour"),
      land: v("--land"),
      landEdge: v("--land-edge"),
      ink: v("--ink"),
      ink2: v("--ink-2"),
      ink3: v("--ink-3"),
      accent: v("--accent"),
      pass: v("--pass"),
      passGlow: v("--pass-glow"),
      fail: v("--fail"),
      planned: v("--planned"),
      issue: v("--issue"),
      none: v("--none"),
      never: v("--never"),
    };
    glow = document.createElement("canvas");
    glow.width = glow.height = 64;
    const g = glow.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, colors.passGlow || "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }

  function camFor(box: Box, pad = 48): Camera {
    const [x0, y0, x1, y1] = box;
    // Clears the crumbs and view bars over the map's top left, so the topmost island's label stays readable.
    const top = Math.max(100, clearTop());
    const bottom = 64;
    const k = Math.min(
      (W - pad * 2) / (x1 - x0),
      (H - top - bottom) / (y1 - y0),
    );
    const kk = Math.max(0.05, Math.min(k, 9));
    return {
      x: (x0 + x1) / 2,
      y: (y0 + y1) / 2 - (top - bottom) / 2 / kk,
      k: kk,
    };
  }

  function flyTo(box: Box) {
    const to = camFor(box);
    if (reduceMotion()) {
      cam = to;
      draw();
      return;
    }
    camAnim = { from: { ...cam }, to, t0: performance.now(), dur: 650 };
    loop();
  }

  function loop() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    raf = 0;
    let more = false;
    if (camAnim) {
      const a = camAnim;
      const t = Math.min(1, (now - a.t0) / a.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const lk0 = Math.log(a.from.k);
      const lk1 = Math.log(a.to.k);
      cam = {
        x: a.from.x + (a.to.x - a.from.x) * e,
        y: a.from.y + (a.to.y - a.from.y) * e,
        k: Math.exp(lk0 + (lk1 - lk0) * e),
      };
      if (t >= 1) camAnim = null;
      else more = true;
    }
    if (levelFade && now - levelFade < FADE_MS) more = true;
    if (shownSnap !== snap) {
      if (now - waveStart > WAVE_MS + 200) shownSnap = snap;
      else more = true;
    }
    if (pulse) {
      if (now - pulse.t0 > 2400) pulse = null;
      else more = true;
    }
    if (spotWave) {
      if (now - spotWave.t0 > SPOT_MS) spotWave = null;
      else more = true;
    }
    draw(now);
    if (more) loop();
  }

  /** While the spotlight changes, the veil reaches a cell once the wave from the nearest source hex gets there. */
  function veiled(c: Cell, now: number): boolean {
    if (!spotWave) return true;
    const t = Math.min(1, (now - spotWave.t0) / SPOT_MS);
    const e = 1 - Math.pow(1 - t, 3);
    let d = Infinity;
    for (const o of spotWave.from)
      d = Math.min(d, Math.hypot(c.wx - o.wx, c.wy - o.wy));
    return d <= spotWave.reach * e;
  }

  function startSpotWave() {
    const w = world;
    const from = w
      ? [...spotFrom].flatMap((idx) => w.cellOf.get(idx) ?? [])
      : [];
    if (!w || !spot || !from.length || reduceMotion()) {
      spotWave = null;
      return;
    }
    let reach = 0;
    for (const isl of w.islands)
      for (const c of isl.cells) {
        let d = Infinity;
        for (const o of from)
          d = Math.min(d, Math.hypot(c.wx - o.wx, c.wy - o.wy));
        reach = Math.max(reach, d);
      }
    spotWave = { t0: performance.now(), from, reach };
    loop();
  }

  /** During a timeline change the new state spreads outward from each island's center. */
  function cellSnap(c: Cell, now: number): number {
    if (shownSnap === snap) return snap;
    const t = (now - waveStart) / WAVE_MS;
    return t >= c.d / c.island.land ? snap : shownSnap;
  }

  function hexPath(p: CanvasPath, cx: number, cy: number, s: number) {
    for (let i = 0; i < 6; i++) {
      const [x, y] = corner(cx, cy, i, s);
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    }
    p.closePath();
  }

  function rhombus(
    p: CanvasPath,
    cx: number,
    cy: number,
    ei: number,
    s: number,
  ) {
    const pts = SECTORS[ei]!;
    const g = s * 0.035;
    // Nudge the sector away from the center along its own middle, so a thin gap shows between sectors.
    const span = (2 * Math.PI) / ENVS.length;
    const mid = ei * span - Math.PI / 2;
    const ox = cx + Math.cos(mid) * g * 2;
    const oy = cy + Math.sin(mid) * g * 2;
    const r = s - g * 2;
    pts.forEach(([x, y], k) => {
      if (k === 0) p.moveTo(ox + x * r, oy + y * r);
      else p.lineTo(ox + x * r, oy + y * r);
    });
    p.closePath();
  }

  function coastPath(isl: Island): Path2D {
    let p = coastPaths.get(isl);
    if (!p) {
      p = new Path2D();
      for (const [a, b] of isl.coast) {
        p.moveTo(a[0], a[1]);
        p.lineTo(b[0], b[1]);
      }
      coastPaths.set(isl, p);
    }
    return p;
  }

  function outlineDistrict(d: District, col: string, lw: number) {
    const set = new Set(d.cells);
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (const c of d.cells) {
      for (let i = 0; i < 6; i++) {
        const [dq, dr] = EDGE_DIR[i]!;
        const nb = c.island.key.get(`${c.q + dq},${c.r + dr}`);
        if (nb && set.has(nb)) continue;
        const p0 = corner(c.wx, c.wy, i);
        const p1 = corner(c.wx, c.wy, (i + 1) % 6);
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
      }
    }
    ctx.stroke();
  }

  function drawGrid() {
    let step = 100;
    while (step * cam.k < 70) step *= 2;
    while (step * cam.k > 220) step /= 2;
    const [wx0, wy0] = toWorld(0, 0);
    const [wx1, wy1] = toWorld(W, H);
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(wx0 / step) * step; x <= wx1; x += step) {
      const sx = Math.round(toScreen(x, 0)[0]) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, H);
    }
    for (let y = Math.floor(wy0 / step) * step; y <= wy1; y += step) {
      const sy = Math.round(toScreen(0, y)[1]) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(W, sy);
    }
    ctx.stroke();
  }

  function setFont(
    px: number,
    weight: number,
    stretch: CanvasFontStretch,
    spacing = "0px",
    family = "Archivo, 'Helvetica Neue', Arial, sans-serif",
  ) {
    ctx.font = `${weight} ${px}px ${family}`;
    ctx.fontStretch = stretch;
    ctx.letterSpacing = spacing;
  }

  function haloText(text: string, x: number, y: number, fill: string) {
    ctx.lineWidth = 4;
    ctx.strokeStyle = colors.ground;
    ctx.lineJoin = "round";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  /** A rounded plate on the ground, so a name reads over whatever lies behind it. */
  function pill(b: Box, alpha = 0.9) {
    ctx.beginPath();
    ctx.roundRect(b[0], b[1], b[2] - b[0], b[3] - b[1], 99);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colors.ground;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.landEdge;
    ctx.stroke();
  }

  function shorten(s: string, n: number) {
    return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
  }

  /** Drops leading articles and verbs-of-reading that every API summary shares, so the noun shows. */
  function shortLabel(label: string) {
    return label
      .replace(/^(List|Get|Read|Show) (the |a |an |all )?/i, "")
      .replace(/^(the|a|an) /i, "");
  }

  /** Lines of at most `max` characters, breaking at spaces and after slashes and hyphens, so a route or a test id reads whole. */
  function wrapLabel(text: string, max: number, rows = 2): string[] {
    const pieces: { text: string; glue: string }[] = [];
    for (const word of text.split(/\s+/))
      word
        .split(/(?<=[/-])/)
        .forEach((part, i) =>
          pieces.push({ text: part, glue: i === 0 ? " " : "" }),
        );
    const lines: string[] = [];
    let cur = "";
    let used = 0;
    for (const piece of pieces) {
      const joined = cur ? cur + piece.glue + piece.text : piece.text;
      if (!cur || joined.length <= max) cur = joined;
      else {
        lines.push(cur);
        cur = piece.text;
        if (lines.length === rows) break;
      }
      used++;
    }
    if (lines.length < rows && cur) {
      lines.push(cur);
      used = pieces.length;
    }
    const cut = used < pieces.length;
    return lines.map((l, i, a) =>
      i === a.length - 1 && cut
        ? shorten(l, max - 1) + (l.length < max ? "\u2026" : "")
        : shorten(l, max),
    );
  }

  function drawLabels(w: World) {
    const k = cam.k;
    const hexPx = HEX * k;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const taken: Box[] = [];
    const free = (b: Box) =>
      taken.every(
        (t) => b[0] > t[2] || b[2] < t[0] || b[1] > t[3] || b[3] < t[1],
      );
    for (const isl of [...w.islands].sort((a, b) => b.r - a.r)) {
      const px = Math.max(10, Math.min(18, isl.r * k * 0.12));
      setFont(px, 700, "expanded", "0.12em");
      const title = isl.info.title.toUpperCase();
      const tw = ctx.measureText(title).width;
      const sx = toScreen(isl.x, isl.y)[0];
      const boxAt = (y: number): Box => [
        sx - tw / 2 - 4,
        y - px * 1.05,
        sx + tw / 2 + 4,
        y + px * 0.1,
      ];
      // Above the island, or below it when a bigger neighbor's label already holds that spot.
      const sy = [
        toScreen(isl.x, isl.y - isl.land - HEX * 1.1)[1],
        toScreen(isl.x, isl.y + isl.land + HEX * 1.1)[1] + px,
      ].find((y) => free(boxAt(y)));
      if (sy === undefined) continue;
      const box = boxAt(sy);
      taken.push(box);
      haloText(title, sx, sy - px * 0.4, colors.ink);
      setFont(11.5, 500, "normal");
      const realItems = isl.items.filter((it) => !it.planned);
      const ghostN = isl.items.length - realItems.length;
      const sub = `${shortCount(model, realItems, snap, env, true)}${ghostN ? `; ${ghostN} planned` : ""}`;
      const sw = ctx.measureText(sub).width;
      const sbox: Box = [
        sx - sw / 2 - 3,
        sy + px * 0.8 - 7,
        sx + sw / 2 + 3,
        sy + px * 0.8 + 7,
      ];
      if (free(sbox)) {
        taken.push(sbox);
        haloText(sub, sx, sy + px * 0.8, colors.ink2);
      }
    }
    const named = hexPx > labelPx();
    if (named) {
      setFont(10.5, 500, "condensed");
      const max = Math.floor((hexPx * 1.7) / 5.2);
      for (const isl of w.islands) {
        for (const c of isl.cells) {
          const [sx, sy] = toScreen(c.wx, c.wy);
          if (sx < -40 || sy < -20 || sx > W + 40 || sy > H + 20) continue;
          const lines = wrapLabel(
            shortLabel(c.item.label),
            max,
            hexPx > labelPx() * 1.3 ? 3 : 2,
          );
          const tw = Math.max(...lines.map((ln) => ctx.measureText(ln).width));
          const h = lines.length * 12;
          const box: Box = [
            sx - tw / 2 - 6,
            sy - h / 2 - 2,
            sx + tw / 2 + 6,
            sy + h / 2 + 2,
          ];
          taken.push(box);
          pill(box, 0.85);
          ctx.fillStyle = colors.ink;
          lines.forEach((ln, i) =>
            ctx.fillText(ln, sx, sy + (i - (lines.length - 1) / 2) * 12 + 0.5),
          );
          setFont(10.5, 500, "condensed");
        }
      }
    }
    if (!named && hexPx > 3.2) {
      const districts = w.islands
        .flatMap((isl) => isl.districts)
        .sort((a, b) => b.cells.length - a.cells.length);
      for (const d of districts) {
        const area = d.cells.length * hexPx * hexPx;
        if (area < 700) continue;
        const [sx, sy] = toScreen(d.label[0], d.label[1]);
        if (sx < -50 || sy < -20 || sx > W + 50 || sy > H + 20) continue;
        const px = Math.max(11, Math.min(15, Math.sqrt(area) * 0.09));
        setFont(px, 500, "normal", "0px", "Newsreader, Georgia, serif");
        ctx.font = `italic ${ctx.font}`;
        const text = shorten(d.name, 28);
        const tw = ctx.measureText(text).width;
        const box: Box = [
          sx - tw / 2 - 3,
          sy - px * 0.7,
          sx + tw / 2 + 3,
          sy + px * 0.7,
        ];
        if (!free(box)) continue;
        taken.push(box);
        haloText(text, sx, sy, colors.ink);
      }
    }
  }

  function draw(now = performance.now()) {
    const w = world;
    if (!w || !W || !ctx) return;
    const k = cam.k;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.ground;
    ctx.fillRect(0, 0, W, H);
    drawGrid();
    if (levelFade)
      ctx.globalAlpha = Math.min(
        1,
        Math.max(0.05, (now - levelFade) / FADE_MS),
      );
    ctx.setTransform(
      dpr * k,
      0,
      0,
      dpr * k,
      dpr * (W / 2 - cam.x * k),
      dpr * (H / 2 - cam.y * k),
    );
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Contour rings: stroke the coastline wide, then narrower in the ground color, leaving thin survey lines.
    for (const isl of w.islands) {
      const path = coastPath(isl);
      for (const ring of [3, 2, 1]) {
        const lw = ring * HEX * 1.15 * 2;
        ctx.strokeStyle = colors.contour;
        ctx.lineWidth = lw;
        ctx.stroke(path);
        ctx.strokeStyle = colors.ground;
        ctx.lineWidth = Math.max(0, lw - 1.3 / k);
        ctx.stroke(path);
      }
    }
    ctx.fillStyle = colors.land;
    ctx.beginPath();
    for (const isl of w.islands)
      for (const c of isl.cells) hexPath(ctx, c.wx, c.wy, HEX + 0.6);
    ctx.fill();

    const split = env === "all";
    const single = split ? -1 : ENVS.indexOf(env);
    const buckets = new Map<string, Path2D>();
    const planned = new Path2D();
    const ghosts = new Path2D();
    const issues = new Path2D();
    const ghostMarks = new Path2D();
    const dash = new Path2D();
    // Not checked here: hatched, so a grey face never reads as shading.
    const unchecked = new Path2D();
    let anyUnchecked = false;
    // Verified only by steps before a later step failed: a paler green.
    const muted = new Path2D();
    // Proof older than twice the env's usual gap between runs: faded under a veil of ground.
    const faded = new Path2D();
    // A hex within a hex marks an item that opens as a map of its own.
    const inner = new Path2D();
    const lit: Cell[] = [];
    const bucket = (col: string) => {
      let p = buckets.get(col);
      if (!p) {
        p = new Path2D();
        buckets.set(col, p);
      }
      return p;
    };
    const inset = HEX * 0.9;
    const labelled = HEX * k > labelPx();
    const veil = new Path2D();
    for (const isl of w.islands) {
      for (const c of isl.cells) {
        const s = cellSnap(c, now);
        const codes = status[s]![c.item.idx]!;
        const old = staleCells(s);
        const face = (ei: number) => {
          const code = codes[ei]!;
          const later =
            code === 3 && cellNote(c.item, s, ei) === "later-failed";
          if (code === -2) anyUnchecked = true;
          return {
            path: later ? muted : bucket(colorFor(code)),
            unchecked: code === -2,
            later,
            stale: old[c.item.idx * N_ENVS + ei] === 1,
          };
        };
        if (c.item.planned) {
          hexPath(
            c.item.planned.kind === "issue" ? issues : ghosts,
            c.wx,
            c.wy,
            inset * 0.86,
          );
          if (c.item.planned.kind === "scenario") {
            if (split) {
              for (let ei = 0; ei < N_ENVS; ei++)
                if (codes[ei] === 1)
                  rhombus(ghostMarks, c.wx, c.wy, ei, inset * 0.62);
            } else if (codes[single] === 1)
              hexPath(ghostMarks, c.wx, c.wy, inset * 0.5);
          }
          continue;
        }
        if (split) {
          let glows = true;
          for (let ei = 0; ei < N_ENVS; ei++) {
            const code = codes[ei]!;
            const f = face(ei);
            rhombus(f.path, c.wx, c.wy, ei, inset);
            if (f.unchecked) rhombus(unchecked, c.wx, c.wy, ei, inset);
            if (f.stale) rhombus(faded, c.wx, c.wy, ei, inset);
            if (code === 1) rhombus(planned, c.wx, c.wy, ei, inset * 0.82);
            if (code !== 3 || f.later || f.stale) glows = false;
          }
          if (glows) lit.push(c);
          if (enterable.has(c.item.idx))
            hexPath(inner, c.wx, c.wy, inset * 0.6);
          if (codes[0] === -1) {
            dash.moveTo(c.wx - inset * 0.28, c.wy - inset * 0.5);
            dash.lineTo(c.wx + inset * 0.28, c.wy - inset * 0.5);
          }
        } else {
          const code = codes[single]!;
          const f = face(single);
          hexPath(f.path, c.wx, c.wy, inset);
          if (f.unchecked) hexPath(unchecked, c.wx, c.wy, inset);
          if (f.stale) hexPath(faded, c.wx, c.wy, inset);
          if (code === 1) hexPath(planned, c.wx, c.wy, inset * 0.7);
          if (code === 3 && !f.later && !f.stale) lit.push(c);
          if (enterable.has(c.item.idx))
            hexPath(inner, c.wx, c.wy, inset * 0.6);
          if (code === -1) {
            dash.moveTo(c.wx - inset * 0.4, c.wy);
            dash.lineTo(c.wx + inset * 0.4, c.wy);
          }
        }
      }
    }
    for (const [col, p] of buckets) {
      ctx.fillStyle = col;
      ctx.fill(p);
    }
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = colors.pass;
    ctx.fill(muted);
    ctx.restore();
    if (anyUnchecked) {
      ctx.save();
      ctx.clip(unchecked);
      const [vx0, vy0] = toWorld(0, 0);
      const [vx1, vy1] = toWorld(W, H);
      const step = Math.max(HEX * 0.28, 3.2 / k);
      const span = vy1 - vy0;
      ctx.beginPath();
      for (let x = vx0 - span; x < vx1; x += step) {
        ctx.moveTo(x, vy1);
        ctx.lineTo(x + span, vy0);
      }
      ctx.strokeStyle = colors.landEdge;
      ctx.lineWidth = Math.max(HEX * 0.07, 0.9 / k);
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = colors.ground;
    ctx.fill(faded);
    ctx.restore();
    ctx.save();
    ctx.setLineDash([Math.min(2.2, 3 / k), Math.min(1.8, 2.5 / k)]);
    ctx.lineWidth = Math.min(1.2, 1.4 / k);
    ctx.strokeStyle = colors.planned;
    ctx.stroke(planned);
    ctx.fillStyle = colors.ground;
    ctx.fill(ghosts);
    ctx.fill(issues);
    ctx.lineWidth = Math.min(1.6, 1.6 / k);
    ctx.setLineDash([Math.min(3, 4 / k), Math.min(2.2, 3 / k)]);
    ctx.stroke(ghosts);
    // An open issue is only an intention: a dotted grey ring, no scenario marks inside.
    ctx.strokeStyle = colors.issue;
    ctx.lineCap = "round";
    ctx.setLineDash([0.01, Math.min(3.2, 4 / k)]);
    ctx.stroke(issues);
    ctx.lineCap = "butt";
    ctx.strokeStyle = colors.planned;
    ctx.setLineDash([Math.min(2.2, 3 / k), Math.min(1.8, 2.5 / k)]);
    ctx.lineWidth = Math.min(1.2, 1.4 / k);
    ctx.stroke(ghostMarks);
    ctx.restore();
    ctx.strokeStyle = colors.landEdge;
    ctx.lineWidth = 0.8;
    ctx.stroke(dash);
    ctx.strokeStyle = colors.ground;
    ctx.lineWidth = Math.max(0.9, Math.min(2.2, 2 / k));
    ctx.stroke(inner);
    if (ties.length) {
      const tie = new Path2D();
      const ends = new Path2D();
      for (const [a, b] of ties) {
        const ca = w.cellOf.get(a);
        const cb = w.cellOf.get(b);
        if (!ca || !cb) continue;
        tie.moveTo(ca.wx, ca.wy);
        tie.lineTo(cb.wx, cb.wy);
        ends.moveTo(cb.wx + HEX * 0.28, cb.wy);
        ends.arc(cb.wx, cb.wy, HEX * 0.28, 0, Math.PI * 2);
      }
      ctx.save();
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = Math.min(1.6, 1.8 / k);
      ctx.setLineDash([Math.min(3, 4 / k), Math.min(2.4, 3 / k)]);
      ctx.stroke(tie);
      ctx.setLineDash([]);
      ctx.fillStyle = colors.accent;
      ctx.fill(ends);
      ctx.restore();
    }
    if (lit.length && !/,\s*0\)$/.test(colors.passGlow)) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.5;
      for (const c of lit)
        ctx.drawImage(
          glow,
          c.wx - HEX * 2.2,
          c.wy - HEX * 2.2,
          HEX * 4.4,
          HEX * 4.4,
        );
      ctx.restore();
    }
    if (lens === "orphans" || lens === "planned" || spot) {
      for (const isl of w.islands)
        for (const c of isl.cells) {
          const dim = spot
            ? !spot.has(c.item.idx)
            : lens === "planned"
              ? !c.item.planned
              : claimed.has(c.item.idx);
          if (dim && (!spot || veiled(c, now)))
            hexPath(veil, c.wx, c.wy, HEX * 0.95);
        }
      ctx.save();
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = colors.ground;
      ctx.fill(veil);
      ctx.restore();
    }
    for (const isl of w.islands) {
      ctx.strokeStyle = colors.ink3;
      ctx.lineWidth = 1.1 / k + 0.5;
      ctx.beginPath();
      for (const [a, b] of isl.seams) {
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
      ctx.strokeStyle = colors.landEdge;
      ctx.lineWidth = 1.4 / k + 0.6;
      ctx.stroke(coastPath(isl));
    }
    const fd = focusDistrict(focus);
    if (fd) outlineDistrict(fd, colors.accent, 2.2 / k);
    if (hover) {
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 2 / k;
      ctx.beginPath();
      hexPath(ctx, hover.wx, hover.wy, HEX * 0.98);
      ctx.stroke();
    }
    if (focus.level === "item") {
      const c = focus.cell;
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 3 / k;
      ctx.beginPath();
      hexPath(ctx, c.wx, c.wy, HEX * 1.05);
      ctx.stroke();
    }
    if (alert.size > 0) {
      const beat = reduceMotion() ? 1 : 0.5 + 0.5 * Math.sin(now / 520);
      ctx.strokeStyle = colors.fail;
      ctx.lineWidth = (1.6 + beat * 2.2) / k;
      ctx.globalAlpha = 0.5 + 0.5 * beat;
      ctx.beginPath();
      for (const idx of alert) {
        const c = w.cellOf.get(idx);
        if (c) hexPath(ctx, c.wx, c.wy, HEX * (1.02 + beat * 0.25));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (running.size > 0) {
      const breath = reduceMotion() ? 1 : 0.5 + 0.5 * Math.sin(now / 320);
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = (1.4 + breath * 1.6) / k;
      ctx.globalAlpha = 0.45 + 0.5 * breath;
      ctx.beginPath();
      for (const idx of running) {
        const c = w.cellOf.get(idx);
        if (c) hexPath(ctx, c.wx, c.wy, HEX * 0.98);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (pulse) {
      const t = (now - pulse.t0) / 2400;
      const c = pulse.cell;
      for (let i = 0; i < 2; i++) {
        const tt = (t * 2 + i * 0.5) % 1;
        ctx.globalAlpha = 1 - tt;
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 2 / k;
        ctx.beginPath();
        hexPath(ctx, c.wx, c.wy, HEX * (1.2 + tt * 2.4));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLabels(w);
  }

  function local(e: PointerEvent | WheelEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onpointerdown(e: PointerEvent) {
    drag = { x: e.clientX, y: e.clientY, cam: { ...cam }, moved: false };
    canvas.setPointerCapture(e.pointerId);
  }

  function onpointermove(e: PointerEvent) {
    if (!world) return;
    const [sx, sy] = local(e);
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = true;
        dragging = true;
      }
      if (drag.moved) {
        camAnim = null;
        cam = {
          ...drag.cam,
          x: drag.cam.x - dx / cam.k,
          y: drag.cam.y - dy / cam.k,
        };
        tip = null;
        draw();
        return;
      }
    }
    const c = cellAt(world, ...toWorld(sx, sy));
    if (c !== hover) {
      hover = c;
      draw();
    }
    tip = c ? { x: sx, y: sy, cell: c } : null;
  }

  function onpointerup(e: PointerEvent) {
    dragging = false;
    const d = drag;
    drag = null;
    if (!world || (d && d.moved)) return;
    const [wx, wy] = toWorld(...local(e));
    const c = cellAt(world, wx, wy);
    if (c) {
      onfocus(
        focus.level === "item" && focus.cell === c
          ? focus
          : { level: "item", cell: c },
        false,
      );
      return;
    }
    const isl = islandAt(world, wx, wy);
    if (isl) onfocus({ level: "island", island: isl }, false);
    else if (focus.level !== "world") onfocus({ level: "world" }, false);
  }

  /** The camera dives into a hex, and only then does the level change; the new level starts large and settles. */
  /** A world point's place on the stage under the camera as it is now. */
  function onStage(wx: number, wy: number): [number, number] {
    return [W / 2 + (wx - cam.x) * cam.k, H / 2 + (wy - cam.y) * cam.k];
  }

  /** Opens a hex: the level changes at once, and its map grows out of the hex's own spot in one motion. */
  function dive(c: Cell) {
    const [sx, sy] = onStage(c.wx, c.wy);
    arriveAt = { sx, sy, r: HEX * cam.k };
    arriving = "in";
    onenter(c);
  }
  /** Closes a level: the outer map opens with the holder's hex where the island was, and pulls back in one motion. */
  function pullBack() {
    const isl = world?.islands[0];
    if (isl) {
      const [sx, sy] = onStage(isl.x, isl.y);
      arriveAt = { sx, sy, r: isl.r * cam.k };
    }
    arriving = "out";
    onleave();
  }

  function ondblclick(e: MouseEvent) {
    if (!world) return;
    const r = canvas.getBoundingClientRect();
    const [wx, wy] = toWorld(e.clientX - r.left, e.clientY - r.top);
    const c = cellAt(world, wx, wy);
    const isl = islandAt(world, wx, wy);
    if (c && enterable.has(c.item.idx)) dive(c);
    else if (c) onfocus(stepToward(focus, c), true);
    else if (isl) onfocus({ level: "island", island: isl }, true);
    else if (inside && focus.level === "world") pullBack();
    else onfocus(parentOf(focus), true);
  }

  function onpointerleave() {
    hover = null;
    tip = null;
    draw();
  }

  function onwheel(e: WheelEvent) {
    e.preventDefault();
    const [sx, sy] = local(e);
    const [wx, wy] = toWorld(sx, sy);
    const k = Math.max(
      0.05,
      Math.min(14, cam.k * Math.exp(-e.deltaY * 0.0016)),
    );
    if (world && e.deltaY > 0 && inside && k < camFor(world.box).k * 0.6) {
      onleave();
      return;
    }
    if (world && e.deltaY < 0 && k >= 11 && cam.k < 11) {
      const c = cellAt(world, wx, wy);
      if (c && enterable.has(c.item.idx)) {
        dive(c);
        return;
      }
    }
    camAnim = null;
    cam = { k, x: wx - (sx - W / 2) / k, y: wy - (sy - H / 2) / k };
    tip = null;
    draw();
  }

  let tipPos = $derived.by(() => {
    if (!tip || !tipEl) return null;
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;
    let x = tip.x + 16;
    let y = tip.y + 16;
    if (x + tw > W - 8) x = tip.x - tw - 16;
    if (y + th > H - 8) y = tip.y - th - 16;
    return { x: Math.max(8, x), y: Math.max(8, y) };
  });

  onMount(() => {
    ctx = canvas.getContext("2d")!;
    readColors();
    const ro = new ResizeObserver(() => {
      const rr = stage.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = rr.width;
      H = rr.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      if (world) {
        if (camAnim) camAnim.to = camFor(focusBox(world, focus));
        else cam = camFor(focusBox(world, focus));
        // The camera now sits on the focus, so the next fly animates from here rather than cutting.
        if (lastFly === -1) lastFly = flyKey;
      }
      draw();
    });
    ro.observe(stage);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const recolor = () => {
      readColors();
      draw();
    };
    mq.addEventListener("change", recolor);
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    document.fonts?.ready.then(() => draw());
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", recolor);
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  });

  // New data can bring new items; the map is laid out again, and the camera stays where it is. A new level fits the camera to it.
  let builtFor: unknown = null;
  let builtLevel = "";
  $effect(() => {
    const its = items;
    const surf = surfaces;
    const pl = place;
    const level = levelKey;
    untrack(() => {
      if (!stage || builtFor === its) return;
      builtFor = its;
      const r = stage.getBoundingClientRect();
      // Only the stage's orientation shapes the packing, so a strip or panel changing its height never moves the islands.
      const w = buildWorld(
        surf,
        its,
        r.width >= r.height ? 1.6 : 0.7,
        pl ?? undefined,
      );
      world = w;
      if (level !== builtLevel) {
        // Deeper or shallower: a holder's id starts with its holder's, so the longer key is the deeper level.
        const deeper = level.length > builtLevel.length;
        builtLevel = level;
        camAnim = null;
        hover = null;
        tip = null;
        const fit = camFor(w.box);
        if (!arriving) arriving = deeper ? "in" : "out";
        if (!W || reduceMotion() || lastFly === -1) {
          cam = fit;
          arriving = null;
          arriveAt = null;
        } else if (arriving === "in") {
          // The new level appears where the hex was, at its size, and keeps zooming in until it fills its frame.
          const isl = w.islands[0];
          const at = arriveAt ?? { sx: W / 2, sy: H / 2, r: HEX * cam.k };
          const k = isl ? Math.max(0.05, at.r / isl.r) : fit.k * 0.3;
          cam = {
            x: fit.x - (at.sx - W / 2) / k,
            y: fit.y - (at.sy - H / 2) / k,
            k,
          };
          levelFade = performance.now();
          settling = true;
          arriving = null;
          arriveAt = null;
        }
      }
      draw();
    });
  });

  // Running scenarios' hexes breathe at a few frames a second, which a whole-map redraw can afford.
  $effect(() => {
    if ((running.size === 0 && alert.size === 0) || reduceMotion()) {
      untrack(() => draw());
      return;
    }
    const t = setInterval(() => draw(), 100);
    return () => clearInterval(t);
  });

  let lastFly = -1;
  $effect(() => {
    const f = focus;
    const key = flyKey;
    if (!world) return;
    if (key === lastFly || !W) {
      draw();
      return;
    }
    const first = lastFly === -1 && !settling;
    settling = false;
    lastFly = key;
    if (first) {
      cam = camFor(focusBox(world, f));
      draw();
      return;
    }
    if (arriving === "out") {
      // Back out of a holder: its hex takes the place the island had, and the outer map pulls back to frame it.
      arriving = null;
      const c = f.level === "item" ? f.cell : null;
      if (c) {
        const at = arriveAt ?? { sx: W / 2, sy: H / 2, r: HEX * 6 };
        const k = Math.max(0.05, Math.min(14, at.r / HEX));
        cam = {
          x: c.wx - (at.sx - W / 2) / k,
          y: c.wy - (at.sy - H / 2) / k,
          k,
        };
      }
      arriveAt = null;
      levelFade = performance.now();
      settling = false;
    }
    flyTo(focusBox(world, f));
    if (f.level === "item") {
      pulse = { cell: f.cell, t0: performance.now() };
      loop();
    }
  });

  let lastSnap = untrack(() => snap);
  $effect(() => {
    const s = snap;
    if (s === lastSnap) return;
    shownSnap = reduceMotion() ? s : lastSnap;
    lastSnap = s;
    waveStart = performance.now();
    loop();
  });

  $effect(() => {
    void spot;
    void spotFrom;
    void world;
    untrack(startSpotWave);
  });

  $effect(() => {
    void env;
    void lens;
    void spot;
    void ties;
    draw();
  });
</script>

<div class="stage" bind:this={stage}>
  <canvas
    bind:this={canvas}
    tabindex="-1"
    class:dragging
    aria-label={inside
      ? `Map of what ${surfaces[0]?.title ?? "this item"} holds, grouped into districts. The panel beside it lists the same items.`
      : "Map of every customer surface item, grouped into islands by surface and districts by area. The panel beside it lists the same items."}
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    {onpointerleave}
    {onwheel}
    {ondblclick}
  ></canvas>
  {#if tip}
    {@const codes = status[snap]![tip.cell.item.idx]!}
    <div
      class="tip"
      bind:this={tipEl}
      style:left="{tipPos?.x ?? -9999}px"
      style:top="{tipPos?.y ?? -9999}px"
    >
      <b>{tip.cell.item.label}</b>
      <code>{tip.cell.item.id}</code>
      {#if tip.cell.item.planned?.kind === "scenario"}
        <div class="envs">
          <span class="chip"
            ><i style:background="var(--planned)"></i>Planned scenario, written
            and waiting to run</span
          >
        </div>
      {:else if tip.cell.item.planned?.kind === "issue"}
        <div class="envs">
          <span class="chip"
            ><i style:background="var(--issue)"></i>Open issue, {tip.cell.item
              .planned.board} on the Engineering Board as of {formatPacificDay(
              boardSource.checkedAt,
            )}</span
          >
        </div>
      {:else}
        <div class="envs">
          {#each ENV_ORDER as e (e)}
            {@const i = ENVS.indexOf(e)}
            <span class="chip"
              ><i style:background={CODE_COLOR[codes[i]!]}></i>{ENV_LABEL[e]}: {CODE_LABEL[
                codes[i]!
              ]}</span
            >
          {/each}
        </div>
        {#each env === "all" ? ENV_ORDER : [env] as e (e)}
          {@const lines = verdictLines(
            verdict(tip.cell.item, e, snap),
            e,
            runGaps[e],
            env !== "all",
          )}
          {#if lines.length}
            <p class="why">
              <b>{ENV_LABEL[e]}:</b>
              {lines.join(" ")}
            </p>
          {/if}
        {/each}
        {#each itemFailures(tip.cell.item, snap) as n (n.env)}
          <p class="tfail">
            <b>{ENV_LABEL[n.env]} failed at</b>
            {n.step}{n.message ? `: ${n.message.split("\n")[0]}` : ""}
          </p>
        {/each}
        {#if enterable.has(tip.cell.item.idx)}
          {@const n = holdCount(tip.cell.item)}
          <p class="more">
            Holds {n}
            {n === 1 ? "item" : "items"}. Double-click to open it as a map.
          </p>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .stage {
    position: absolute;
    inset: 0;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    cursor: grab;
    touch-action: none;
  }
  canvas.dragging {
    cursor: grabbing;
  }
  .tip {
    position: absolute;
    pointer-events: none;
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: var(--r-s);
    padding: 8px 10px;
    font-size: 12.5px;
    max-width: 320px;
    box-shadow: 0 6px 24px color-mix(in srgb, var(--ink) 14%, transparent);
    z-index: 3;
  }
  .tip b {
    display: block;
    font-size: 13.5px;
    margin-bottom: 2px;
    overflow-wrap: anywhere;
  }
  .tip code {
    color: var(--ink-3);
    font-size: 11.5px;
    overflow-wrap: anywhere;
  }
  .tfail {
    margin: 6px 0 0;
    color: var(--ink-2);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
  }
  .tip .tfail b {
    display: inline;
    font-size: inherit;
    color: var(--fail);
  }
  .why {
    margin: 6px 0 0;
    color: var(--ink-2);
  }
  .tip .why b {
    display: inline;
    font-size: inherit;
  }
  .envs {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
</style>
