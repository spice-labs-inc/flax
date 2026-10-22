export type { PlannedScenario, RunResult, ScenarioResult, ScenarioStatus, Touch, } from "@flax/contract";
export { SCENARIO_STATUSES } from "@flax/contract";
/** The media type of the touches attachment; configurable, with the original string as the default so old messages.ndjson files still read. */
export declare function touchesMediaType(): string;
