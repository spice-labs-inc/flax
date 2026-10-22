import { outputTime, type EditPlan } from "./edit.ts";
import type { Box, Timeline, TimelineStep } from "./recording.ts";

// The production layer's arithmetic: where the recorded viewport sits in
// the picture, the camera moves that zoom to highlighted boxes, where a
// callout points, and the music bed ducked under the narration. render.ts
// turns it into filters and samples.

/** The output frame. */
export const FRAME_WIDTH = 2560;
export const FRAME_HEIGHT = 1440;
/** Default height of the band under the picture where captions go. */
export const CAPTION_BAND = 160;

/** Width and height in pixels. */
export interface Size {
  width: number;
  height: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Where a source of `viewport` size lands when fitted, centered, inside `picture`. */
export function fitRect(viewport: Size, picture: Size): Box {
  const scale = Math.min(
    picture.width / viewport.width,
    picture.height / viewport.height,
  );
  const width = viewport.width * scale;
  const height = viewport.height * scale;
  return {
    x: round3((picture.width - width) / 2),
    y: round3((picture.height - height) / 2),
    width: round3(width),
    height: round3(height),
  };
}

/** The raw video's size in the pixels its boxes are in: the viewport times the recording's scale. */
export function sourceSize(
  timeline: Pick<Timeline, "viewport" | "scale">,
): Size {
  const scale = timeline.scale ?? 1;
  return {
    width: timeline.viewport.width * scale,
    height: timeline.viewport.height * scale,
  };
}

/** A box of the raw video (`source` pixels) as picture pixels. */
export function toPicture(box: Box, source: Size, picture: Size): Box {
  const rect = fitRect(source, picture);
  const s = rect.width / source.width;
  return {
    x: round3(rect.x + box.x * s),
    y: round3(rect.y + box.y * s),
    width: round3(box.width * s),
    height: round3(box.height * s),
  };
}

/** The camera's view for a box: the box with a margin, at the picture's aspect, no closer than maxZoom, inside the picture. */
export function viewFor(box: Box, picture: Size, maxZoom = 2): Box {
  const aspect = picture.width / picture.height;
  const margin = Math.max(48, 0.12 * Math.max(box.width, box.height));
  let w = box.width + 2 * margin;
  let h = box.height + 2 * margin;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  const minW = picture.width / Math.max(1, maxZoom);
  if (w < minW) {
    w = minW;
    h = w / aspect;
  }
  if (w > picture.width) {
    w = picture.width;
    h = picture.height;
  }
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const x = Math.min(Math.max(0, cx - w / 2), picture.width - w);
  const y = Math.min(Math.max(0, cy - h / 2), picture.height - h);
  return { x: round3(x), y: round3(y), width: round3(w), height: round3(h) };
}

/** Where the camera looks at a moment. */
export interface CameraKey {
  t: number;
  view: Box;
}

/** A zoom to a box in picture pixels, from `at` to `until` seconds of the output. */
export interface ZoomMove {
  box: Box;
  at: number;
  until: number;
}

/** Seconds a camera move takes by default. */
export const CAMERA_MOVE = 0.8;

/**
 * The camera's keyframes: the full picture, eased into each move's view,
 * held, then back out, or straight on to the next view when the next move
 * starts within a move's time. A move too short to get in and out is
 * skipped.
 */
export function cameraKeys(
  moves: readonly ZoomMove[],
  picture: Size,
  o: { maxZoom?: number; move?: number } = {},
): CameraKey[] {
  const move = o.move ?? CAMERA_MOVE;
  const full: Box = {
    x: 0,
    y: 0,
    width: picture.width,
    height: picture.height,
  };
  const keys: CameraKey[] = [{ t: 0, view: full }];
  const sorted = [...moves].sort((a, b) => a.at - b.at);
  sorted.forEach((m, i) => {
    const last = keys.at(-1)!;
    const at = Math.max(m.at, last.t);
    if (at + move > m.until) return;
    const view = viewFor(m.box, picture, o.maxZoom);
    if (at > last.t) keys.push({ t: round3(at), view: last.view });
    keys.push({ t: round3(at + move), view });
    keys.push({ t: round3(m.until), view });
    const next = sorted[i + 1];
    if (!next || next.at > m.until + move)
      keys.push({ t: round3(m.until + move), view: full });
  });
  return keys;
}

const num = (n: number) => String(round3(n));

/** One coordinate of the camera as an ffmpeg expression of the frame number, eased between keyframes. */
export function keyExpr(
  keys: readonly CameraKey[],
  pick: (b: Box) => number,
  fps: number,
): string {
  const T = `(in/${fps})`;
  let expr = num(pick(keys.at(-1)!.view));
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    const va = pick(a.view);
    const vb = pick(b.view);
    const span = b.t - a.t;
    const u = `((${T}-${num(a.t)})/${num(span)})`;
    const piece =
      va === vb || span <= 0
        ? num(va)
        : `${num(va)}+${num(vb - va)}*${u}*${u}*(3-2*${u})`;
    expr = `if(lt(${T},${num(b.t)}),${piece},${expr})`;
  }
  return expr;
}

