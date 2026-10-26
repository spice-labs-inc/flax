import type { BrowserContextOptions, Locator, Page } from "playwright";
import type { CaptureConfig } from "@flax/contract/config";
import { type PageTextSection } from "@flax/core/page-text";
import type { Media } from "../record/media.ts";
import type { StepInfo } from "../record/steps.ts";
/** The media type of the attachment each capture adds to its scenario; the runner builds the manifest from them. */
export declare const CAPTURE_MEDIA_TYPE = "application/vnd.flax.capture+json";
/** A capture's name: its file is `<name>.png`. */
export declare const CAPTURE_NAME: RegExp;
/** What `media.capture` takes, beside the name. */
export interface CaptureOptions {
    /** The element to capture, at its own size; the viewport by default. */
    target?: Locator;
    /** The whole scrollable page instead of the viewport. */
    fullPage?: boolean;
    /** A region of the page in CSS pixels instead of the viewport. */
    clip?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    /** A stylesheet applied while the screenshot is taken, to hide something that changes from run to run, say. */
    style?: string;
    /** Elements painted over with a box. */
    mask?: Locator[];
    /** Leaves the mouse where it is; by default it moves to the top left corner so no hover state shows. */
    keepPointer?: boolean;
    /** False leaves the entry's `text` null. */
    text?: boolean;
}
/** One capture as the manifest lists it. */
export interface CaptureEntry {
    name: string;
    /** `<name>.png`, beside the manifest. */
    file: string;
    /** The text the capture shows, by heading (`@flax/core/page-text` formats it); null with `text: false`. */
    text: PageTextSection[] | null;
    scenario: string;
    /** The feature file, as the run reports it. */
    feature: string;
    /** The scenario's line, or its example row's. */
    line: number;
    /** The step that took it: its number among the scenario's own steps (0 in a Background), keyword as written and text. */
    step: {
        index: number;
        keyword: string;
        text: string;
    } | null;
    /** The page's address when it was taken. */
    url: string;
    target: "viewport" | "element" | "page" | "clip";
    /** The element's locator, as Playwright describes it. */
    locator?: string;
    /** In CSS pixels. */
    viewport: {
        width: number;
        height: number;
    };
    deviceScaleFactor: number;
    /** The PNG's size in pixels. */
    width: number;
    height: number;
    capturedAt: string;
}
/** The captures a scenario's tags ask for: every one (`all`), or only the names in `<tag>:<name>` tags; undefined when the tags select it for none. */
export declare function wantedCaptures(tags: readonly string[], tag: string): {
    all: boolean;
    names: string[];
} | undefined;
/**
 * The page script that applies the rewrites, in order, to every text node and every field's
 * value (passwords left alone), and keeps what each said for UNDO_REWRITE.
 */
export declare function rewriteScript(sources: readonly string[]): string;
/** Puts back what the last rewriteScript changed. */
export declare const UNDO_REWRITE = "(() => { const u = window.__flaxUndoRewrite; delete window.__flaxUndoRewrite; if (u) u(); })()";
/**
 * One scenario of a capture run: the page it is shot in, the scripts run in its documents, and
 * the screenshots its steps ask for through `media.capture`. Clicks and typing are plain.
 */
export declare class SceneCapture implements Media {
    readonly recording = false;
    readonly capturing = true;
    private page;
    private readonly initScripts;
    private readonly rewrites;
    private readonly byId;
    private current;
    private readonly taken;
    private readonly wanted;
    readonly scenario: {
        name: string;
        uri: string;
        line: number;
    };
    readonly settings: CaptureConfig;
    readonly dir: string;
    private readonly attachEntry;
    constructor(options: {
        scenario: {
            name: string;
            uri: string;
            line: number;
            tags: string[];
        };
        settings: CaptureConfig;
        dir: string;
        steps: readonly StepInfo[];
        attach: (body: string, mediaType: string) => unknown;
    });
    /** The browser context the scenario's page is opened in: the capture viewport, scale, color scheme, locale and time zone, with motion reduced. */
    contextOptions(): BrowserContextOptions;
    /**
     * A script for every document of the scenario's page. Before the page opens it is added ahead
     * of the first load; after, it also runs in the document already open. It runs while the
     * scenario checks the page, so it must not change what the steps read; stand-in text belongs in
     * addRewrite.
     */
    addInitScript(script: string): Promise<void>;
    /**
     * Stand-in text for run-specific values: `source` is the source of a page function
     * `(text) => string`, applied to every text node and field of the page just before each capture
     * and undone right after it, so the steps never read the stand-ins.
     */
    addRewrite(source: string): void;
    attach(page: Page): Promise<void>;
    detach(): void;
    stepStarted(id: string): void;
    stepFinished(): void;
    /** Whether the scenario's tags ask for this capture. */
    wants(name: string): boolean;
    pointAt(): Promise<void>;
    highlight(): Promise<void>;
    click(target: Locator): Promise<void>;
    type(target: Locator, text: string): Promise<void>;
    terminal(): void;
    /** The text the capture shows: inside the target, the whole page, or the viewport. */
    private visibleText;
    capture(name: string, options?: CaptureOptions): Promise<void>;
}
