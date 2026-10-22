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
export declare const DEFAULT_PACE: Pace;
export declare const DEFAULT_VIEWPORT: Viewport;
/** The defaults with each key the override sets. */
export declare function mergePace(defaults: Pace, override?: Partial<Pace>): Pace;
/** How long typing `text` takes. */
export declare function typingMs(text: string, pace: Pace): number;
/** Cursor travel time: 350 to 800 ms by distance, none for a move under a pixel. */
export declare function travelMs(from: Point, to: Point): number;
export declare const easeInOut: (t: number) => number;
/** The points an eased cursor move passes through, one per frame, ending exactly at `to`. */
export declare function cursorPath(from: Point, to: Point, frameMs?: number): Point[];
/**
 * The pause that ends a step: a check (Then) is held for reading, any other step for the
 * after-action pause unless its last media action already paused; a hidden step is never paced.
 */
export declare function settleMs(step: {
    kind: StepKind;
    hidden: boolean;
    actedLast: boolean;
}, pace: Pace): number;
/** A step's effective keyword type, And and But taking the one before them. */
export type StepKind = "context" | "action" | "outcome" | "unknown";
