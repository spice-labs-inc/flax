import { type BoardFile, type Env } from "@flax/contract";
import type { ResultsSource } from "./config.ts";
import type { GitHub } from "./github.ts";
import type { Log } from "./log.ts";
/** A workflow run GitHub says is running. */
export interface RunningWorkflow {
    id: number;
    url: string;
    /** The env, when the run's name or display title names one (`... <env>` or `[<env>]`). */
    env?: Env;
    event: string;
    startedAt: string;
}
/** An artifact as GitHub lists it. */
export interface Artifact {
    id: number;
    expired: boolean;
    createdAt: string;
    /** The workflow run that uploaded it. */
    runId: number;
}
/** One page of `GET /repos/{repo}/actions/artifacts?name=`: the artifacts of that name. */
export declare function parseArtifacts(body: unknown, name: string): Artifact[];
/** The env a workflow run's title names, when it names one of ours. */
export declare function envOfTitle(title: string | undefined): Env | undefined;
export declare function parseRunning(body: unknown, repo: string): RunningWorkflow[];
/** The artifacts to download for an env: among its newest runs (live and shadow), those not here yet. */
export declare function toDownload(artifacts: Artifact[], present: ReadonlySet<number>, seen: ReadonlySet<number>): Artifact[];
/** GitHub as the fallback results source: the artifacts, the runs in progress and the board's issue states. */
export declare class Poller {
    #private;
    running: RunningWorkflow[];
    board: BoardFile;
    constructor(gh: GitHub, source: ResultsSource, resultsDir: string, board: BoardFile, log: Log);
    /** Downloads the runs not here yet; resolves to how many were kept. */
    artifacts(): Promise<number>;
    inProgress(): Promise<RunningWorkflow[]>;
    /** Re-reads whether each board issue is open; resolves to whether any state changed. */
    boardStates(now: string): Promise<boolean>;
}
