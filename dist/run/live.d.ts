import type { Envelope } from "@cucumber/messages";
import type { Env } from "../lib/types.ts";
import type { PlannedScenario, RunResult } from "./results.ts";
export declare const INGEST_TOKEN_VARIABLE = "EXPLORER_INGEST_TOKEN";
export declare const EXPLORER_URL_VARIABLE = "EXPLORER_URL";
export interface LiveLimits {
    tickMs: number;
    requestMs: number;
    backoffMinMs: number;
    backoffMaxMs: number;
    giveUpMs: number;
    finalMs: number;
    maxEnvelopes: number;
    maxBytes: number;
    batchBytes: number;
    attachmentBytes: number;
}
export declare const LIVE_LIMITS: LiveLimits;
/** What the explorer learns when a run starts. */
export interface RunStart {
    env: Env;
    runId: string;
    startedAt: string;
    workers: number;
    scenariosCommit?: string;
    github?: {
        runId: string;
        attempt?: string;
        repository: string;
    };
    planned: PlannedScenario[];
}
export interface LiveOptions {
    url: URL;
    token: string;
    runId: string;
    fetch?: typeof fetch;
    warn?: (line: string) => void;
    limits?: Partial<LiveLimits>;
}
/**
 * Pushes a run's cucumber messages to the explorer as they arrive, so open pages follow the run.
 * Fire and forget: nothing here waits on the run, throws into it, or changes its results or exit code.
 */
export declare class LivePush {
    #private;
    constructor(options: LiveOptions);
    /** How many envelopes were left out because the queue was full. */
    get dropped(): number;
    get stopped(): boolean;
    start(info: RunStart): void;
    /** Called for every envelope; only queues it. */
    message(envelope: Envelope): void;
    /** The last messages and the run's results, in at most finalMs in all; never throws. */
    finish(run: RunResult, planned: PlannedScenario[]): Promise<void>;
}
/** A push for this run when the explorer's URL and ingest token are both set; otherwise none. */
export declare function livePushFromEnv(env: NodeJS.ProcessEnv, runId: string, warn?: (line: string) => void): LivePush | undefined;
/** The workspace commit this checkout is at, when git can say. */
export declare function scenariosCommit(): string | undefined;
/** The workflow run this run is part of, from the variables GitHub Actions sets. */
export declare function githubRun(env: NodeJS.ProcessEnv): RunStart["github"] | undefined;
