import type { Envelope } from "@cucumber/messages";
import type { ScenarioResult, ScenarioStatus } from "../run/results.ts";
import { type CaptureEntry } from "./capture.ts";
/** A scenario a capture run selected by its tags, and the captures they ask for. */
export interface CaptureScenario {
    uri: string;
    line: number;
    name: string;
    /** Every capture its steps take, or only `names`. */
    all: boolean;
    names: string[];
}
/** `<dir>/manifest.json` of a capture run. */
export interface CaptureManifest {
    env: string;
    runId: string;
    startedAt: string;
    finishedAt: string;
    /** Passed when every selected scenario passed, took what its tags name, and no name was taken twice. */
    status: "passed" | "failed";
    /** One per name, in name order; each with its scenario's status. A consumer takes only the passed ones. */
    captures: (CaptureEntry & {
        status: ScenarioStatus;
    })[];
    /** Why the run is failed, one line each. */
    problems: string[];
}
/** The capture entries of a run's messages, in the order they were taken. */
export declare function captureEntries(envelopes: readonly Envelope[]): CaptureEntry[];
/** The manifest of a capture run from its entries, the scenarios' results and what was selected. */
export declare function captureManifest(entries: readonly CaptureEntry[], results: readonly ScenarioResult[], selected: readonly CaptureScenario[], run: {
    env: string;
    runId: string;
    startedAt: string;
    finishedAt: string;
}): CaptureManifest;
