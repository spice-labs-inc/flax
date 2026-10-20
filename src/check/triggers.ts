import { jobFile } from "../lib/paths.ts";
import { problem, type Problem } from "../lib/problem.ts";
import { triggerAfter } from "../lib/job.ts";
import { validJobs } from "../lib/repo.ts";
import { byCodePoint } from "../lib/sort.ts";
import type { Check } from "./types.ts";

// GitHub drops workflow_run events more than three workflows down a chain,
// so a deeper job would silently never run.
export const MAX_CHAIN_DEPTH = 3;

/** Each job maps to the job it runs after, or undefined. */
export type AfterGraph = ReadonlyMap<string, string | undefined>;

/**
 * Cycles in the "runs after" graph. Each job has at most one `after`, so every
 * cycle is found by walking forward from some job; each is reported once,
 * starting from the job the walk reached first.
 */
export function findCycles(graph: AfterGraph): string[][] {
  const state = new Map<string, "walking" | "done">();
  const cycles: string[][] = [];
  for (const start of [...graph.keys()].sort(byCodePoint)) {
    const path: string[] = [];
    let current: string | undefined = start;
    while (current !== undefined && graph.has(current) && !state.has(current)) {
      state.set(current, "walking");
      path.push(current);
      current = graph.get(current);
    }
    if (current !== undefined && state.get(current) === "walking") {
      cycles.push(path.slice(path.indexOf(current)));
    }
    for (const job of path) state.set(job, "done");
  }
  return cycles;
}

/** How many workflow_run hops a job is from a job with its own trigger; undefined when on or behind a cycle or a missing job. */
export function chainDepth(graph: AfterGraph, job: string): number | undefined {
  let depth = 0;
  let current = job;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current) || !graph.has(current)) return undefined;
    seen.add(current);
    const next = graph.get(current);
    if (next === undefined) return depth;
    depth += 1;
    current = next;
  }
}

export function triggerProblems(graph: AfterGraph): Problem[] {
  const problems: Problem[] = [];
  for (const [job, after] of [...graph].sort(([a], [b]) => byCodePoint(a, b))) {
    if (after === undefined) continue;
    const file = jobFile(job, "job.yml");
    if (!graph.has(after)) {
      problems.push(
        problem(file, `"${after}" is not an existing job`, "trigger.after"),
      );
      continue;
    }
    const depth = chainDepth(graph, job);
    if (depth !== undefined && depth > MAX_CHAIN_DEPTH) {
      problems.push(
        problem(
          file,
          `is ${depth} "after" steps from a scheduled or manual job; GitHub only chains ${MAX_CHAIN_DEPTH}`,
          "trigger.after",
        ),
      );
    }
  }
  for (const cycle of findCycles(graph)) {
    problems.push(
      problem(
        jobFile(cycle[0]!, "job.yml"),
        `trigger cycle: ${[...cycle, cycle[0]].join(" -> ")}`,
        "trigger.after",
      ),
    );
  }
  return problems;
}

/** `after:` names an existing job, and "after" chains have no cycles and fit GitHub's depth limit. */
export const triggersCheck: Check = {
  id: "triggers",
  title: "after triggers name existing jobs and form no cycle",
  run(repo) {
    const graph = new Map<string, string | undefined>();
    for (const { name, config } of validJobs(repo))
      graph.set(name, triggerAfter(config));
    // A job whose job.yml is invalid still exists as a target.
    for (const job of repo.jobs)
      if (!graph.has(job.name)) graph.set(job.name, undefined);
    return triggerProblems(graph);
  },
};