/** The filter that moves the camera along the keys; undefined when it never leaves the full picture. */
export function cameraFilter(
  keys: readonly CameraKey[],
  picture: Size,
  fps: number,
): string | undefined {
  if (
    keys.every(
      (k) =>
        k.view.x === 0 &&
        k.view.y === 0 &&
        k.view.width === picture.width &&
        k.view.height === picture.height,
    )
  )
    return undefined;
  const x = keyExpr(keys, (b) => b.x, fps);
  const y = keyExpr(keys, (b) => b.y, fps);
  const w = keyExpr(keys, (b) => b.width, fps);
  const h = keyExpr(keys, (b) => b.height, fps);
  const right = `(${x})+(${w})`;
  const bottom = `(${y})+(${h})`;
  return (
    `perspective=x0='${x}':y0='${y}':x1='${right}':y1='${y}'` +
    `:x2='${x}':y2='${bottom}':x3='${right}':y3='${bottom}'` +
    `:sense=source:eval=frame:interpolation=cubic`
  );
}

/** Where the camera looks at `t`, as cameraFilter draws it. */
export function cameraView(
  keys: readonly CameraKey[],
  t: number,
  picture: Size,
): Box {
  if (keys.length === 0)
    return { x: 0, y: 0, width: picture.width, height: picture.height };
  if (t <= keys[0]!.t) return keys[0]!.view;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t >= b.t) continue;
    const span = b.t - a.t;
    if (span <= 0) return b.view;
    const u = (t - a.t) / span;
    const e = u * u * (3 - 2 * u);
    const mix = (pick: (v: Box) => number) =>
      pick(a.view) + (pick(b.view) - pick(a.view)) * e;
    return {
      x: mix((v) => v.x),
      y: mix((v) => v.y),
      width: mix((v) => v.width),
      height: mix((v) => v.height),
    };
  }
  return keys.at(-1)!.view;
}

/** A box of the picture as the frame shows it through the camera's view. */
export function boxInView(box: Box, view: Box, picture: Size): Box {
  const sx = picture.width / view.width;
  const sy = picture.height / view.height;
  return {
    x: round3((box.x - view.x) * sx),
    y: round3((box.y - view.y) * sy),
    width: round3(box.width * sx),
    height: round3(box.height * sy),
  };
}

/** The last action box of a step, of the kinds given, in viewport CSS pixels. */
export function stepBox(
  step: TimelineStep,
  kinds: readonly string[],
): Box | undefined {
  return (
    [...(step.actions ?? [])]
      .reverse()
      .find((a) => a.box && kinds.includes(a.kind))?.box ?? undefined
  );
}

/**
 * A zoom move for each highlight the recorder drew on a highlighted, visible
 * step: from the highlight to the step's end (its hold included), on the
 * output timeline, in picture pixels.
 */
