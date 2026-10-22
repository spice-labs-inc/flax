import type { Locator, Page } from "playwright";
import { type Viewport } from "./pace.ts";
import type { PlannedRecording, RecordOptions } from "./plan.ts";
import type { StepInfo } from "./steps.ts";
import { type StepStatus, type Timeline } from "./timeline.ts";
/** A command a step ran, for the recording's terminal scene. */
export interface TerminalEntry {
    command: string;
    /** What it printed: all of it, or in chunks at their times after the command started. */
    output: string | {
        afterMs: number;
        text: string;
    }[];
    cwd?: string;
    exitCode?: number | null;
    /** How long it ran; it is taken to have ended when it is reported. */
    durationMs?: number;
}
/**
 * What steps tell a recording about what they do. Outside a recorded scenario `pointAt`,
 * `highlight` and `terminal` do nothing and `click` and `type` act at once (a click, a fill),
 * so a step written against it runs the same in every run.
 */
export interface Media {
    /** True while this scenario is being recorded. */
    readonly recording: boolean;
    /** Moves the cursor to the element. */
    pointAt(target: Locator): Promise<void>;
    /** In a step the sidecar highlights: moves the cursor to the element and draws a box around it until the step ends. */
    highlight(target: Locator): Promise<void>;
    /** Moves the cursor to the element and clicks it, then pauses. */
    click(target: Locator): Promise<void>;
    /** Moves the cursor to the field, clicks it and types the text a character at a time, then pauses. */
    type(target: Locator, text: string): Promise<void>;
    /** Keeps a command's transcript for the step running now. */
    terminal(entry: TerminalEntry): void;
}
/** The media of a scenario that is not being recorded. */
export declare const plainMedia: Media;
/**
 * Runs in every document of a recorded page: a cursor that follows the mouse events the
 * recording sends (a screencast shows none) and a ripple on each press.
 */
export declare const cursorScript: (color: string) => string;
/**
 * One scenario being recorded: the page's screencast (the raw video), the cursor, the pacing,
 * and the events the timeline is built from. The base World and hooks drive it; steps reach it
 * as `world.media`.
 */
export declare class SceneRecording implements Media {
    readonly recording = true;
    readonly out: string;
    private readonly hidden;
    private readonly highlighted;
    private readonly byId;
    private readonly events;
    private readonly initScripts;
    private readonly startedAt;
    private page;
    private cdp;
    private firstFrameAt;
    private filming;
    private attached;
    private videoSaved;
    private cursor;
    private current;
    private actedLast;
    private drawn;
    private failed;
    readonly planned: PlannedRecording;
    readonly options: RecordOptions;
    readonly steps: readonly StepInfo[];
    private readonly log;
    constructor(planned: PlannedRecording, options: RecordOptions, steps: readonly StepInfo[], dir: string, log?: (line: string) => void);
    get viewport(): Viewport;
    /** Video pixels per CSS pixel: the sidecar's device scale factor, else the recorder's. */
    get scale(): number;
    /**
     * A script for every document of the filmed page, added before the page's first load: what a
     * caller changes on screen for the film (stand-in text for run-specific values, say).
     */
    addInitScript(script: string): void;
    /** Clears what an earlier recording of this id left. */
    prepare(): Promise<void>;
    /** Films `page`: the cursor in every document, the screencast into video.webm, navigations as goto actions. */
    attach(page: Page): Promise<void>;
    /** Ends the screencast, which writes video.webm; called before the page's context closes. */
    detach(): Promise<void>;
    stepStarted(id: string): void;
    /** The step's settling pause, its end, and its screen. */
    stepFinished(id: string, result: {
        status: string;
        message?: string;
    } | undefined): Promise<void>;
    /** Writes timeline.json, the terminal transcripts and the sidecar copies; returns the timeline. */
    finish(status: string | undefined): Promise<Timeline>;
    /** The viewport at the video's pixels: Playwright's own screenshot would be at CSS pixels, the scale being the browser's. */
    private capture;
    private isHidden;
    private action;
    /** The element's box in CSS pixels, scrolled into view first when it is outside the viewport. */
    private cssBox;
    private travel;
    private moveTo;
    pointAt(target: Locator): Promise<void>;
    highlight(target: Locator): Promise<void>;
    click(target: Locator): Promise<void>;
    type(target: Locator, text: string): Promise<void>;
    terminal(entry: TerminalEntry): void;
}
/** A cucumber status (PASSED, FAILED...) as the timeline writes it. */
export declare function stepStatus(status: string | undefined): StepStatus;
