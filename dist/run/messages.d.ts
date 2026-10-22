import type { Envelope } from "@cucumber/messages";
import { type ScenarioResult } from "./results.ts";
/** One result per scenario run from a cucumber message stream; a retried attempt counts only when it was the last. */
export declare function scenarioResults(envelopes: Envelope[]): ScenarioResult[];
