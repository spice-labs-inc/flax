/**
 * The one set of types for everything the kit writes and the explorer reads: surface files, run results,
 * the explorer data files, the live stream and the ingest API. Env and surface names are plain strings
 * whose values come from the workspace's flax.yml.
 */
export type { DatasetVocabulary, EnvConfig, IslandSplit, KindNaming, RecorderConfig, ScenariosConfig, SurfaceConfig, } from "./config.ts";
export type Env = string;
export type SurfaceName = string;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export type Source = {
    kind: "url";
    url: string;
} | {
    kind: "repo";
    repo: string;
    ref: string;
    commit: string;
    path?: string;
};
export interface Sighting {
    env?: Env;
    source: Source;
    readAt: string;
}
export interface SurfaceItem {
    id: string;
    label: string;
    surface: SurfaceName;
    area: string;
    parent?: string;
    envs: Env[];
    seen: Sighting[];
    details?: Record<string, unknown>;
}
export interface OutOfScope {
    label: string;
    reason: string;
}
export interface SurfaceFile {
    surface: SurfaceName;
    builtAt: string;
    sources: Sighting[];
    items: SurfaceItem[];
    outOfScope: OutOfScope[];
    notes: string[];
}
export interface Touch {
    item: string;
    need?: string;
    step?: number;
}
export declare const SCENARIO_STATUSES: readonly ["passed", "failed", "skipped", "undefined", "pending", "ambiguous"];
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];
/** One character per status: p passed, f failed, s skipped, u undefined, n pending, a ambiguous. One copy; was two. */
export type StepCode = "p" | "f" | "s" | "u" | "n" | "a";
export declare const STATUS_CODE: Record<ScenarioStatus, StepCode>;
export interface ScenarioResult {
    /** `<feature file>:<line>`. */
    id: string;
    name: string;
    feature: string;
    tags: string[];
    status: ScenarioStatus;
    durationMs: number;
    touches: Touch[];
    failure?: {
        step: string;
        message: string;
        at?: number;
    };
}
export interface RunResult {
    env: Env;
    runId: string;
    startedAt: string;
    finishedAt: string;
    versions: Record<string, unknown>;
    parallel?: number;
    /** The cadence the run was started for (`--cadence`); absent for an ordinary run. */
    cadence?: string;
    scenarios: ScenarioResult[];
}
/**
 * The runs that speak for one env now, from its runs oldest first: its newest ordinary run and its newest run of
 * each cadence, in the order given. A cadence run speaks only for its cadence's scenarios, and an ordinary run
 * never for them.
 */