export function zoomMoves(
  steps: readonly TimelineStep[],
  highlighted: ReadonlySet<number>,
  plan: Pick<EditPlan, "pieces" | "fps" | "steps">,
  source: Size,
  picture: Size,
): ZoomMove[] {
  const moves: ZoomMove[] = [];
  for (const step of steps) {
    const time = plan.steps.get(step.index);
    if (!time || !highlighted.has(step.index)) continue;
    for (const a of step.actions ?? []) {
      if (a.kind !== "highlight" || !a.box) continue;
      const at = outputTime(plan, a.atMs / 1000);
      if (at === undefined) continue;
      moves.push({
        box: toPicture(a.box, source, picture),
        at,
        until: time.end,
      });
    }
  }
  return moves.sort((a, b) => a.at - b.at);
}

/** Where a callout's label goes: below the target when it fits, else above. */
export function calloutPlacement(
  box: Box,
  picture: Size,
  labelHeight = 120,
): "below" | "above" {
  return box.y + box.height + 60 + labelHeight <= picture.height - 20
    ? "below"
    : "above";
}

/** A stretch of the output timeline. */
export interface Span {
  start: number;
  end: number;
}

/** Spans closer than `gap` merged into one. */
export function mergeSpans(spans: readonly Span[], gap: number): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && s.start - last.end < gap) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

/** The music bed's levels in dB against full scale of the narration. */
export interface BedLevels {
  /** Where nobody speaks. Default -16. */
  open?: number;
  /** Under the voice. Default -26. */
  under?: number;
  /** Seconds the bed fades in and out at the video's ends. Default 0.5 and 2. */
  fadeIn?: number;
  fadeOut?: number;
}

/**
 * The bed's linear gain at `t`: `open` between phrases, ducked to `under`
 * from 0.3 s before speech until 0.8 s after it (phrases under two seconds
 * apart duck as one, so the bed never pumps), faded at both ends.
 */
export function bedGain(
  t: number,
  speech: readonly Span[],
  duration: number,
  levels: BedLevels = {},
): number {
  const open = levels.open ?? -16;
  const under = levels.under ?? -26;
  const attack = 0.3;
  const release = 0.8;
  let duck = 0;
  for (const s of speech) {
    if (t >= s.start && t <= s.end) {
      duck = 1;
      break;
    }
    if (t < s.start && t > s.start - attack)
      duck = Math.max(duck, 1 - (s.start - t) / attack);
    if (t > s.end && t < s.end + release)
      duck = Math.max(duck, 1 - (t - s.end) / release);
  }
  const db = open + (under - open) * duck;
  const fade = Math.min(
    1,
    Math.max(0, t / (levels.fadeIn ?? 0.5)),
    Math.max(0, (duration - t) / (levels.fadeOut ?? 2)),
  );
  return Math.pow(10, db / 20) * fade;
}

/**
 * Narration (mono) and an optional music bed (interleaved stereo, looped to
 * length) mixed to interleaved stereo, the bed ducked under `speech`; the
 * mix is scaled down if it would peak above 0.97.
 */
export function mixAudio(
  narration: Float32Array,
  rate: number,
  bed?: { pcm: Float32Array; speech: readonly Span[]; levels?: BedLevels },
): Float32Array {
  const frames = narration.length;
  const out = new Float32Array(frames * 2);
  const duration = frames / rate;
  const bedFrames = bed ? Math.floor(bed.pcm.length / 2) : 0;
  const speech = bed ? mergeSpans(bed.speech, 2) : [];
  let peak = 0;
  let gain = 0;
  for (let i = 0; i < frames; i++) {
    if (bed && bedFrames > 0 && i % 64 === 0)
      gain = bedGain(i / rate, speech, duration, bed.levels);
    const v = narration[i]!;
    const j = bedFrames > 0 ? i % bedFrames : 0;
    const l = v + (bedFrames > 0 ? bed!.pcm[j * 2]! * gain : 0);
    const r = v + (bedFrames > 0 ? bed!.pcm[j * 2 + 1]! * gain : 0);
    out[i * 2] = l;
    out[i * 2 + 1] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  if (peak > 0.97) {
    const k = 0.97 / peak;
    for (let i = 0; i < out.length; i++) out[i]! *= k;
  }
  return out;
}
