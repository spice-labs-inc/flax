import type { Pace, Viewport } from "./pace.ts";
import { type ResolvedSidecar } from "./sidecar.ts";
/** How every recording of a run is made, besides its sidecar. */
export interface RecordOptions {
    pace: Pace;
    viewport: Viewport;
    /** Device pixels per CSS pixel. */
    scale: number;
    highlightColor: string;
}
/** One scenario to record: where it is, its resolved sidecar and the sidecar's text for the copy. */
export interface PlannedRecording {
    uri: string;
    line: number;
    feature: string;
    sidecar: ResolvedSidecar;
    /** The sidecar document as written (a generated one for a scenario recorded without one). */
    source: string;
}
/** What a record run hands its scenarios, through a file the runner names in an environment variable. */
export interface RecordPlan {
    /** Absolute: each recording goes in `<dir>/<id>/`. */
    dir: string;
    options: RecordOptions;
    recordings: PlannedRecording[];
}
/** A path as cucumber reports a pickle's uri: relative to the working directory. */
export declare const featureKey: (uri: string) => string;
/**
 * The scenarios of the given feature files to record: each one a sidecar names, or every one
 * with `all`, those without a sidecar getting a generated one. Every problem with any sidecar is
 * returned (an unknown scenario name, a bad step reference, overlapping narration, a duplicate id),
 * and nothing is planned while there is one.
 */
export declare function planRecordings(files: readonly {
    uri: string;
    text: string;
}[], options: {
    dir: string;
    all: boolean;
    record: RecordOptions;
}): Promise<{
    plan: RecordPlan;
    errors: string[];
}>;
/** The planned recording of a pickle, by its feature file and line. */
export declare function plannedRecording(plan: RecordPlan, uri: string, line: number | undefined): PlannedRecording | undefined;
