import {
  hiddenSteps,
  highlightedSteps,
  resolveStep,
  type Sidecar,
  type StepRef,
  type TimelineStep,
} from "./recording.ts";

// The edit of a record run, as pure arithmetic: which stretches of the raw
// video play, in what order and at what speed, where the picture holds its
// last frame so a narration block can finish, and where each step, block,
// chapter and card lands on the output timeline. Every length is a whole
// number of frames, so the picture and the audio agree to the frame.

/** Frames per second of every rendered video. */
export const FPS = 30;

/** How the edit fits the picture to the narration. */
export interface EditOptions {
  /** Seconds from a block's step starting to its first word. Default 0. */
  leadIn?: number;
  /** Seconds the picture runs on after a block's last word before the next block's step. Default 0.5. */
  tail?: number;
  /** The fastest a scene's picture may play to fit a shorter narration. Default 1: nothing is sped up. */
  maxSpeed?: number;
}

/** A card before or after the recording: at least `seconds` long, longer when its narration needs it. */
export interface CardTime {
  seconds: number;
  /** Seconds of the card's narration, if it has one. */
  narration?: number;
}

/** What the edit is planned from. */
export interface EditInput {
  steps: readonly TimelineStep[];
  /** Steps cut from the video. */
  hidden: ReadonlySet<number>;
  /** Each narration block's step (any step; a hidden one moves to the next visible step) and its audio length. */
  narration: readonly { step: number; seconds: number }[];
  /** Steps shown as a terminal scene in place of the raw video, and the scene's length in seconds. */
  terminals?: ReadonlyMap<number, number>;
  titleCard?: CardTime;
  endCard?: CardTime;
}

/** A stretch of the output video. */
export type Piece =
  | {
      kind: "clip";
      /** Seconds of the raw video. */
      srcStart: number;
      srcEnd: number;
      speed: number;
      start: number;
      frames: number;
    }
  | {
      kind: "hold";
      /** The raw video's time of the held frame. */ at: number;
      start: number;
      frames: number;
    }
  | { kind: "terminal"; step: number; start: number; frames: number }
  | { kind: "card"; card: "title" | "end"; start: number; frames: number };

/** A run of visible steps that starts at a narrated step (or the first visible one). */
export interface Scene {
  steps: number[];
  start: number;
  end: number;
  speed: number;
  /** Seconds the last frame is held. */
  hold: number;
  /** The narration block spoken over it, by its position in the input. */
  narration?: number;
}

/** Where a step is in the output, its hold included for a scene's last step. */
export interface StepTime {
  start: number;
  end: number;
}

/** The planned edit. */
export interface EditPlan {
  fps: number;
  pieces: Piece[];
  scenes: Scene[];
  steps: Map<number, StepTime>;
  /** Each narration block's start, in the input's order. */
  narration: number[];
  titleCard?: { start: number; end: number; narration?: number };
  endCard?: { start: number; end: number; narration?: number };
  frames: number;
  duration: number;
}

const f2s = (frames: number, fps: number) => frames / fps;
const begin = (s: TimelineStep) => (s.startMs ?? 0) / 1000;
const end = (s: TimelineStep) => (s.endMs ?? s.startMs ?? 0) / 1000;

/** The first visible step at or after `index`. */
export function visibleFrom(
  steps: readonly TimelineStep[],
  hidden: ReadonlySet<number>,
  index: number,
): TimelineStep | undefined {
  return [...steps]
    .sort((a, b) => a.index - b.index)
    .find((s) => s.index >= index && !hidden.has(s.index));
}

/**
 * Plans the edit: hidden steps cut, the visible ones in scenes, each
 * narration block starting at its step (after the lead-in) and the scene's
 * last frame held until the block and its tail are done. A scene longer than
 * its narration plays at its own pace unless `maxSpeed` allows speeding it
 * up. Throws when no step is visible, a block has no visible step at or
 * after its own, or two blocks land on one step.
 */
