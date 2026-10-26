import type { ResolvedSidecar } from "../record/sidecar.ts";
import { type ScenarioWorld } from "./world.ts";
export interface BaseHookOptions {
    timeoutMs?: number;
    /**
     * In a record run, a script for every document of a filmed page, added before its first load:
     * the workspace's stand-in text for run-specific values, for one. Given the scenario's sidecar.
     */
    recordInitScript?: (sidecar: ResolvedSidecar) => string | undefined | Promise<string | undefined>;
    /**
     * In a capture run, a script for every document of a captured scenario's page, added before its
     * first load. It runs while the steps check the page, so it must leave what they read alone.
     * Given the scenario and its World.
     */
    captureInitScript?: (scenario: {
        name: string;
        uri: string;
        tags: string[];
    }, world: ScenarioWorld) => string | undefined | Promise<string | undefined>;
    /**
     * In a capture run, stand-in text for run-specific values: the source of a page function
     * `(text) => string` applied to the page's text just before each capture and undone right after
     * it, so the steps never read the stand-ins. Given the scenario and its World.
     */
    captureRewrite?: (scenario: {
        name: string;
        uri: string;
        tags: string[];
    }, world: ScenarioWorld) => string | undefined | Promise<string | undefined>;
}
/**
 * The base hooks: step tracking, the touches attachment, the shared browser, in a record run the
 * recording of each planned scenario, and in a capture run the screenshots of each selected one. A workspace imports this module from its own support
 * file and adds its hooks (fixture teardown, env guards) beside it.
 */
export declare function installBaseHooks(options?: BaseHookOptions): void;
