import type { Envelope } from "@cucumber/messages";
import { type Env, type PlannedScenario, type RunResult } from "@flax/contract";
/**
 * The directory name a run takes under `<results>/<env>/`: its run.json's run id, so runs sort by start
 * time; a run that left only index.json (its scenario run failed) gets `workflow-<run id>`, which the
 * coverage map skips as it has no run.json.
 */
export declare function runDirName(env: Env, files: {
    run?: string | undefined;
    index?: string | undefined;
}): {
    name: string;
    failure?: string;
};
export declare const RUNS_PER_ENV = 50;
/** The files of an artifact the data build reads. */
export declare const ARTIFACT_FILES: ReadonlySet<string>;
export type Source = {
    kind: "push";
    workflowRun?: string;
} | {
    kind: "artifact";
    artifactId: number;
    workflowRun: number;
};
/** A pushed run's results, in the layout `pnpm results:fetch` leaves; never over a run its artifact already gave. */
export declare function writePushedRun(resultsDir: string, run: RunResult, planned: PlannedScenario[], envelopes: Envelope[], workflowRun?: string): boolean;
export type ArtifactOutcome = {
    kept: string;
} | {
    skipped: string;
};
/** An artifact's run: replaces the pushed copy of the same run; a run that left no run.json is skipped. */
export declare function writeArtifactRun(resultsDir: string, env: Env, files: Map<string, Buffer>, artifact: {
    id: number;
    runId: number;
}): ArtifactOutcome;
/** The workflow runs whose artifact copy is here, so the poller downloads none of them again. */
export declare function artifactRuns(resultsDir: string): Set<number>;
/** Keeps each env's newest ordinary runs and its newest runs of each cadence (run ids sort by start time), and clears scratch left by a crash. */
export declare function prune(resultsDir: string, perEnv?: number): string[];
