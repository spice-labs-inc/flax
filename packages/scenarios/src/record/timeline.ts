import type { Pace, Viewport } from "./pace.ts";
import type { StepInfo } from "./steps.ts";

/** A box in viewport CSS pixels, from the top left of the viewport; the video's pixels are these times the timeline's scale. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ActionKind = "click" | "type" | "goto" | "point" | "highlight";

export interface TimelineAction {
  kind: ActionKind;
  atMs: number;
  /** Where on screen; absent for a navigation and in hidden steps. */
  box?: Box;
}

export type StepStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "pending"
  | "undefined"
  | "ambiguous"
  | "unknown";

export interface TimelineStep {
  /** 1-based among the scenario's own steps, as a sidecar counts them; 0 for a Background step. */
  index: number;
  keyword: string;
  text: string;
  hidden: boolean;
  highlight: boolean;
  /** Null for a step that never ran (one after a failure). */
  startMs: number | null;
  endMs: number | null;
  status: StepStatus;
  /** The first line of a failed step's error. */
  error?: string;
  actions: TimelineAction[];
  /** `screens/<index>.png`, the frame at the step's end; null without a page. */
  screen: string | null;
  /** `terminal/<index>.json` when the step ran commands. */
  terminal: string | null;
}

/** `timeline.json`: every time is in milliseconds from the raw video's first frame. */
export interface Timeline {
  id: string;
  scenario: string;
  feature: string;
  /** When the first frame was drawn (the scenario's start when nothing was filmed). */
  startedAt: string;
  status: "passed" | "failed";
  /** `video.webm`, or null when the scenario never opened a page. */
  video: string | null;
  viewport: Viewport;
  /** Video pixels per CSS pixel (the device scale factor). */
  scale: number;
  /** The scenario's own steps, 1 to n. */
  steps: TimelineStep[];
  /** The Background's steps, which ran first and are never filmed. */
  background: TimelineStep[];
}

/** Output a command printed, at a time. */
export interface TerminalChunk {
  atMs: number;
  text: string;
}

/** One command a step ran. */
export interface TerminalCommand {
  command: string;
  cwd?: string;
  exitCode: number | null;
  startMs: number;
  endMs: number;
  output: TerminalChunk[];
}

/**
 * `terminal/<index>.json`: the step's command (its first, when it ran several; the others are
 * in `more`) and the sidecar's override of what the scene shows, if any.
 */
export interface TerminalScene extends TerminalCommand {
  index: number;
  /** The command line to show in place of `command`. */
  display?: string;
  /** Lines typed before the command. */
  preface?: string[];
  more?: TerminalCommand[];
}

/** What a recording saw, every time in milliseconds on one clock (see SceneRecording). */
export type RecordEvent =
  | { type: "step-start"; step: string; at: number }
  | {
      type: "step-end";
      step: string;
      at: number;
      status: StepStatus;
      error?: string;
    }
  | { type: "action"; step: string; kind: ActionKind; at: number; box?: Box }
  | { type: "screen"; step: string; file: string }
  | {
      type: "terminal";
      step: string;
      command: string;
      cwd?: string;
      exitCode: number | null;
      start: number;
      end: number;
      chunks: { at: number; text: string }[];
    };

/**
 * The timeline from a recording's events. `origin` is the video's first frame on the events'
 * clock, or the scenario's start when nothing was filmed; times before it (setup before the
 * page opened) come out negative.
 */
