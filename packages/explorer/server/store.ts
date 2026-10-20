import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Envelope } from "@cucumber/messages";
import {
  isRecord,
  type Env,
  type PlannedScenario,
  type RunResult,
} from "@flax/contract";
import {
  readResultsIndex,
  RUN_ARTIFACT_FILES,
  RUN_DIR_NAME as SAFE_NAME,
} from "@flax/contract/run-artifacts";
import { ENVS } from "@flax/scenarios/lib/types";

/**
 * The directory name a run takes under `<results>/<env>/`: its run.json's run id, so runs sort by start
 * time; a run that left only index.json (its scenario run failed) gets `workflow-<run id>`, which the
 * coverage map skips as it has no run.json.
 */
export function runDirName(
  env: Env,
  files: { run?: string | undefined; index?: string | undefined },
): { name: string; failure?: string } {
  if (files.run === undefined) {
    const index =
      files.index === undefined ? undefined : readResultsIndex(files.index);
    if (!index)
      throw new Error(
        "it holds neither run.json nor an index.json this contract describes",
      );
    const name = `workflow-${index.run.id}`;
    if (!SAFE_NAME.test(name))
      throw new Error("its index.json has no usable run id");
    return { name, failure: index.run.failure ?? "no reason given" };
  }
  const run = JSON.parse(files.run) as unknown;
  if (!isRecord(run)) throw new Error("its run.json is not an object");
  if (run["env"] !== env)
    throw new Error(`its run.json is a run on ${String(run["env"])}`);
  if (typeof run["runId"] !== "string" || !SAFE_NAME.test(run["runId"]))
    throw new Error("its run.json has no usable run id");
  return { name: run["runId"] };
}

export const RUNS_PER_ENV = 50;
/** The files of an artifact the data build reads. */
export const ARTIFACT_FILES: ReadonlySet<string> = new Set(RUN_ARTIFACT_FILES);
const SOURCE = "source.json";

export type Source =
  | { kind: "push"; workflowRun?: string }
  | { kind: "artifact"; artifactId: number; workflowRun: number };

function sourceOf(dir: string): Source | undefined {
  const path = join(dir, SOURCE);
  if (!existsSync(path)) return undefined;
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(v)) return undefined;
    if (v["kind"] === "push")
      return {
        kind: "push",
        ...(typeof v["workflowRun"] === "string"
          ? { workflowRun: v["workflowRun"] }
          : {}),
      };
    if (
      v["kind"] === "artifact" &&
      typeof v["artifactId"] === "number" &&
      typeof v["workflowRun"] === "number"
    )
      return {
        kind: "artifact",
        artifactId: v["artifactId"],
        workflowRun: v["workflowRun"],
      };
  } catch {
    return undefined;
  }
  return undefined;
}

/** Writes a run directory whole: into a scratch directory beside it, then renamed into place. */
function place(target: string, files: Map<string, Buffer | string>): void {
  const parent = join(target, "..");
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.incoming-${randomBytes(6).toString("hex")}`);
  mkdirSync(tmp);
  try {
    for (const [name, body] of files) writeFileSync(join(tmp, name), body);
    if (existsSync(target)) {
      const old = join(parent, `.old-${randomBytes(6).toString("hex")}`);
      renameSync(target, old);
      renameSync(tmp, target);
      rmSync(old, { recursive: true, force: true });
    } else renameSync(tmp, target);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A pushed run's results, in the layout `pnpm results:fetch` leaves; never over a run its artifact already gave. */
export function writePushedRun(
  resultsDir: string,
  run: RunResult,
  planned: PlannedScenario[],
  envelopes: Envelope[],
  workflowRun?: string,
): boolean {
  const target = join(resultsDir, run.env, run.runId);
  if (sourceOf(target)?.kind === "artifact") return false;
  const source: Source = {
    kind: "push",
    ...(workflowRun ? { workflowRun } : {}),
  };
  place(
    target,
    new Map([
      ["run.json", `${JSON.stringify(run, null, 2)}\n`],
      ["planned.json", `${JSON.stringify(planned, null, 2)}\n`],
      [
        "messages.ndjson",
        envelopes.map((e) => JSON.stringify(e)).join("\n") + "\n",
      ],
      [SOURCE, JSON.stringify(source)],
    ]),
  );
  return true;
}

export type ArtifactOutcome = { kept: string } | { skipped: string };

/** An artifact's run: replaces the pushed copy of the same run; a run that left no run.json is skipped. */
export function writeArtifactRun(
  resultsDir: string,
  env: Env,
  files: Map<string, Buffer>,
  artifact: { id: number; runId: number },
): ArtifactOutcome {
  const text = (n: string) => files.get(n)?.toString("utf8");
  const { name, failure } = runDirName(env, {
    run: text("run.json"),
    index: text("index.json"),
  });
  if (failure !== undefined)
    return { skipped: `its scenario run left no results: ${failure}` };
  const target = join(resultsDir, env, name);
  const was = sourceOf(target);
  if (was?.kind === "artifact" || (existsSync(target) && !was))
    return { skipped: `${name} is already here` };
  const source: Source = {
    kind: "artifact",
    artifactId: artifact.id,
    workflowRun: artifact.runId,
  };
  const out = new Map<string, Buffer | string>();
  for (const [n, body] of files) if (ARTIFACT_FILES.has(n)) out.set(n, body);
  out.set(SOURCE, JSON.stringify(source));
  place(target, out);
  return { kept: name };
}

/** The workflow runs whose artifact copy is here, so the poller downloads none of them again. */
export function artifactRuns(resultsDir: string): Set<number> {
  const out = new Set<number>();
  for (const env of ENVS) {
    const dir = join(resultsDir, env);
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir)) {
      const s = sourceOf(join(dir, d));
      if (s?.kind === "artifact") out.add(s.workflowRun);
    }
  }
  return out;
}

/** Keeps each env's newest runs (run ids sort by start time) and clears scratch left by a crash. */
export function prune(resultsDir: string, perEnv = RUNS_PER_ENV): string[] {
  const removed: string[] = [];
  for (const env of ENVS) {
    const dir = join(resultsDir, env);
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir);
    for (const d of entries)
      if (d.startsWith(".incoming-") || d.startsWith(".old-"))
        rmSync(join(dir, d), { recursive: true, force: true });
    const runs = entries
      .filter((d) => !d.startsWith(".") && existsSync(join(dir, d, "run.json")))
      .sort()
      .reverse();
    for (const d of runs.slice(perEnv)) {
      rmSync(join(dir, d), { recursive: true, force: true });
      removed.push(`${env}/${d}`);
    }
  }
  return removed;
}
