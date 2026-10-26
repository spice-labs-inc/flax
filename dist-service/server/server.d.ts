import { type Server } from "node:http";
import { type PlannedScenario, type RunResult } from "@flax/contract";
import type { Hub } from "./hub.ts";
import type { Log } from "./log.ts";
import type { UsageStore } from "./usage.ts";
import { type LiveRun, type LiveRuns } from "./runs.ts";
export declare const MAX_BODY: number;
export interface Finished {
    run: RunResult;
    planned: PlannedScenario[];
    incomplete: boolean;
}
export interface ServerDeps {
    /** Directories to serve files from when no proxy does: the data directory and, when the page is built, its site directory. */
    static?: {
        data: string;
        site?: string | undefined;
    } | undefined;
    /** The runner's bearer token; without one every ingest call is refused. */
    token: string | undefined;
    runs: LiveRuns;
    hub: Hub;
    log: Log;
    /** Writes the finished run into the results and rebuilds the data; the response does not wait for it. */
    onFinish: (run: LiveRun, finished: Finished) => void;
    /** The usage plug-in, when flax.yml turns it on; without a token every usage call is refused. */
    usage?: {
        token: string | undefined;
        store: UsageStore;
        /** A new history arrived for this env. */
        onHistory?: (env: string) => void;
    } | undefined;
    now?: () => number;
}
export declare function snapshot(runs: LiveRuns, extra: Record<string, unknown>): Record<string, unknown>;
export declare function explorerServer(deps: ServerDeps & {
    snapshotExtra: () => Record<string, unknown>;
}): Server;
