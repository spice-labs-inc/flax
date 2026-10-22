import type { ResolvedSidecar } from "../record/sidecar.ts";
export interface BaseHookOptions {
    timeoutMs?: number;
    /**
     * In a record run, a script for every document of a filmed page, added before its first load:
     * the workspace's stand-in text for run-specific values, for one. Given the scenario's sidecar.
     */
    recordInitScript?: (sidecar: ResolvedSidecar) => string | undefined | Promise<string | undefined>;
}
/**
 * The base hooks: step tracking, the touches attachment, the shared browser, and in a record run
 * the recording of each planned scenario. A workspace imports this module from its own support
 * file and adds its hooks (fixture teardown, env guards) beside it.
 */
export declare function installBaseHooks(options?: BaseHookOptions): void;
