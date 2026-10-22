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
export declare const RUN_RESULT_FILES: readonly ["run.json", "planned.json", "messages.ndjson"];
export type RunResultFile = (typeof RUN_RESULT_FILES)[number];
/** The media stage's manifest: the files above, their hashes, and `data` with every check's result. */
export declare const MEDIA_MANIFEST = "media.json";
/** The run index: how every check ended, what the next run compares with and a reader shows. */
export declare const RESULTS_INDEX = "index.json";
/** Every file name a results artifact may hold; a reader keeps these and ignores the rest. */
export declare const RUN_ARTIFACT_FILES: readonly string[];
export type RunMode = "shadow" | "live";
/**
 * The artifact a run uploads: `<job>-<env>` live, `<job>-shadow-<env>` for a
 * shadow run, so a live run never compares with a shadow one.
 */
export declare function resultsArtifactName(job: string, mode: RunMode, env: string): string;
/**
 * The mode and environment an artifact name carries, when it is one of this
 * job's; the environments must be known because both job names and
 * environment ids may contain dashes.
 */
export declare function parseResultsArtifactName(name: string, job: string, environments: readonly string[]): {
    mode: RunMode;
    env: string;
} | undefined;
/** A run's id: `<workflow run id>-<attempt>` on GitHub, `local` anywhere else. */
export declare function resultsRunId(workflowRunId: string | undefined, attempt: string | undefined): string;
/** What a run directory name (and so a run id or environment id) may look like on disk. */
export declare const RUN_DIR_NAME: RegExp;
/** Where a reader keeps a run's files, relative to its results directory: `<env>/<run id>`. */
export declare function runDirectory(env: string, runId: string): string;
/** What a check's result counts as; skipped is neither a pass nor a failure. */
export declare const CHECK_STATUSES: readonly ["passed", "failed", "skipped"];
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export interface CheckResult {
    name: string;
    status: CheckStatus;
    /** Why it failed, one line. */
    detail?: string;
    /** The step that failed, one line. */
    step?: string;
    /** How many screenshots the run's results hold for it. */
    screenshots?: number;
}
/** A run's index.json: the run, the builds it checked and every check's result. */
export interface ResultsIndex {
    version: 1;
    job: string;
    env: string;
    shadow: boolean;
    run: {
        /** `<workflow run id>-<attempt>`, or local. */
        id: string;
        /** When the run finished, ISO 8601. */
        at: string;
        /** The workflow run's page, when the run was one. */
        workflowRun?: string;
        /** Why the run was started by hand, when it was. */
        reason?: string;
        /** Why the run has no results of its own, one line; its checks are then the last run's that had. */
        failure?: string;
    };
    /** The run whose checks these are, when it is not this one. */
    checksFrom?: string;
    /** The builds the run checked, by service, as flat strings; a source repository's commit sits here under its name. */
    builds: Record<string, string>;
    counts: Record<CheckStatus, number>;
    checks: Record<string, CheckResult>;
}
/** True when a parsed index.json is one this contract describes; a reader treats anything else as absent. */
export declare function isResultsIndex(value: unknown): value is ResultsIndex;
/** Parses an index.json's text; undefined when it is not one this contract describes. */
export declare function readResultsIndex(text: string): ResultsIndex | undefined;