export function buildTimeline(input: {
  id: string;
  scenario: string;
  feature: string;
  status: "passed" | "failed";
  video: string | null;
  viewport: Viewport;
  scale: number;
  steps: readonly StepInfo[];
  hidden: ReadonlySet<number>;
  highlighted: ReadonlySet<number>;
  terminal?: readonly { at: number; display?: string; preface: string[] }[];
  events: readonly RecordEvent[];
  origin: number;
  /** The origin as a wall-clock time in ms since the epoch. */
  originWallMs: number;
}): { timeline: Timeline; terminals: TerminalScene[] } {
  const rel = (at: number) => Math.round(at - input.origin);
  const terminals: TerminalScene[] = [];
  const entry = (s: StepInfo): TimelineStep => {
    const mine = input.events.filter((e) => e.step === s.id);
    const start = mine.find((e) => e.type === "step-start");
    const end = mine.find((e) => e.type === "step-end");
    const screen = mine.find((e) => e.type === "screen");
    const commands = mine.flatMap((e): TerminalCommand[] =>
      e.type === "terminal"
        ? [
            {
              command: e.command,
              ...(e.cwd !== undefined ? { cwd: e.cwd } : {}),
              exitCode: e.exitCode,
              startMs: rel(e.start),
              endMs: rel(e.end),
              output: e.chunks.map((c) => ({ atMs: rel(c.at), text: c.text })),
            },
          ]
        : [],
    );
    const own = !s.background;
    const [first, ...more] = commands;
    if (own && first) {
      const override = input.terminal?.find((t) => t.at === s.index);
      terminals.push({
        index: s.index,
        ...first,
        ...(override?.display !== undefined
          ? { display: override.display }
          : {}),
        ...(override && override.preface.length > 0
          ? { preface: override.preface }
          : {}),
        ...(more.length > 0 ? { more } : {}),
      });
    }
    return {
      index: s.index,
      keyword: s.keyword,
      text: s.text,
      hidden: s.background || input.hidden.has(s.index),
      highlight: own && input.highlighted.has(s.index),
      startMs: start ? rel(start.at) : null,
      endMs: end ? rel(end.at) : null,
      status: end?.type === "step-end" ? end.status : "skipped",
      ...(end?.type === "step-end" && end.error !== undefined
        ? { error: end.error }
        : {}),
      actions: mine.flatMap((e): TimelineAction[] =>
        e.type === "action"
          ? [
              {
                kind: e.kind,
                atMs: rel(e.at),
                ...(e.box ? { box: e.box } : {}),
              },
            ]
          : [],
      ),
      screen: own && screen?.type === "screen" ? screen.file : null,
      terminal: own && first ? `terminal/${s.index}.json` : null,
    };
  };
  return {
    timeline: {
      id: input.id,
      scenario: input.scenario,
      feature: input.feature,
      startedAt: new Date(input.originWallMs).toISOString(),
      status: input.status,
      video: input.video,
      viewport: input.viewport,
      scale: input.scale,
      steps: input.steps.filter((s) => !s.background).map(entry),
      background: input.steps.filter((s) => s.background).map(entry),
    },
    terminals,
  };
}

/**
 * A terminal scene as an asciicast v2 recording: the preface and then the command (its display
 * form when the sidecar gives one) typed at the recording's pace after a `$ ` prompt, the output
 * chunks at their times after the command started, and the closing prompt.
 */
export function terminalCast(
  scene: TerminalScene,
  pace: Pace,
  size: { cols: number; rows: number } = { cols: 100, rows: 30 },
): string {
  const events: [number, "o", string][] = [];
  let t = 0;
  const at = (ms: number) => Math.round(ms) / 1000;
  const typeLine = (line: string) => {
    events.push([at(t), "o", "$ "]);
    for (const ch of line) {
      t += pace.typeMsPerChar;
      events.push([at(t), "o", ch]);
    }
    t += pace.afterActionMs / 2;
    events.push([at(t), "o", "\r\n"]);
  };
  const lines: string[] = [];
  for (const line of scene.preface ?? []) {
    typeLine(line);
    lines.push(`$ ${line}`);
  }
  for (const [i, c] of [scene, ...(scene.more ?? [])].entries()) {
    const shown = i === 0 ? (scene.display ?? c.command) : c.command;
    typeLine(shown);
    lines.push(`$ ${shown}`);
    const started = t;
    for (const chunk of c.output) {
      t = Math.max(t, started + chunk.atMs - c.startMs);
      events.push([at(t), "o", chunk.text.replace(/\r?\n/g, "\r\n")]);
      lines.push(...chunk.text.split("\n"));
    }
    t = Math.max(t, started + c.endMs - c.startMs);
    const last = c.output.at(-1)?.text ?? "";
    if (last !== "" && !last.endsWith("\n")) events.push([at(t), "o", "\r\n"]);
  }
  events.push([at(t), "o", "$ "]);
  const width = Math.max(size.cols, ...lines.map((l) => l.length));
  return (
    [
      JSON.stringify({
        version: 2,
        width: Math.min(width, 240),
        height: size.rows,
        idle_time_limit: 2,
      }),
      ...events.map((e) => JSON.stringify(e)),
    ].join("\n") + "\n"
  );
}
