import type { Envelope } from "@cucumber/messages";
import { type Env, type PlannedScenario, type RunResult, type ScenarioStatus } from "@flax/contract";
export type LiveStatus = "running" | "retrying" | ScenarioStatus;
/** One scenario as the live stream has it so far. */
export interface LiveScenario {
    id: string;
    name: string;
    status: LiveStatus;
    attempt: number;
    /** Steps finished and steps in all, hooks included. */
    done: number;
    steps: number;
    /** One character per Gherkin step, as the explorer's data codes them (p, f, s, u, n, a), "." until it finishes. */
    codes: string;
    startedAt: string;
    durationMs?: number;
    failure?: string;
}
export interface RunMeta {
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
    planned: number;
}
export type RunState = "running" | "finished" | "incomplete";
export interface RunSummary extends RunMeta {
    state: RunState;
    /** Scenarios the run will run, from its test cases. */
    total: number;
    passed: number;
    failed: number;
    finishedCount: number;
    gap: boolean;
    lastMessageAt: string;
    finishedAt?: string;
}
/** A server-sent event: its name and what it carries. */
export interface LiveEvent {
    event: "run-started" | "scenario-started" | "scenario-finished" | "step-finished" | "run-finished" | "run-incomplete";
    data: Record<string, unknown>;
}
/** One step of a scenario running now, for the open scenario's page. */
export interface LiveStep {
    text: string;
    status?: string;
    ms?: number;
}
export interface ScenarioDetail extends LiveScenario {
    runId: string;
    env: Env;
    stepList: LiveStep[];
    message?: string;
    shot?: string;
}
/** A run as its pushed messages tell it, kept in memory and in `<live>/<run id>.ndjson`. */
export declare class LiveRun {
    #private;
    meta: RunMeta;
    state: RunState;
    gap: boolean;
    lastMessageAt: number;
    finishedAt: number | undefined;
    readonly scenarios: Map<string, LiveScenario>;
    constructor(dir: string, meta: RunMeta, now: number);
    get total(): number;
    summary(): RunSummary;
    /** Takes a batch whose first envelope has this sequence number; envelopes already seen are skipped. */
    ingest(first: number, envelopes: Envelope[], now: number, persist?: boolean): LiveEvent[];
    /** Every envelope received, in sequence order. */
    envelopes(): Envelope[];
    detail(scenarioId: string): ScenarioDetail | undefined;
    remove(): void;
}
export declare class InvalidStart extends Error {
}
/** A start call's body, checked against the run id in its path. */
export declare function parseStart(runId: string, body: unknown): RunMeta;
/** A finish call's body: the run's run.json and planned.json, checked against the run id. */
export declare function parseFinish(runId: string, body: unknown): {
    run: RunResult;
    planned: PlannedScenario[];
    incomplete: boolean;
};
export declare const RECENT_PER_ENV = 5;
export declare const QUIET_MS: number;
/** Every live run: per env the current one and the last few, restored from `<live>/` at start. */
export declare class LiveRuns {
    #private;
    readonly runs: Map<string, LiveRun>;
    constructor(dir: string, now: number);
    get(runId: string): LiveRun | undefined;
    /** The run, started now when it was not yet known (a start call, or messages whose start was lost). */
    open(meta: RunMeta, now: number): {
        run: LiveRun;
        created: boolean;
    };
    save(run: LiveRun): void;
    /** Running runs that went quiet, now marked incomplete. */
    sweep(now: number): LiveRun[];
    /** Per env, newest first: the runs the snapshot carries. */
    byEnv(): Record<Env, RunSummary[]>;
}
