import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { existingWorkflows } from "../generate/generate.ts";
import { renderAll } from "../generate/render.ts";
import { offeredThinkingLevels } from "../lib/allowlists.ts";
import { usableModels } from "../lib/gateway.ts";
import { problem, type Problem } from "../lib/problem.ts";
import { validJobs } from "../lib/repo.ts";
import type { Check } from "./types.ts";

/** Generated workflows and JOBS.md match what flax agents generate would write. */
export const generatedCheck: Check = {
  id: "generated",
  title: "generated files are up to date",
  async run(repo) {
    // With an invalid job.yml or box.yml the expected output is unknown; the schema and box checks report it instead.
    if (repo.jobs.some((j) => j.config === undefined) || repo.box === undefined)
      return [];
    const usable = usableModels(repo.allowlists.models);
    const expected = await renderAll(
      validJobs(repo).map((j) => j.config),
      repo.box,
      repo.tools,
      usable.map((m) => m.id),
      offeredThinkingLevels(usable),
    );
    const problems: Problem[] = [];
    for (const [file, content] of expected) {
      const path = join(repo.root, file);
      if (!existsSync(path))
        problems.push(problem(file, "is missing; run flax agents generate"));
      else if (readFileSync(path, "utf8") !== content)
        problems.push(
          problem(
            file,
            "is out of date or was edited by hand; run flax agents generate",
          ),
        );
    }
    for (const file of existingWorkflows(repo.root)) {
      if (!expected.has(file))
        problems.push(problem(file, "belongs to no job; run flax agents generate"));
    }
    return problems;
  },
};
