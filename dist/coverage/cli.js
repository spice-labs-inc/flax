import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { currentRuns } from "@flax/contract";
import { config } from "../config.js";
import { writeJson } from "../lib/surface.js";
import { ENVS, SURFACES } from "../lib/types.js";
import { buildCoverage, mergeRuns, renderGaps } from "./map.js";
export async function runCoverage(argv) {
    const { values } = parseArgs({
        args: argv,
        options: { results: { type: "string" } },
    });
    const kit = config();
    const files = [];
    for (const s of SURFACES) {
        const path = join(kit.paths.surfaces, `${s}.json`);
        if (existsSync(path))
            files.push(JSON.parse(await readFile(path, "utf8")));
        else
            console.error(`${s}: no ${path}`);
    }
    /**
     * One run per env from `<dir>/<env>/<run id>/run.json`: each scenario's latest
     * result across that env's runs (run ids sort by start time), so runs of
     * different features add up. A scheduled run covers every feature in one run, and a cadence run its cadence's.
     */
    async function latestResults(dir) {
        const evidence = { runs: [], planned: [] };
        const planned = new Map();
        for (const env of ENVS) {
            const envDir = join(dir, env);
            if (!existsSync(envDir))
                continue;
            const ids = (await readdir(envDir))
                .filter((id) => existsSync(join(envDir, id, "run.json")))
                .sort();
            const runs = [];
            for (const id of ids) {
                runs.push(JSON.parse(await readFile(join(envDir, id, "run.json"), "utf8")));
            }
            // Planned scenarios come from the current runs only: an older run lists ones that are real scenarios now.
            const withPlanned = ids.flatMap((id, i) => existsSync(join(envDir, id, "planned.json"))
                ? [{ id, cadence: runs[i].cadence }]
                : []);
            for (const { id } of currentRuns(withPlanned, (r) => r.cadence))
                for (const p of JSON.parse(await readFile(join(envDir, id, "planned.json"), "utf8")))
                    planned.set(p.id, p);
            const merged = mergeRuns(runs);
            if (merged)
                evidence.runs.push(merged);
        }
        const ran = new Set(evidence.runs.flatMap((r) => r.scenarios.map((s) => s.id)));
        evidence.planned = [...planned.values()].filter((p) => !ran.has(p.id));
        return evidence;
    }
    const evidence = values.results
        ? await latestResults(values.results)
        : { runs: [], planned: [] };
    const map = buildCoverage(files, new Date().toISOString(), evidence);
    await writeJson(kit.paths.coverageMap, map);
    await writeFile(kit.paths.gaps, renderGaps(map));
    const passing = map.items.filter((i) => Object.values(i.status).every((s) => s === "passing")).length;
    console.error(`coverage-map.json: ${map.items.length} items across ${files.length} surfaces; ${evidence.runs.length} runs, ${passing} items passing everywhere they apply`);
    return 0;
}
//# sourceMappingURL=cli.js.map