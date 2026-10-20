export type {
  PlannedScenario,
  RunResult,
  ScenarioResult,
  ScenarioStatus,
  Touch,
} from "@flax/contract";
export { SCENARIO_STATUSES } from "@flax/contract";
import { config } from "../config.ts";

/** The media type of the touches attachment; configurable, with the original string as the default so old messages.ndjson files still read. */
export function touchesMediaType(): string {
  return config().touchesMediaType;
}
