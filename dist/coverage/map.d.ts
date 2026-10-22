import { type Env, type OutOfScope, type Sighting, type SurfaceFile, type SurfaceName } from "../lib/types.ts";
import type { PlannedScenario, RunResult } from "../run/results.ts";
export declare const STATUSES: readonly ["uncovered", "planned", "failing", "passing"];
export type Status = (typeof STATUSES)[number];
export interface CoverageItem {
    id: string;
    label: string;
    surface: SurfaceName;
    area: string;
    envs: Env[];
    /** Per env the item applies to. */
    status: Partial<Record<Env, Status>>;
    /** Scenario ids that touch this item. */
    scenarios: string[];
    /** Per env, the coverage needs a passing scenario proved (success, auth-refusal). */
    proven?: Partial<Record<Env, string[]>>;
    /** Per env, what passing scenarios proved beyond the item's needs, such as permission-refusal; never needed to pass. */
    alsoProven?: Partial<Record<Env, string[]>>;
    /** Per env, failed scenarios that verified the item in a step before the one that failed. */
    laterFailed?: Partial<Record<Env, string[]>>;
}
/** The run each env's statuses come from. */
export interface RunSummary {
    env: Env;
    runId: string;
    startedAt: string;
    scenarios: number;
    passed: number;
    failed: number;
}
/** Results of check runs: at most one run per env, plus the scenarios written for features not built yet. */
export interface Evidence {
    runs: RunResult[];
    planned: PlannedScenario[];
}
export interface SurfaceSummary {
    surface: SurfaceName;
    builtAt: string | null;
    items: number;
    areas: number;
    perEnv: Record<Env, number>;
    sources: Sighting[];
    notes: string[];
    outOfScope: OutOfScope[];
}
export interface CoverageMap {
    builtAt: string;
    envs: Env[];
    surfaces: SurfaceSummary[];
    items: CoverageItem[];
    runs: RunSummary[];
    planned: PlannedScenario[];
}
/**
 * Combines surface files with check run results. Per env an item is failing
 * when a failed scenario touched it in the step that failed (or anywhere, when
 * the run did not record steps), passing when the steps that touched it proved
 * every coverage need it has (one touch when it lists none), and otherwise
 * uncovered, including every env without a run.
 */
export declare function buildCoverage(files: SurfaceFile[], builtAt: string, evidence?: Evidence): CoverageMap;
/**
 * Runs of one env, oldest first, as one run: each scenario's latest result, named after the newest run. A run
 * holds only the scenarios it selected, so a cadence run and an ordinary run each leave the other's results be.
 */
export declare function mergeRuns(runs: RunResult[]): RunResult | undefined;
export declare function surfaceTitle(s: SurfaceName): string;
/** GAPS.md: counts per surface, then every uncovered or failing item by name, grouped by surface and area. */
/** Times people read are in the configured timezone with the zone named. */
export declare function pacific(iso: string): string;
export declare function renderGaps(map: CoverageMap): string;