export function planEdit(
  input: EditInput,
  opts: EditOptions = {},
  fps = FPS,
): EditPlan {
  const leadIn = opts.leadIn ?? 0;
  const tail = opts.tail ?? 0.5;
  const maxSpeed = Math.max(1, opts.maxSpeed ?? 1);
  const visible = [...input.steps]
    .sort((a, b) => a.index - b.index)
    .filter((s) => !input.hidden.has(s.index));
  if (visible.length === 0)
    throw new Error("every step is hidden: nothing to film");

  const anchors = new Map<number, number>();
  input.narration.forEach((block, i) => {
    const step = visibleFrom(input.steps, input.hidden, block.step);
    if (!step)
      throw new Error(
        `narration block ${i + 1} (step ${block.step}) has no visible step at or after it`,
      );
    const other = anchors.get(step.index);
    if (other !== undefined)
      throw new Error(
        `narration blocks ${other + 1} and ${i + 1} both start at step ${step.index}`,
      );
    anchors.set(step.index, i);
  });

  const groups: { steps: TimelineStep[]; narration?: number }[] = [];
  for (const step of visible) {
    const block = anchors.get(step.index);
    const current = groups.at(-1);
    if (!current || block !== undefined)
      groups.push({
        steps: [step],
        ...(block === undefined ? {} : { narration: block }),
      });
    else current.steps.push(step);
  }

  const pieces: Piece[] = [];
  const scenes: Scene[] = [];
  const stepTimes = new Map<number, StepTime>();
  const narration: number[] = new Array<number>(input.narration.length).fill(0);
  let frame = 0;

  const card = (kind: "title" | "end", c: CardTime) => {
    const need = c.narration === undefined ? 0 : leadIn + c.narration + tail;
    const frames = Math.max(
      1,
      Math.ceil(Math.max(c.seconds, need) * fps - 1e-9),
    );
    const start = f2s(frame, fps);
    pieces.push({ kind: "card", card: kind, start, frames });
    frame += frames;
    return {
      start,
      end: f2s(frame, fps),
      ...(c.narration === undefined ? {} : { narration: start + leadIn }),
    };
  };

  const titleCard = input.titleCard
    ? card("title", input.titleCard)
    : undefined;

  for (const group of groups) {
    const terminal = (s: TimelineStep) => input.terminals?.get(s.index);
    const srcLength = group.steps.reduce(
      (n, s) =>
        terminal(s) === undefined ? n + Math.max(0, end(s) - begin(s)) : n,
      0,
    );
    const fixed = group.steps.reduce((n, s) => n + (terminal(s) ?? 0), 0);
    const audio =
      group.narration === undefined
        ? undefined
        : input.narration[group.narration]!.seconds;
    const need = audio === undefined ? 0 : leadIn + audio + tail;
    const speed =
      audio !== undefined &&
      maxSpeed > 1 &&
      need > fixed &&
      srcLength > need - fixed
        ? Math.min(maxSpeed, srcLength / (need - fixed))
        : 1;
    const sceneStart = frame;
    // Contiguous steps share one clip, so a cut only falls where a step was hidden.
    let clip: Extract<Piece, { kind: "clip" }> | undefined;
    let lastSrc = 0;
    for (const step of group.steps) {
      const a = begin(step);
      const b = Math.max(a, end(step));
      const start = f2s(frame, fps);
      const shown = terminal(step);
      if (shown !== undefined) {
        const frames = Math.max(1, Math.ceil(shown * fps - 1e-9));
        pieces.push({ kind: "terminal", step: step.index, start, frames });
        clip = undefined;
        frame += frames;
        stepTimes.set(step.index, { start, end: f2s(frame, fps) });
        lastSrc = b;
        continue;
      }
      const frames = Math.max(1, Math.round(((b - a) / speed) * fps));
      if (clip && Math.abs(clip.srcEnd - a) < 0.0015) {
        clip.srcEnd = b;
        clip.frames += frames;
      } else {
        clip = { kind: "clip", srcStart: a, srcEnd: b, speed, start, frames };
        pieces.push(clip);
      }
      frame += frames;
      stepTimes.set(step.index, { start, end: f2s(frame, fps) });
      lastSrc = b;
    }
    const pictureFrames = frame - sceneStart;
    const holdFrames = Math.max(
      0,
      Math.ceil(need * fps - 1e-9) - pictureFrames,
    );
    if (holdFrames > 0) {
      pieces.push({
        kind: "hold",
        at: lastSrc,
        start: f2s(frame, fps),
        frames: holdFrames,
      });
      frame += holdFrames;
      const last = group.steps.at(-1)!;
      stepTimes.get(last.index)!.end = f2s(frame, fps);
    }
    if (group.narration !== undefined)
      narration[group.narration] = f2s(sceneStart, fps) + leadIn;
    scenes.push({
      steps: group.steps.map((s) => s.index),
      start: f2s(sceneStart, fps),
      end: f2s(frame, fps),
      speed,
      hold: f2s(holdFrames, fps),
      ...(group.narration === undefined ? {} : { narration: group.narration }),
    });
  }

  const endCard = input.endCard ? card("end", input.endCard) : undefined;

  return {
    fps,
    pieces,
    scenes,
    steps: stepTimes,
    narration,
    ...(titleCard ? { titleCard } : {}),
    ...(endCard ? { endCard } : {}),
    frames: frame,
    duration: f2s(frame, fps),
  };
}

/** Where a moment of the raw video lands in the output, or undefined when it was cut. */
export function outputTime(
  plan: Pick<EditPlan, "pieces" | "fps">,
  src: number,
): number | undefined {
  for (const p of plan.pieces) {
    if (p.kind !== "clip") continue;
    if (src >= p.srcStart - 1e-6 && src <= p.srcEnd + 1e-6)
      return Math.min(
        p.start + (src - p.srcStart) / p.speed,
        p.start + p.frames / plan.fps,
      );
  }
  return undefined;
}

/** A chapter on the output timeline. */
export interface Chapter {
  start: number;
  title: string;
}

/** The sidecar's chapters, each at its step's start (the next visible step's for a hidden one), in order. */
export function chapterTimes(
  chapters: readonly { at: StepRef; title: string }[],
  steps: readonly TimelineStep[],
  hidden: ReadonlySet<number>,
  plan: Pick<EditPlan, "steps">,
): Chapter[] {
  return chapters
    .map((c) => {
      const step = visibleFrom(steps, hidden, resolveStep(steps, c.at).index);
      if (!step)
        throw new Error(
          `chapter "${c.title}" has no visible step at or after it`,
        );
      return { start: plan.steps.get(step.index)!.start, title: c.title };
    })
    .sort((a, b) => a.start - b.start);
}

/**
 * The step whose screen is the poster: the sidecar's, else the last
 * highlighted visible step, else the last visible step.
 */
export function posterStep(
  steps: readonly TimelineStep[],
  sidecar: Pick<Sidecar, "poster" | "highlight" | "hide">,
): TimelineStep {
  if (sidecar.poster) return resolveStep(steps, sidecar.poster.at);
  const hidden = hiddenSteps(steps, sidecar);
  const highlighted = highlightedSteps(steps, sidecar);
  const visible = [...steps]
    .sort((a, b) => a.index - b.index)
    .filter((s) => !hidden.has(s.index));
  const pick =
    visible.filter((s) => highlighted.has(s.index)).at(-1) ?? visible.at(-1);
  if (!pick) throw new Error("no visible step for the poster");
  return pick;
}
