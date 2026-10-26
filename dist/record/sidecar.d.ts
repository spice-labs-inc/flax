import type { Pace, Viewport } from "./pace.ts";
import type { StepInfo } from "./steps.ts";
/** A step reference: a 1-based index into the scenario's own steps (Background excluded), or a step's exact text with its keyword as written. */
export type StepRef = number | string;
/** A title or closing card not tied to a step; `text` is narration spoken over it. */
export interface Card {
    chapter?: string;
    heading: string;
    sub?: string;
    items?: (string | CardItem)[];
    text: string;
}
export interface CardItem {
    label: string;
    /** An icon name, interpreted by the renderer. */
    icon?: string;
}
/** What a terminal scene shows instead of what the step ran: a command line to display, and lines typed before it. */
export interface TerminalOverride {
    at: StepRef;
    display?: string;
    preface?: string[];
}
/**
 * A video sidecar as written: `<name>.video.yml` beside `<name>.feature` for one recorded
 * scenario, or `<name>.<id>.video.yml` per scenario when a feature has several; matched on `scenario`.
 */
export interface VideoSidecar {
    /** The exact scenario name in the feature (an outline's name after its example values are filled in). */
    scenario: string;
    /** The media id, stable across re-recordings: the output directory's name. */
    id: string;
    title: string;
    description?: string;
    /** A narration voice id, interpreted by the renderer. */
    voice?: string;
    pace?: Partial<Pace>;
    viewport?: Viewport & {
        deviceScaleFactor?: number;
    };
    intro?: Card;
    outro?: Card;
    /** Spoken text; each block starts at its step and runs until the next block's. */
    narration?: {
        at: StepRef;
        text: string;
    }[];
    chapters?: {
        at: StepRef;
        title: string;
    }[];
    /** Which steps get an on-screen highlight: every Then (the default), none, or the steps listed. */
    highlight?: "then" | "none" | StepRef[];
    /** Steps that run but are not filmed; every Given by default. */
    hide?: StepRef[];
    poster?: {
        at: StepRef;
        title?: string;
        kicker?: string;
    };
    terminal?: TerminalOverride | TerminalOverride[];
    /** The name of a stand-in rule set the consumer supplies. */
    standIns?: string;
    /** Passed through untouched to whatever delivers the video. */
    publish?: Record<string, unknown>;
}
/** A sidecar checked against its scenario: every reference an index, every default filled in. */
export interface ResolvedSidecar {
    scenario: string;
    id: string;
    title: string;
    description?: string;
    voice?: string;
    pace: Pace;
    viewport: Viewport & {
        deviceScaleFactor: number;
    };
    intro: (Card & {
        items: CardItem[];
    }) | null;
    outro: (Card & {
        items: CardItem[];
    }) | null;
    narration: {
        at: number;
        text: string;
    }[];
    chapters: {
        at: number;
        title: string;
    }[];
    highlight: number[];
    hide: number[];
    poster: {
        at: number;
        title?: string;
        kicker?: string;
    } | null;
    terminal: {
        at: number;
        display?: string;
        preface: string[];
    }[];
    standIns?: string;
    publish: Record<string, unknown>;
}
/** One sidecar document read from a file, with the text it was read from. */
export interface SidecarDocument {
    file: string;
    /** The YAML document's own text, for the copy beside the recording. */
    source: string;
    sidecar: VideoSidecar;
}
export declare const SIDECAR_KEYS: readonly ["scenario", "id", "title", "description", "voice", "pace", "viewport", "intro", "outro", "narration", "chapters", "highlight", "hide", "poster", "terminal", "standIns", "publish"];
export declare const SIDECAR_ID: RegExp;
/**
 * The sidecar files of a feature file: `<name>.video.yml` and every `<name>.<id>.video.yml`
 * beside `<name>.feature`, leaving out those that belong to a feature `<name>.<id>.feature`.
 * Each file's id part, when it has one, is returned to check against the sidecar's id.
 */
export declare function sidecarFiles(featureFile: string): {
    file: string;
    id?: string;
}[];
/**
 * Reads the sidecar documents of one file, checking their shape only (their step references
 * need the scenario: see resolveSidecar). Every problem is reported, prefixed with the file and
 * the key it is about.
 */
export declare function parseSidecars(text: string, file: string): {
    documents: SidecarDocument[];
    errors: string[];
};
/** What is wrong with a parsed sidecar's shape, one message per problem; the JSON schema says the same. */
export declare function sidecarShapeErrors(value: unknown): string[];
/** The sidecar a run that records every selected scenario gives one that has none. */
export declare function defaultSidecar(name: string, id: string): VideoSidecar;
/** A scenario name as a media id: lowercase words joined by dashes. */
export declare function slug(name: string): string;
/**
 * Checks a sidecar against the scenario it names and resolves it: step references become
 * indexes, defaults are filled in. Narration and chapters must start at visible steps, each
 * block at a later step than the one before (a block runs until the next one starts, so two
 * at one step, or out of order, would overlap).
 */
export declare function resolveSidecar(sidecar: VideoSidecar, steps: readonly StepInfo[], defaults: {
    pace: Pace;
    viewport: Viewport;
    scale: number;
}, file?: string): {
    sidecar?: ResolvedSidecar;
    errors: string[];
};