export declare function currentRuns<T>(runs: readonly T[], cadenceOf: (run: T) => string | undefined): T[];
export interface PlannedScenario {
    id: string;
    name: string;
    feature: string;
    tags: string[];
}
/** The files the explorer page loads, by name. usage.json left out of the kit. */
export declare const DATA_FILES: readonly ["coverage.json", "journeys.json", "history.json", "scenarios.json", "shots.json", "board.json"];
export type DataFileName = (typeof DATA_FILES)[number];
/** data/manifest.json: the server adds `commit`; the page ignores it. Producer copy kept. */
export interface Manifest {
    version: string;
    builtAt: string;
    commit?: string;
}
export type CoverageStatus = "uncovered" | "planned" | "failing" | "passing";
export interface SurfaceInfo {
    island: string;
    surface: SurfaceName;
    title: string;
    areas: string[];
    features: string[];
    items: number;
    notes: string[];
    outOfScope: OutOfScope[];
}
export interface ItemLink {
    env?: Env;
    url: string;
}
/** One item as coverage.json carries it. The page adds idx, island and planned on top (its own Item type). */
export interface CoverageFileItem {
    id: string;
    label: string;
    surface: SurfaceName;
    area: string;
    envs: Env[];
    status: Partial<Record<Env, CoverageStatus>>;
    kind: string;
    page?: string;
    component?: string;
    parent?: string;
    usedBy?: string[];
    needs?: string[];
    documents?: string[];
    links?: ItemLink[];
    edition?: string;
    laterFailed?: Partial<Record<Env, string[]>>;
    unchecked?: Partial<Record<Env, string>>;
}
export interface DocSource {
    id: string;
    kind: "readme" | "internal-doc";
    title: string;
    url: string;
    documents: string[];
}
export interface CoverageFile {
    builtAt: string;
    /** The envs every status string is written in, in this order. New: the page used to assume three. */
    envs: Env[];
    surfaces: SurfaceInfo[];
    items: CoverageFileItem[];
    documentation?: DocSource[];
}
export interface Snapshot {
    at: string;
    env: Env;
    runId: string;
    ran: {
        scenarios: number;
        passed: number;
        failed: number;
    };
    runs: Record<Env, number>;
    /** envs.length characters per item, one per env in `envs` order. */
    status: string;
    scen: string;
    planned: string;
}
export interface HistoryScenario {
    id: string;
    name: string;
    feature: string;
    stepped?: true;
}
export interface HistoryPlanned {
    id: string;
    name: string;
    feature: string;
    surface: SurfaceName;
    envs: Env[];
    waitingOn: string;
}
/** history.json. Disagreements settled: `envs` kept (producer wrote it, page lacked it); itemSteps and itemNeeds required (the producer always writes them; the page had them optional). */
export interface HistoryFile {
    builtAt: string;
    scenariosCommit: string | null;
    envs: Env[];
    itemCount: number;
    scenarios: HistoryScenario[];
    itemScenarios: Record<string, number[]>;
    itemSteps: Record<string, Record<string, number[]>>;
    itemNeeds: Record<string, Record<string, string[]>>;
    planned: HistoryPlanned[];
    snapshots: Snapshot[];
}
/** board.json. The page's fuller shape kept (label, surface, area, status, personas on items; readAt, source on the file); the producer's three-field BoardEntry was the subset the GitHub state check read. */
export interface BoardEntry {
    id: string;
    label: string;
    surface: SurfaceName;
    url: string;
    state: "open" | "closed" | "unknown";
}
export interface BoardItem extends BoardEntry {
    area: string;
    status: string;
    personas: string[] | null;
}
export interface BoardFile {
    readAt: string;
    checkedAt: string;
    source: string;
    items: BoardItem[];
    bugs: BoardEntry[];
}
export interface GherkinStep {
    k: string;
    t: string;
    bg?: true;
    doc?: string;
    table?: string[][];
}
export interface Failure {
    at: number;
    message: string;
    step?: string;
}
/** One run's record of a scenario. `logs` keys are strings (page copy kept; the producer typed them as numbers, which JSON never carries). */
export interface ScenarioRecord {
    run: number;
    status: StepCode;
    ms: number;
    codes: string;
    stepMs: number[];
    failure?: Failure;
    steps?: GherkinStep[];
    logs?: Record<string, string>;
    shot?: string;
}
export interface ScenarioDetail {
    id: string;
    name: string;
    feature: string;
    tags: string[];
    description: string;
    steps: GherkinStep[];
    /** The envs a scheduled run runs it in. */
    applies: Env[];
    records: Record<Env, ScenarioRecord[]>;
}
export interface Version {
    service: string;
    release?: string;
    builtAt?: string;
}
export interface RunInfo {
    env: Env;
    id: string;
    startedAt: string;
    finishedAt: string;
    versions: Version[];
    scenariosCommit?: string;
    workflowRun?: string;
    /** The cadence the run was started for; absent for an ordinary run. */
    cadence?: string;
}
export interface FeatureEntry {
    file: string;
    surface: SurfaceName;
    name: string;
    description: string;
    tags: string[];
    scenarios: {
        id: string;
        name: string;
        tags: string[];
        line: number;
    }[];
}
/** scenarios.json; the producer's return was untyped before. */
export interface ScenariosFile {
    runs: RunInfo[];
    scenarios: ScenarioDetail[];
    features: FeatureEntry[];
}
export type ShotsFile = Record<string, string>;
export interface Persona {
    id: string;
    name: string;
    type: string;
    summary: string;
    who: string;
    titles: string[];
    goals: string[];
    needs: string[];
    consumes: string;
    prize: {
        quote?: string;
        test: string;
    };
    journey: {
        name: string;
        steps: string[];
    };
    friction: string[];
    antiGoals: string[];
    surfaces: string[];
    neverTouches: string[];
    editions: string[];
    fixtureRole: string;
    tensions: {
        with: string;
        conflict: string;
        rule: string;
    }[];
    evidence: {
        claim: string;
        source: string;
        date: string;
        assumption: boolean;
    }[];
    sources: {
        title: string;
        date: string;
        where: string;
    }[];
    /** Any field beyond the core is kept as read. */
    [extra: string]: unknown;
}
export interface StationOut {
    key: string;
    name: string;
    stage: string;
    kind: string;
    items: string[];
}
/** journeys.json. Enums are strings whose values come from the config vocabulary (the page had hand-copied unions; `editions` was Edition[] on the producer and string[] on the page: string[] kept). */
export interface JourneysFile {
    commit: string;
    coverageMapBuiltAt: string | null;
    personas: Persona[];
    stations: StationOut[];
    journeys: {
        persona: string;
        stations: string[];
    }[];
    orphans: string[];
    broken: {
        station: string;
        matchers: string[];
    }[];
    deadMatchers: {
        station: string;
        matcher: string;
    }[];
}
export type LiveStatus = "running" | "retrying" | ScenarioStatus;
export interface LiveScenario {
    id: string;
    name: string;
    status: LiveStatus;
    attempt: number;
    done: number;
    steps: number;
    codes: string;
    startedAt: string;
    durationMs?: number;
    failure?: string;
}
export interface RunMeta {
    env: Env;
    runId: string;
    startedAt: string;
    workers: number;
    scenariosCommit?: string;
    github?: {
        runId: string;
        attempt?: string;
        repository: string;
    };
    planned: number;
}
export type RunState = "running" | "finished" | "incomplete";
/** One run as /live/state and the `snapshot` event carry it. The server's full shape kept; the page's LiveRun lacked scenariosCommit, planned, passed, failed and finishedCount and dropped github.attempt. */
export interface RunSummary extends RunMeta {
    state: RunState;
    total: number;
    passed: number;
    failed: number;
    finishedCount: number;
    gap: boolean;
    lastMessageAt: string;
    finishedAt?: string;
}
export interface LiveStep {
    text: string;
    status?: string;
    ms?: number;
}
export interface LiveScenarioDetail extends LiveScenario {
    runId: string;
    env: Env;
    stepList: LiveStep[];
    message?: string;
    shot?: string;
}
export type LiveEventName = "snapshot" | "run-started" | "scenario-started" | "scenario-finished" | "step-finished" | "run-finished" | "run-incomplete" | "data" | "heartbeat";
/** `<env>-<ISO time with : and . as ->` as the runner makes a run id. */
export declare function runIdPattern(envs: readonly Env[]): RegExp;
export declare function makeRunId(env: Env, startedAt: Date): string;
/** A scenario id: `<features dir>/<surface>/...feature:<line>`. */
export declare function isScenarioId(id: string, featuresDir?: string): boolean;
/** The surface a scenario id belongs to, from its path `<features dir>/<surface>/`. */
export declare function surfaceOfScenarioId(id: string, surfaces: readonly SurfaceName[], featuresDir?: string): SurfaceName | undefined;
/**
 * usage.json: an optional file a workspace may publish beside the data files, with how much each item on
 * the map is used in one environment, as aggregates only (no identities: an organization is a count).
 * The explorer carries no usage view today; this is the plug-in point for one. A producer writes it from
 * whatever its product's telemetry is; a reader validates the shape below and ignores the file when absent.
 */
export declare const USAGE_FILE = "usage.json";
/** One class of use of an item (a producer picks its own class names, for example "interactive" and "api"). */
export interface UsageClass {
    /** Distinct organizations in the window, as a count. */
    orgs: number;
    /** Requests in the window. */
    n: number;
    /** Requests on the last day of the window. */
    today: number;
    /** The last day (YYYY-MM-DD) the item was used. */
    lastDay: string;
}
export interface UsageFile {
    env: Env;
    generatedAt: string;
    /** The window, as days (YYYY-MM-DD). */
    firstDay: string;
    lastDay: string;
    /** By item id, then by use class. */
    items: Record<string, Record<string, UsageClass>>;
    /** Item keys the map has no item for; counted in `items` all the same. */
    unmapped: string[];
}
export * from "./run-artifacts.js";
