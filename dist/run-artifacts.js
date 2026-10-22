/**
 * What a scheduled check run publishes and where it lands, shared by the
 * package that writes it (@flax/agents, a job with `output.kind: results`)
 * and everything that reads it later (the explorer's GitHub fallback, a
 * poller, a person with `gh run download`). A run uploads one workflow
 * artifact named by {@link resultsArtifactName}: the scenario run's own
 * files ({@link RUN_RESULT_FILES}), the media manifest
 * ({@link MEDIA_MANIFEST}) and the run index ({@link RESULTS_INDEX}), whose
 * shape is {@link ResultsIndex}. A reader keeps a downloaded run under
 * `<results dir>/<env>/<run id>/` ({@link runDirectory}); the run id is the
 * workflow run id and attempt ({@link resultsRunId}) or `local`. Nothing in
 * this file reads or writes a file; it is names, shapes and the checks that
 * tell a file this contract wrote from any other.
 */
/** The files a scenario run writes and the artifact carries unchanged. */
export const RUN_RESULT_FILES = [
    "run.json",
    "planned.json",
    "messages.ndjson",
];
/** The media stage's manifest: the files above, their hashes, and `data` with every check's result. */
export const MEDIA_MANIFEST = "media.json";
/** The run index: how every check ended, what the next run compares with and a reader shows. */
export const RESULTS_INDEX = "index.json";
/** Every file name a results artifact may hold; a reader keeps these and ignores the rest. */
export const RUN_ARTIFACT_FILES = [
    ...RUN_RESULT_FILES,
    MEDIA_MANIFEST,
    RESULTS_INDEX,
];
/**
 * The artifact a run uploads: `<job>-<env>` live, `<job>-shadow-<env>` for a
 * shadow run, so a live run never compares with a shadow one.
 */
export function resultsArtifactName(job, mode, env) {
    return `${job}${mode === "shadow" ? "-shadow" : ""}-${env}`;
}
/**
 * The mode and environment an artifact name carries, when it is one of this
 * job's; the environments must be known because both job names and
 * environment ids may contain dashes.
 */
export function parseResultsArtifactName(name, job, environments) {
    for (const env of environments) {
        if (name === resultsArtifactName(job, "live", env))
            return { mode: "live", env };
        if (name === resultsArtifactName(job, "shadow", env))
            return { mode: "shadow", env };
    }
    return undefined;
}
/** A run's id: `<workflow run id>-<attempt>` on GitHub, `local` anywhere else. */
export function resultsRunId(workflowRunId, attempt) {
    if (workflowRunId === undefined || !/^\d{1,20}$/.test(workflowRunId))
        return "local";
    const n = attempt !== undefined && /^\d{1,5}$/.test(attempt) ? attempt : "1";
    return `${workflowRunId}-${n}`;
}
/** What a run directory name (and so a run id or environment id) may look like on disk. */
export const RUN_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Where a reader keeps a run's files, relative to its results directory: `<env>/<run id>`. */
export function runDirectory(env, runId) {
    if (!RUN_DIR_NAME.test(env))
        throw new Error(`${JSON.stringify(env)} is not an environment id`);
    if (!RUN_DIR_NAME.test(runId))
        throw new Error(`${JSON.stringify(runId)} is not a run id`);
    return `${env}/${runId}`;
}
/** What a check's result counts as; skipped is neither a pass nor a failure. */
export const CHECK_STATUSES = ["passed", "failed", "skipped"];
function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** True when a parsed index.json is one this contract describes; a reader treats anything else as absent. */
export function isResultsIndex(value) {
    if (!isObject(value) ||
        value["version"] !== 1 ||
        typeof value["job"] !== "string" ||
        typeof value["env"] !== "string" ||
        !isObject(value["run"]) ||
        typeof value["run"]["id"] !== "string" ||
        typeof value["run"]["at"] !== "string" ||
        !isObject(value["checks"]))
        return false;
    for (const c of Object.values(value["checks"]))
        if (!isObject(c) ||
            typeof c["name"] !== "string" ||
            !CHECK_STATUSES.includes(c["status"]))
            return false;
    return true;
}
/** Parses an index.json's text; undefined when it is not one this contract describes. */
export function readResultsIndex(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    return isResultsIndex(value) ? value : undefined;
}
//# sourceMappingURL=run-artifacts.js.map