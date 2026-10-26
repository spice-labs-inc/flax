export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export const SCENARIO_STATUSES = [
    "passed",
    "failed",
    "skipped",
    "undefined",
    "pending",
    "ambiguous",
];
export const STATUS_CODE = {
    passed: "p",
    failed: "f",
    skipped: "s",
    undefined: "u",
    pending: "n",
    ambiguous: "a",
};
/**
 * The runs that speak for one env now, from its runs oldest first: its newest ordinary run and its newest run of
 * each cadence, in the order given. A cadence run speaks only for its cadence's scenarios, and an ordinary run
 * never for them.
 */
export function currentRuns(runs, cadenceOf) {
    const newest = new Map();
    for (const r of runs)
        newest.set(cadenceOf(r), r);
    const keep = new Set(newest.values());
    return runs.filter((r) => keep.has(r));
}
// ---- the explorer data files ----
/** The files the explorer page loads, by name; usage.json is null when the workspace has no usage history. */
export const DATA_FILES = [
    "coverage.json",
    "journeys.json",
    "history.json",
    "scenarios.json",
    "shots.json",
    "board.json",
    "usage.json",
];
// ---- conventions ----
/** `<env>-<ISO time with : and . as ->` as the runner makes a run id. */
export function runIdPattern(envs) {
    return new RegExp(`^(${envs.join("|")})-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z$`);
}
export function makeRunId(env, startedAt) {
    return `${env}-${startedAt.toISOString().replace(/[:.]/g, "-")}`;
}
/** A scenario id: `<features dir>/<surface>/...feature:<line>`. */
export function isScenarioId(id, featuresDir = "features") {
    return (new RegExp(`^${featuresDir}/[\\w./-]+\\.feature:\\d+$`).test(id) &&
        !id.includes(".."));
}
/** The surface a scenario id belongs to, from its path `<features dir>/<surface>/`. */
export function surfaceOfScenarioId(id, surfaces, featuresDir = "features") {
    return surfaces.find((s) => id.startsWith(`${featuresDir}/${s}/`));
}
export * from "./run-artifacts.js";
export * from "./usage.js";
//# sourceMappingURL=index.js.map