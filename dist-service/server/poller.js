import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@flax/contract";
import { resultsArtifactName, RUN_ARTIFACT_FILES, } from "@flax/contract/run-artifacts";
import { ENVS } from "@flax/scenarios/lib/types";
import { boardQuery } from "../scripts/data.js";
import { withBoardStates } from "../scripts/build.js";
import { artifactRuns, prune, RUNS_PER_ENV, writeArtifactRun, } from "./store.js";
import { unzip } from "./zip.js";
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const SEEN = ".seen-artifacts.json";
const WANTED = new Set(RUN_ARTIFACT_FILES);
function positiveId(v) {
    return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}
/** One page of `GET /repos/{repo}/actions/artifacts?name=`: the artifacts of that name. */
export function parseArtifacts(body, name) {
    if (!isRecord(body) || !Array.isArray(body["artifacts"]))
        throw new Error(`listing the ${name} artifacts answered no list`);
    const artifacts = [];
    for (const a of body["artifacts"]) {
        if (!isRecord(a) || a["name"] !== name || !positiveId(a["id"]))
            continue;
        const run = a["workflow_run"];
        const runId = isRecord(run) ? run["id"] : undefined;
        if (!positiveId(runId))
            continue;
        artifacts.push({
            id: a["id"],
            expired: a["expired"] === true,
            createdAt: typeof a["created_at"] === "string" ? a["created_at"] : "",
            runId,
        });
    }
    return artifacts;
}
/** The env a workflow run's title names, when it names one of ours. */
export function envOfTitle(title) {
    if (!title)
        return undefined;
    const words = title.toLowerCase().split(/[^a-z0-9_-]+/);
    return ENVS.find((e) => words.includes(e.toLowerCase()));
}
export function parseRunning(body, repo) {
    if (!isRecord(body) || !Array.isArray(body["workflow_runs"]))
        return [];
    const out = [];
    for (const r of body["workflow_runs"]) {
        if (!isRecord(r) ||
            typeof r["id"] !== "number" ||
            typeof r["event"] !== "string")
            continue;
        const startedAt = typeof r["run_started_at"] === "string"
            ? r["run_started_at"]
            : r["created_at"];
        if (typeof startedAt !== "string")
            continue;
        const env = envOfTitle(typeof r["display_title"] === "string" ? r["display_title"] : undefined);
        out.push({
            id: r["id"],
            url: typeof r["html_url"] === "string"
                ? r["html_url"]
                : `https://github.com/${repo}/actions/runs/${r["id"]}`,
            event: r["event"],
            startedAt,
            ...(env ? { env } : {}),
        });
    }
    return out;
}
/** The artifacts to download for an env: among its newest runs (live and shadow), those not here yet. */
export function toDownload(artifacts, present, seen) {
    const byRun = new Map();
    for (const a of [...artifacts].sort((x, y) => y.createdAt.localeCompare(x.createdAt)))
        if (!a.expired && !byRun.has(a.runId))
            byRun.set(a.runId, a);
    return [...byRun.values()]
        .slice(0, RUNS_PER_ENV)
        .filter((a) => !present.has(a.runId) && !seen.has(a.id));
}
/** GitHub as the fallback results source: the artifacts, the runs in progress and the board's issue states. */
export class Poller {
    #gh;
    #source;
    #resultsDir;
    #log;
    #seen;
    running = [];
    board;
    constructor(gh, source, resultsDir, board, log) {
        this.#gh = gh;
        this.#source = source;
        this.#resultsDir = resultsDir;
        this.#log = log;
        this.board = board;
        this.#seen = new Set();
        const path = join(resultsDir, SEEN);
        if (existsSync(path))
            try {
                const v = JSON.parse(readFileSync(path, "utf8"));
                if (Array.isArray(v))
                    for (const id of v)
                        if (typeof id === "number")
                            this.#seen.add(id);
            }
            catch {
                // Only costs downloads the results directory then skips.
            }
    }
    /** Downloads the runs not here yet; resolves to how many were kept. */
    async artifacts() {
        let kept = 0;
        const { repo, job } = this.#source;
        const present = artifactRuns(this.#resultsDir);
        for (const env of ENVS) {
            const listed = [];
            for (const mode of ["live", "shadow"]) {
                const name = resultsArtifactName(job, mode, env);
                const body = await this.#gh.json(`/repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`);
                listed.push(...parseArtifacts(body, name));
            }
            for (const a of toDownload(listed, present, this.#seen)) {
                try {
                    const zip = await this.#gh.download(`/repos/${repo}/actions/artifacts/${a.id}/zip`, MAX_ARTIFACT_BYTES);
                    const outcome = writeArtifactRun(this.#resultsDir, env, unzip(zip, WANTED, MAX_FILE_BYTES), a);
                    if ("kept" in outcome) {
                        kept++;
                        this.#log("info", `artifact ${a.id} (workflow run ${a.runId}) -> ${env}/${outcome.kept}`);
                    }
                    else
                        this.#log("info", `artifact ${a.id} (workflow run ${a.runId}) skipped: ${outcome.skipped}`);
                    this.#seen.add(a.id);
                }
                catch (e) {
                    this.#log("warn", `artifact ${a.id} (workflow run ${a.runId}): ${e.message}`);
                }
            }
        }
        for (const r of prune(this.#resultsDir))
            this.#log("info", `results ${r} dropped, past the newest ${RUNS_PER_ENV}`);
        writeFileSync(join(this.#resultsDir, SEEN), JSON.stringify([...this.#seen].slice(-2000)));
        return kept;
    }
    async inProgress() {
        const { repo, workflow } = this.#source;
        this.running = parseRunning(await this.#gh.json(`/repos/${repo}/actions/workflows/${workflow}/runs?status=in_progress&per_page=20`), repo);
        return this.running;
    }
    /** Re-reads whether each board issue is open; resolves to whether any state changed. */
    async boardStates(now) {
        const entries = [...this.board.items, ...this.board.bugs];
        if (entries.length === 0)
            return false;
        const next = withBoardStates(this.board, await this.#gh.graphql(boardQuery(entries)), now);
        const before = entries.map((e) => e.state).join();
        const changed = [...next.items, ...next.bugs].map((e) => e.state).join() !== before;
        this.board = next;
        return changed;
    }
}
//# sourceMappingURL=poller.js.map