import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { offeredThinkingLevels } from "../lib/allowlists.ts";
import { usableModels } from "../lib/gateway.ts";
import { WORKFLOWS_DIR } from "../lib/paths.ts";
import { isError, type Problem } from "../lib/problem.ts";
import { validJobs, type Repo } from "../lib/repo.ts";
import { byCodePoint } from "../lib/sort.ts";
import {
  GENERATED_WORKFLOW,
  renderAll,
  REVISE_POLL_WORKFLOW,
} from "./render.ts";

/** Generated workflow files currently on disk, relative to the repository root. */
export function existingWorkflows(root: string): string[] {
  const dir = join(root, WORKFLOWS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (f) =>
        GENERATED_WORKFLOW.test(f) ||
        `${WORKFLOWS_DIR}/${f}` === REVISE_POLL_WORKFLOW,
    )
    .sort(byCodePoint)
    .map((f) => `${WORKFLOWS_DIR}/${f}`);
}

/** Invalid job.yml or box.yml files cannot be rendered, so nothing is generated until they are fixed. */
export function blockingProblems(repo: Repo): Problem[] {
  return [
    ...repo.jobs.flatMap((j) => j.problems),
    ...repo.boxProblems.filter(isError),
  ];
}

/**
 * flax agents generate writes the job workflows and JOBS.md, which pull requests
 * carry. With --dist it also rebuilds the runner bundles in dist/, which
 * only main carries (rebuild-dist.yml runs it after each merge).
 */
export function generateOptions(args: readonly string[]): { dist: boolean } {
  const unknown = args.filter((a) => a !== "--dist");
  if (unknown.length > 0)
    throw new Error(
      `flax agents generate takes only --dist, not ${unknown.join(" ")}`,
    );
  return { dist: args.includes("--dist") };
}

export interface GenerateResult {
  written: string[];
  unchanged: string[];
  removed: string[];
}

export async function generate(repo: Repo): Promise<GenerateResult> {
  const blocking = blockingProblems(repo);
  if (blocking.length > 0 || repo.box === undefined)
    throw new Error(
      "job.yml and box.yml problems must be fixed before generating",
    );
  const usable = usableModels(repo.allowlists.models);
  const files = await renderAll(
    validJobs(repo).map((j) => j.config),
    repo.box,
    repo.tools,
    usable.map((m) => m.id),
    offeredThinkingLevels(usable),
  );
  const result: GenerateResult = { written: [], unchanged: [], removed: [] };
  for (const [file, content] of files) {
    const path = join(repo.root, file);
    if (existsSync(path) && readFileSync(path, "utf8") === content) {
      result.unchanged.push(file);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    result.written.push(file);
  }
  for (const file of existingWorkflows(repo.root)) {
    if (files.has(file)) continue;
    rmSync(join(repo.root, file));
    result.removed.push(file);
  }
  return result;
}
