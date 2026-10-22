import { type Env } from "@flax/scenarios/lib/types";
/** The env of a run id in the runner's `<env>-<ISO time>` shape, or undefined for anything else. */
export declare function runIdEnv(id: string): Env | undefined;
/** A scenario id: `<features dir>/<surface>/...feature:<line>`. */
export declare function isScenarioId(id: string): boolean;
