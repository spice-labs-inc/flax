import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "../config.ts";
import { writeJson } from "../lib/surface.ts";
import { ENVS, SURFACES, type SurfaceFile } from "../lib/types.ts";
import type { PlannedScenario, RunResult } from "../run/results.ts";
import { buildCoverage, mergeRuns, renderGaps, type Evidence } from "./map.ts";

export async function runCoverage(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { results: { type: "string" } },
  });
  const kit = config();

  const files: SurfaceFile[] = [];
  for (const s of SURFACES) {
    const path = join(kit.paths.surfaces, `${s}.json`);
    if (existsSync(path))
      files.push(JSON.parse(await readFile(path, "utf8")) as SurfaceFile);
    else console.error(`${s}: no ${path}`);
  }

  /**
   * One run per env from `<dir>/<env>/<run id>/run.json`: each scenario's latest
   * result across that env's runs (run ids sort by start time), so runs of
   * different features add up. A scheduled run covers every feature in one run.
   */
  async function latestResults(dir: string): Promise<Evidence> {
    const evidence: Evidence = { runs: [], planned: [] };
    const planned = new Map<string, PlannedScenario>();
    for (const env of ENVS) {
      const envDir = join(dir, env);
      if (!existsSync(envDir)) continue;
      const ids = (await readdir(envDir))
        .filter((id) => existsSync(join(envDir, id, "run.json")))
        .sort();
      const runs: RunResult[] = [];
      for (const id of ids) {
        runs.push(
          JSON.parse(
            await readFile(join(envDir, id, "run.json"), "utf8"),
          ) as RunResult,
        );
      }
      // Planned scenarios come from the newest run only: an older run lists ones that are real scenarios now.
      const newest = ids
        .filter((id) => existsSync(join(envDir, id, "planned.json")))
        .at(-1);
      if (newest)
        for (const p of JSON.parse(
          await readFile(join(envDir, newest, "planned.json"), "utf8"),
        ) as PlannedScenario[])
          planned.set(p.id, p);
      const merged = mergeRuns(runs);
      if (merged) evidence.runs.push(merged);
    }
    const ran = new Set(
      evidence.runs.flatMap((r) => r.scenarios.map((s) => s.id)),
    );
    evidence.planned = [...planned.values()].filter((p) => !ran.has(p.id));
    return evidence;
  }

  const evidence = values.results
    ? await latestResults(values.results)
    : { runs: [], planned: [] };
  const map = buildCoverage(files, new Date().toISOString(), evidence);
  await writeJson(kit.paths.coverageMap, map);
  await writeFile(kit.paths.gaps, renderGaps(map));
  const passing = map.items.filter((i) =>
    Object.values(i.status).every((s) => s === "passing"),
  ).length;
  console.error(
    `coverage-map.json: ${map.items.length} items across ${files.length} surfaces; ${evidence.runs.length} runs, ${passing} items passing everywhere they apply`,
  );
  return 0;
}
