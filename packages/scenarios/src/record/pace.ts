/** How a recording is paced: typing per character, a pause after each action, a reading pause after each check. */
export interface Pace {
  typeMsPerChar: number;
  afterActionMs: number;
  readMs: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const DEFAULT_PACE: Pace = {
  typeMsPerChar: 60,
  afterActionMs: 600,
  readMs: 1200,
};

export const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 };

/** The defaults with each key the override sets. */
export function mergePace(defaults: Pace, override?: Partial<Pace>): Pace {
  return { ...defaults, ...override };
}

/** How long typing `text` takes. */
export function typingMs(text: string, pace: Pace): number {
  return [...text].length * pace.typeMsPerChar;
}

/** Cursor travel time: 350 to 800 ms by distance, none for a move under a pixel. */
export function travelMs(from: Point, to: Point): number {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d < 1) return 0;
  return Math.round(Math.min(800, Math.max(350, d * 0.9)));
}

export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** The points an eased cursor move passes through, one per frame, ending exactly at `to`. */
export function cursorPath(from: Point, to: Point, frameMs = 16): Point[] {
  const ms = travelMs(from, to);
  if (ms === 0) return [];
  const n = Math.max(1, Math.ceil(ms / frameMs));
  return Array.from({ length: n }, (_, i) => {
    const k = easeInOut((i + 1) / n);
    return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
  });
}

/**
 * The pause that ends a step: a check (Then) is held for reading, any other step for the
 * after-action pause unless its last media action already paused; a hidden step is never paced.
 */
export function settleMs(
  step: { kind: StepKind; hidden: boolean; actedLast: boolean },
  pace: Pace,
): number {
  if (step.hidden) return 0;
  if (step.kind === "outcome") return pace.readMs;
  return step.actedLast ? 0 : pace.afterActionMs;
}

/** A step's effective keyword type, And and But taking the one before them. */
export type StepKind = "context" | "action" | "outcome" | "unknown";
