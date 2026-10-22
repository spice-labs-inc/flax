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
export type StepStatus = "passed" | "failed" | "skipped" | "pending" | "undefined" | "ambiguous" | "unknown";
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
export type RecordEvent = {
    type: "step-start";
    step: string;
    at: number;
} | {
    type: "step-end";
    step: string;
    at: number;
    status: StepStatus;
    error?: string;
} | {
    type: "action";
    step: string;
    kind: ActionKind;
    at: number;
    box?: Box;
} | {
    type: "screen";
    step: string;
    file: string;
} | {
    type: "terminal";
    step: string;
    command: string;
    cwd?: string;
    exitCode: number | null;
    start: number;
    end: number;
    chunks: {
        at: number;
        text: string;
    }[];
};
/**
 * The timeline from a recording's events. `origin` is the video's first frame on the events'
 * clock, or the scenario's start when nothing was filmed; times before it (setup before the
 * page opened) come out negative.
 */
export declare function buildTimeline(input: {
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
    terminal?: readonly {
        at: number;
        display?: string;
        preface: string[];
    }[];
    events: readonly RecordEvent[];
    origin: number;
    /** The origin as a wall-clock time in ms since the epoch. */
    originWallMs: number;
}): {
    timeline: Timeline;
    terminals: TerminalScene[];
};
/**
 * A terminal scene as an asciicast v2 recording: the preface and then the command (its display
 * form when the sidecar gives one) typed at the recording's pace after a `$ ` prompt, the output
 * chunks at their times after the command started, and the closing prompt.
 */
export declare function terminalCast(scene: TerminalScene, pace: Pace, size?: {
    cols: number;
    rows: number;
}): string;
