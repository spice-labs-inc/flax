import type { Envelope } from "@cucumber/messages";
import { type Env, type RunResult, type StepCode } from "@flax/contract";
import type { RunOnDisk } from "./data.ts";
export type { StepCode };
export interface GherkinStep {
    /** Keyword as written: Given, When, Then, And, But, *. */
    k: string;
    t: string;
    /** From the feature's Background. */
    bg?: true;
    /** A doc string, or a data table as rows of cells. */
    doc?: string;
    table?: string[][];
}
/** A step failed, or a hook before (-1) or after (-2) the steps did. */
export interface Failure {
    at: number;
    message: string;
    /** The failing step as run.json names it, when the run kept no messages to place it by. */
    step?: string;
}
/** What one run recorded for one scenario. */
export interface Attempt {
    scenarioId: string;
    name: string;
    feature: string;
    tags: string[];
    description: string;
    status: StepCode;
    durationMs: number;
    steps: GherkinStep[];
    codes: string;
    stepMs: number[];
    failure?: Failure;
    /** Log lines a step attached, by step index. */
    logs: Record<number, string>;
    /** The last image a failing attempt attached, base64. */
    shot?: {
        mediaType: string;
        base64: string;
    };
}
/** A failure message as a reader needs it: runner paths made repo-relative, at most 20 lines. */
export declare function tidyMessage(message: string): string;
/** Every scenario's final attempt in one run's cucumber message stream, step by step. */
export declare function attemptsFrom(envelopes: Envelope[]): Attempt[];
export declare function readEnvelopes(path: string): Envelope[];
export interface Version {
    service: string;
    release?: string;
    builtAt?: string;
}
/** run.json's versions as flat strings, whatever shape each service answered in. */
export declare function versionsOf(v: RunResult["versions"]): Version[];
/** One scenario's result in one run, compact: steps as one code per character. */
export interface ScenarioRecord {
    run: number;
    status: StepCode;
    ms: number;
    codes: string;
    stepMs: number[];
    failure?: Failure;
    /** The run's steps when they differ from the scenario's newest. */
    steps?: GherkinStep[];
    logs?: Record<number, string>;
    shot?: string;
}
export interface ScenarioDetail {
    id: string;
    name: string;
    feature: string;
    tags: string[];
    description: string;
    steps: GherkinStep[];
    applies: Env[];
    records: Record<Env, ScenarioRecord[]>;
}
/**
 * data/scenarios.json and the failure screenshots: every recorded scenario with its Gherkin steps and each run's
 * step results per env, newest last. A run without messages.ndjson still gives each scenario's status, duration and failing step.
 * Logs ride on the newest record per env; a screenshot only on the newest failure per env.
 */
export declare function scenariosFile(root: string, resultsDir: string, runs: RunOnDisk[], order: {
    id: string;
}[]): {
    file: {
        runs: {
            scenariosCommit?: string;
            workflowRun?: string;
            env: string;
            id: string;
            startedAt: string;
            finishedAt: string;
            versions: Version[];
        }[];
        scenarios: ScenarioDetail[];
        features: import("./features.ts").FeatureEntry[];
    };
    shots: {
        key: string;
        env: Env;
        at: string;
        mediaType: string;
        base64: string;
    }[];
};
/** Newest screenshots first until the byte budget is spent; the rest are dropped and their records lose the key. */
export declare function withinBudget<T extends {
    key: string;
    at: string;
    base64: string;
}>(shots: T[], budget: number): {
    kept: T[];
    dropped: Set<string>;
};
