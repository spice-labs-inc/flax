import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

// A record run's directory as the scenario recorder writes it (video.webm,
// timeline.json, screens/, terminal/ and a copy of the sidecar), and the
// video sidecar the renderer reads from it. The sidecar's schema lives with
// the scenario runner; these types are the fields the renderer uses.

/** A rectangle in pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Something the recorder did during a step, in milliseconds from the raw video's first frame. */
export interface TimelineAction {
  kind: "click" | "type" | "goto" | "point" | "highlight" | (string & {});
  atMs: number;
  /** In video pixels: viewport CSS pixels times the timeline's scale. */
  box?: Box | null;
}

/** One step of the recorded scenario. */
export interface TimelineStep {
  /** 1-based, as a sidecar counts them; 0 for a Background step. */
  index: number;
  background?: boolean;
  /** As written in the feature: And and But included. */
  keyword: string;
  text: string;
  hidden?: boolean;
  highlight?: boolean;
  /** Null for a step that never ran. */
  startMs: number | null;
  endMs: number | null;
  status: string;
  error?: string;
  actions?: TimelineAction[];
  /** The frame at the step's end, relative to the record directory. */
  screen?: string | null;
  /** The step's terminal transcript, relative to the record directory. */
  terminal?: string | null;
}

/** A browser viewport in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

/** timeline.json. */
export interface Timeline {
  id: string;
  scenario: string;
  feature?: string;
  startedAt?: string;
  status?: string;
  /** The raw video relative to the record directory; null when the scenario never opened a page. */
  video?: string | null;
  viewport: Viewport;
  /** Video pixels per viewport CSS pixel. Default 1. */
  scale?: number;
  steps: TimelineStep[];
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
  exitCode?: number | null;
  startMs: number;
  endMs: number;
  output: TerminalChunk[];
}

/** terminal/<index>.json: the step's first command, the others in `more`, and the sidecar's display and preface as the recorder applied them. */
export interface TerminalScene extends TerminalCommand {
  index: number;
  display?: string;
  preface?: string[];
  more?: TerminalCommand[];
}

/** A step a sidecar names: its 1-based index or its exact text, with the keyword as written. */
export type StepRef = number | string;

/** What a card before or after the recording says. */
export interface CardContent {
  /** A chapter starting at the card. */
  chapter?: string;
  heading: string;
  sub?: string;
  items?: (string | { label: string; icon?: string })[];
  /** Spoken over the card. */
  text?: string;
}

/** How a terminal step is shown: another command line, lines typed before it, or a recording in its place. */
export interface TerminalOverride {
  at: StepRef;
  /** The command line shown in place of the one that ran; a list replaces the step's commands in order. */
  display?: string | string[];
  /** Lines typed before the step's commands, such as an export; stand-ins apply to them. */
  preface?: string[];
  /** An asciicast v2 file shown in place of the transcript, relative to the record directory or absolute. */
  cast?: string;
}

/** The video sidecar's fields the renderer reads. */
export interface Sidecar {
  scenario: string;
  id: string;
  title: string;
  description?: string;
  voice?: string;
  pace?: { typeMsPerChar?: number; afterActionMs?: number; readMs?: number };
  viewport?: Viewport;
  intro?: CardContent;
  outro?: CardContent;
  narration?: { at: StepRef; text: string }[];
  chapters?: { at: StepRef; title: string }[];
  highlight?: "then" | "none" | StepRef[];
  hide?: StepRef[];
  poster?: { at: StepRef; title?: string; kicker?: string };
  terminal?: TerminalOverride | TerminalOverride[];
  standIns?: string;
  publish?: Record<string, unknown>;
}

/** A record run read from its directory. */
export interface Recording {
  dir: string;
  /** The raw video, or undefined when nothing was filmed. */
  video?: string;
  timeline: Timeline;
  sidecar: Sidecar;
}

/** Why a recording cannot be rendered: a failed scenario, or a step that did not pass. */
export function recordingProblem(timeline: Timeline): string | undefined {
  if (timeline.status !== undefined && timeline.status !== "passed")
    return `the recording of ${timeline.scenario} is marked ${timeline.status}`;
  if (timeline.steps.length === 0)
    return `the recording of ${timeline.scenario} has no steps`;
  const bad = timeline.steps.find((s) => s.status !== "passed");
  if (bad)
    return `step ${bad.index} (${bad.keyword.trim()} ${bad.text}) of ${timeline.scenario} is ${bad.status}`;
  return undefined;
}

