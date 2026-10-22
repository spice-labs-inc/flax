import { MIN_CHAPTERS, MIN_CHAPTER_SECONDS } from "../output-check/youtube.ts";
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
  /** Seconds a narrated scene's picture may run on after the block's last word; the rest of the scene is cut. Default: no limit. */
  maxTail?: number;
  /** Long waits: the part of a step no narration is spoken over, when longer than `after` seconds, plays sped up to last `seconds`; false plays every step at its own pace. */
  idle?: IdleOptions | false;
}

/** How a long unnarrated stretch of a step is sped up. */
export interface IdleOptions {
  /** Seconds an unnarrated stretch may last before it is sped up. Default 10. */
  after?: number;
  /** Seconds a sped-up stretch lasts. Default 4. */
  seconds?: number;
  /** Shows the speed-up (x40) in a corner of the picture while it lasts. Default true. */
  badge?: boolean;
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
  /** Seconds cut from the start and the end of a step's raw video, by step. */
  trims?: ReadonlyMap<number, { start?: number; end?: number }>;
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
      /** A long unnarrated stretch, sped up. */
      idle?: boolean;
    }
  | {
      kind: "hold";
      /** The raw video's time of the held frame. */ at: number;
      start: number;
      frames: number;
    }
  | {
      kind: "terminal";
      step: number;
      start: number;
      frames: number;
      /** From `at` seconds into the replay, its writes come `speed` times faster. */
      idle?: { at: number; speed: number };
    }
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
  /** The sped-up stretches on the output timeline. */
  idle: IdleSpan[];
  frames: number;
  duration: number;
}

/** A sped-up stretch of the output and how many times faster it plays. */
export interface IdleSpan {
  start: number;
  end: number;
  speed: number;
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
  const idle =
    opts.idle === false
      ? undefined
      : { after: opts.idle?.after ?? 10, seconds: opts.idle?.seconds ?? 4 };
  if (idle && !(idle.seconds > 0 && idle.seconds < idle.after))
    throw new Error(
      `idle.seconds (${idle.seconds}) must be more than 0 and less than idle.after (${idle.after})`,
    );
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
  const idleSpans: IdleSpan[] = [];
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

  for (const index of input.trims?.keys() ?? [])
    if (input.terminals?.has(index))
      throw new Error(
        `step ${index} is a terminal scene; a trim cuts only a step's raw video`,
      );
  // A step's raw video, its trim cut off.
  const span = (s: TimelineStep): [number, number] => {
    const trim = input.trims?.get(s.index);
    const a = begin(s) + (trim?.start ?? 0);
    return [a, Math.max(a, end(s) - (trim?.end ?? 0))];
  };

  for (const group of groups) {
    const terminal = (s: TimelineStep) => input.terminals?.get(s.index);
    const srcLength = group.steps.reduce((n, s) => {
      const [a, b] = span(s);
      return terminal(s) === undefined ? n + (b - a) : n;
    }, 0);
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
    const room = () =>
      audio === undefined || opts.maxTail === undefined
        ? Infinity
        : leadIn + audio + opts.maxTail - f2s(frame - sceneStart, fps);
    // Contiguous steps share one clip, so a cut only falls where a step was hidden.
    let clip: Extract<Piece, { kind: "clip" }> | undefined;
    let lastSrc = 0;
    // Seconds of a step played at its scene's pace; what follows plays sped up.
    const paced = (length: number) => {
      if (!idle) return length;
      const spoken = Math.min(
        length,
        Math.max(0, need - f2s(frame - sceneStart, fps)),
      );
      return length - spoken > idle.after ? spoken : length;
    };
    const idleFrames = idle ? Math.round(idle.seconds * fps) : 0;
    const addClip = (
      a: number,
      b: number,
      at: number,
      frames: number,
      idled: boolean,
    ) => {
      const pace = idled ? (b - a) / f2s(frames, fps) : speed;
      if (clip && Math.abs(clip.srcEnd - a) < 0.0015 && !clip.idle && !idled) {
        clip.srcEnd = b;
        clip.frames += frames;
      } else {
        clip = {
          kind: "clip",
          srcStart: a,
          srcEnd: b,
          speed: pace,
          start: at,
          frames,
          ...(idled ? { idle: true } : {}),
        };
        pieces.push(clip);
      }
      if (idled)
        idleSpans.push({ start: at, end: at + f2s(frames, fps), speed: pace });
    };
    for (const step of group.steps) {
      const [a, whole] = span(step);
      const start = f2s(frame, fps);
      const left = room();
      if (left <= 1e-9) {
        stepTimes.set(step.index, { start, end: start });
        continue;
      }
      const full = terminal(step);
      if (full !== undefined) {
        const shown = Math.min(full, left);
        const kept = paced(shown);
        const frames =
          kept < shown
            ? Math.ceil(kept * fps - 1e-9) + idleFrames
            : Math.max(1, Math.ceil(shown * fps - 1e-9));
        const fast =
          kept < shown
            ? {
                at: kept,
                speed: (shown - kept) / (f2s(frames, fps) - kept),
              }
            : undefined;
        pieces.push({
          kind: "terminal",
          step: step.index,
          start,
          frames,
          ...(fast ? { idle: fast } : {}),
        });
        if (fast)
          idleSpans.push({
            start: start + fast.at,
            end: start + f2s(frames, fps),
            speed: fast.speed,
          });
        clip = undefined;
        frame += frames;
        stepTimes.set(step.index, { start, end: f2s(frame, fps) });
        lastSrc = whole;
        continue;
      }
      const b = Math.min(whole, a + left * speed);
      const length = (b - a) / speed;
      const kept = paced(length);
      if (kept < length) {
        const keptFrames = Math.round(kept * fps);
        const split = a + f2s(keptFrames, fps) * speed;
        if (keptFrames > 0) {
          addClip(a, split, start, keptFrames, false);
          frame += keptFrames;
        }
        addClip(split, b, f2s(frame, fps), idleFrames, true);
        frame += idleFrames;
      } else {
        const frames = Math.max(1, Math.round(length * fps));
        addClip(a, b, start, frames, false);
        frame += frames;
      }
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
    idle: idleSpans,
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
 * Chapters as YouTube shows them: whole seconds, the first at 0, a chapter
 * starting less than `minSeconds` (default 10) after the one kept before
 * it folded into that one, and the last folded too when it starts less
 * than `minSeconds` before the end; none when fewer than three remain.
 */
export function youtubeChapters(
  chapters: readonly Chapter[],
  duration: number,
  opts: { minSeconds?: number } = {},
): Chapter[] {
  const min = opts.minSeconds ?? MIN_CHAPTER_SECONDS;
  const out: Chapter[] = [];
  for (const c of [...chapters].sort((a, b) => a.start - b.start)) {
    const start = out.length === 0 ? 0 : Math.floor(c.start);
    const prev = out.at(-1);
    if (prev && start - prev.start < min) continue;
    out.push({ start, title: c.title });
  }
  while (out.length > 1 && duration - out.at(-1)!.start < min) out.pop();
  return out.length >= MIN_CHAPTERS ? out : [];
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
