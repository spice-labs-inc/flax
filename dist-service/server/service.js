import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { config } from "@flax/scenarios/config";
import { explorerConfig } from "./config.js";
import { AppGitHub, appKey } from "./github.js";
import { Hub } from "./hub.js";
import { jsonLog as log } from "./log.js";
import { Poller } from "./poller.js";
import { readManifest, Rebuilder } from "./rebuild.js";
import { LiveRuns } from "./runs.js";
import { explorerServer, snapshot } from "./server.js";
import { prune, writePushedRun } from "./store.js";
const env = process.env;
const root = env["EXPLORER_DATASET_DIR"] ?? process.cwd();
const explorer = explorerConfig(root);
const state = env["EXPLORER_STATE_DIR"] ?? "/srv";
const dataDir = join(state, "data");
const resultsDir = env["EXPLORER_RESULTS_DIR"] ?? join(state, "results");
const liveDir = join(state, "live");
const siteDir = env["EXPLORER_SITE_DIR"];
const port = Number(env["EXPLORER_PORT"] ?? explorer.port);
const commit = env["EXPLORER_COMMIT"] ?? "unknown";
const token = env["EXPLORER_INGEST_TOKEN"]?.trim() || undefined;
for (const d of [dataDir, resultsDir, liveDir])
    mkdirSync(d, { recursive: true });
if (!token)
    log("warn", "ingest off: EXPLORER_INGEST_TOKEN is not set");
/** The board file is optional: without one the map shows no open issues. */
function readBoard() {
    const path = join(root, config().paths.board);
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        const at = new Date().toISOString();
        return { readAt: at, checkedAt: at, source: "none", items: [], bugs: [] };
    }
}
/**
 * GitHub as the fallback results source, when flax.yml names one under `explorer.results` and the
 * reader app's credentials are set: EXPLORER_GH_APP_ID and EXPLORER_GH_APP_KEY (the PEM, or base64 of it).
 */
function makePoller() {
    const source = explorer.results;
    const appId = env["EXPLORER_GH_APP_ID"]?.trim();
    const key = env["EXPLORER_GH_APP_KEY"];
    if (!source)
        return undefined;
    if (!appId || !key) {
        log("warn", `GitHub results off: flax.yml names ${source.repo} but EXPLORER_GH_APP_ID or EXPLORER_GH_APP_KEY is not set`);
        return undefined;
    }
    const gh = new AppGitHub(appId, appKey(key), source.repo);
    return new Poller(gh, source, resultsDir, readBoard(), log);
}
const poller = makePoller();
function buildInWorker(outDir, now) {
    const input = {
        outDir,
        build: {
            root,
            resultsDir,
            commit,
            now,
            board: poller?.board ?? readBoard(),
        },
    };
    return new Promise((resolve, reject) => {
        const w = new Worker(new URL("./build-worker.js", import.meta.url), {
            workerData: input,
        });
        let lines = [];
        w.on("message", (m) => {
            if (Array.isArray(m))
                lines = m.filter((l) => typeof l === "string");
        });
        w.on("error", reject);
        w.on("exit", (code) => {
            if (code !== 0)
                return reject(new Error(`the data build stopped with code ${code}`));
            for (const l of lines)
                log("info", l);
            resolve();
        });
    });
}
const runs = new LiveRuns(liveDir, Date.now());
let manifest = readManifest(dataDir);
const live = () => ({
    data: manifest ?? null,
    polling: poller !== undefined,
    running: poller?.running ?? [],
});
const hub = new Hub(() => snapshot(runs, live()));
const rebuilder = new Rebuilder({
    dataDir,
    commit,
    build: buildInWorker,
    log,
    onData: (m) => {
        manifest = m;
        hub.send("data", m);
    },
});
const server = explorerServer({
    token,
    runs,
    hub,
    log,
    static: { data: dataDir, site: siteDir },
    snapshotExtra: live,
    onFinish: (run, finished) => {
        try {
            writePushedRun(resultsDir, finished.run, finished.planned, run.envelopes(), run.meta.github?.runId);
            prune(resultsDir);
        }
        catch (e) {
            log("warn", `run ${run.meta.runId}: results not written: ${e.message}`);
            return;
        }
        log("info", `run ${run.meta.runId} finished: ${finished.run.scenarios.length} scenarios${finished.incomplete ? ", live stream incomplete" : ""}`);
        void rebuilder.request(`run ${run.meta.runId} finished`);
    },
});
const every = (ms, what, fn) => {
    let busy = false;
    const tick = () => {
        if (busy)
            return;
        busy = true;
        fn()
            .catch((e) => log("warn", `${what}: ${e.message}`))
            .finally(() => {
            busy = false;
        });
    };
    setInterval(tick, ms).unref();
    return tick;
};
server.listen(port, () => log("info", `explorer service on :${port}, data ${manifest?.version ?? "none yet"}${siteDir ? `, page from ${siteDir}` : ""}`));
const sweep = every(60_000, "sweep", async () => {
    for (const r of runs.sweep(Date.now()))
        hub.send("run-incomplete", {
            env: r.meta.env,
            runId: r.meta.runId,
            reason: "quiet",
        });
});
sweep();
if (poller) {
    const artifacts = every(5 * 60_000, "artifacts", async () => {
        const kept = await poller.artifacts();
        if (kept > 0)
            await rebuilder.request(`${kept} new run${kept === 1 ? "" : "s"} from GitHub`);
    });
    const running = every(60_000, "runs in progress", async () => {
        await poller.inProgress();
        hub.send("running", poller.running);
    });
    const board = every(15 * 60_000, "board", async () => {
        if (await poller.boardStates(new Date().toISOString()))
            await rebuilder.request("board states changed");
    });
    artifacts();
    running();
    board();
}
const stale = () => !manifest || manifest.commit !== commit;
if (stale())
    void rebuilder.request("a new service build");
const stop = () => {
    hub.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
//# sourceMappingURL=service.js.map