/** Throws when the recording is of a failed run; a video never shows a flow that did not pass. */
export function refuseFailed(timeline: Timeline): void {
  const problem = recordingProblem(timeline);
  if (problem) throw new Error(`refusing to render: ${problem}`);
}

const KEYWORD = /^(Given|When|Then|And|But|\*)\s+/;
const norm = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * The step a reference names: by index, by its keyword as written and text,
 * or by its text alone when only one step has it.
 */
export function resolveStep(
  steps: readonly TimelineStep[],
  ref: StepRef,
): TimelineStep {
  const own = steps.filter((s) => !s.background);
  if (typeof ref === "number") {
    const found = own.find((s) => s.index === ref);
    if (!found) throw new Error(`no step ${ref} in the recording`);
    return found;
  }
  const want = norm(ref);
  const exact = own.find((s) => norm(`${s.keyword} ${s.text}`) === want);
  if (exact) return exact;
  const bare = want.replace(KEYWORD, "");
  const byText = own.filter((s) => norm(s.text) === bare);
  if (byText.length === 1) return byText[0]!;
  throw new Error(
    byText.length > 1
      ? `step "${ref}" is ambiguous: steps ${byText.map((s) => s.index).join(", ")} have its text`
      : `no step "${ref}" in the recording`,
  );
}

/**
 * The steps cut from the video: Background steps, then what the recorder
 * marked, else the sidecar's `hide` list, else every Given.
 */
export function hiddenSteps(
  steps: readonly TimelineStep[],
  sidecar: Pick<Sidecar, "hide">,
): Set<number> {
  const listed = sidecar.hide?.map((r) => resolveStep(steps, r).index);
  return new Set(
    steps
      .filter((s) =>
        s.background
          ? true
          : typeof s.hidden === "boolean"
            ? s.hidden
            : listed
              ? listed.includes(s.index)
              : s.keyword.trim() === "Given",
      )
      .map((s) => s.index),
  );
}

/** The steps the recorder highlighted, else the ones the sidecar asks for (every Then by default). */
export function highlightedSteps(
  steps: readonly TimelineStep[],
  sidecar: Pick<Sidecar, "highlight">,
): Set<number> {
  const h = sidecar.highlight ?? "then";
  const listed = Array.isArray(h)
    ? h.map((r) => resolveStep(steps, r).index)
    : undefined;
  return new Set(
    steps
      .filter((s) =>
        s.background
          ? false
          : typeof s.highlight === "boolean"
            ? s.highlight
            : listed
              ? listed.includes(s.index)
              : h === "then" && s.keyword.trim() === "Then",
      )
      .map((s) => s.index),
  );
}

const SIDECAR = /\.video\.ya?ml$|^sidecar\.ya?ml$/;

/**
 * Reads a record directory: its timeline, the raw video and the sidecar
 * (the one given, else the copy the recorder left there whose `scenario`
 * is the timeline's).
 */
export async function readRecording(
  dir: string,
  sidecar?: Sidecar,
): Promise<Recording> {
  const timeline = JSON.parse(
    await readFile(join(dir, "timeline.json"), "utf8"),
  ) as Timeline;
  let side = sidecar;
  if (!side) {
    const found: Sidecar[] = [];
    for (const name of (await readdir(dir)).filter((n) => SIDECAR.test(n)))
      found.push(parse(await readFile(join(dir, name), "utf8")) as Sidecar);
    const mine = found.filter((s) => s.scenario === timeline.scenario);
    if (mine.length !== 1)
      throw new Error(
        mine.length === 0
          ? `${dir}: no sidecar (*.video.yml) for "${timeline.scenario}" in the record directory; pass one`
          : `${dir}: more than one sidecar for "${timeline.scenario}"; pass one`,
      );
    side = mine[0]!;
  }
  const video =
    timeline.video === null
      ? undefined
      : join(dir, timeline.video ?? "video.webm");
  return {
    dir,
    ...(video && existsSync(video) ? { video } : {}),
    timeline,
    sidecar: side,
  };
}

/** The sidecar's terminal override for a step, if any. */
export function terminalOverride(
  steps: readonly TimelineStep[],
  sidecar: Pick<Sidecar, "terminal">,
  index: number,
): TerminalOverride | undefined {
  const all =
    sidecar.terminal === undefined
      ? []
      : Array.isArray(sidecar.terminal)
        ? sidecar.terminal
        : [sidecar.terminal];
  return all.find((t) => resolveStep(steps, t.at).index === index);
}
