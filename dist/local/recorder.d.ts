import type { Keystroke, Terminal } from "./terminal.ts";
/** An asciicast v2 event: seconds, kind ("o" output, "i" input, "m" marker) and data. */
export type CastEvent = [number, string, string];
export interface CastHeader {
    version: 2;
    width: number;
    height: number;
    [key: string]: unknown;
}
/**
 * Records a terminal session with asciinema (3 or later, for `--headless`), attached to the
 * scenario's tmux pane as a viewer that types nothing. Each stop-point becomes a marker, each key the terminal sent an
 * input event, and the text between stop-points a transcript segment.
 */
export declare class Recorder {
    private child;
    private startedAt;
    private readonly markers;
    private readonly segments;
    private snapshot;
    private readonly terminal;
    private readonly rawPath;
    constructor(terminal: Terminal, rawPath: string);
    start(): Promise<void>;
    get started(): boolean;
    /** A stop-point: the player pauses here, and the transcript starts a new segment. */
    marker(label: string): Promise<void>;
    private cutSegment;
    /** Ends the session (the terminal is closed, so the viewer exits) and assembles the cast. */
    stop(): Promise<{
        cast: string;
        transcript: string;
    }>;
}
export declare function parseCast(text: string): {
    header: CastHeader;
    events: CastEvent[];
};
/**
 * The finished cast: the recording trimmed to the scenario (the viewer's exit and anything
 * after the session ended dropped), keystrokes as input events, each stop-point as a marker
 * placed just after the last output or key before it, and time starting at the first output.
 */
export declare function assembleCast(header: CastHeader, events: CastEvent[], at: {
    startedAt: number;
    endedAt: number;
    markers: {
        at: number;
        label: string;
    }[];
    keys: Keystroke[];
}): string;
/** What appeared in the pane since `before`: the new lines, or the whole screen after a clear. */
export declare function transcriptDelta(before: string, after: string): string;
