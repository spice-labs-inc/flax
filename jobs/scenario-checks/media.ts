import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMain } from "@flax/agents/collect/tools";
import type { CheckResult } from "@flax/agents/deliver/check-results";
import {
  checkEnvs,
  mediaSourceDir,
  TARGET_ENV_ENV,
  type CheckEnv,
} from "@flax/agents/lib/job";
import {
  MEDIA_DIR_ENV,
  MEDIA_DISPATCH_ENV,
  MEDIA_GH_TOKEN_ENV,
} from "@flax/agents/lib/media";
import { workspaceRoot } from "@flax/agents/lib/workspace";
import { writeManifest } from "@flax/agents/media/manifest";

export const SCENARIOS = "{{github}}/{{scenariosRepo}}";
/** Where the scenario library may create fixture organizations. */
export const FIXTURE_ENVS: readonly CheckEnv[] = {{fixtureEnvironments}};
/** Where the GitHub Action scenarios start workflow runs; the scenario library's action-check workflow takes only these. */
export const DISPATCH_ENVS: readonly CheckEnv[] = {{dispatchEnvironments}};
/** The explorer the scenario run pushes its progress to; not a secret. */
export const EXPLORER_URL = "{{explorerUrl}}";
/** A URL per environment, <env> standing for its id, that answers once the product is up. */
const PROBE_URL = "{{probeUrl}}";

/** What the scenario library's GitHub Action scenarios dispatch their workflow runs with. */
export const SCENARIOS_DISPATCH_ENV = "SCENARIOS_DISPATCH_TOKEN";

/** The scenario run's environment: media.ts's own, with the explorer's URL, so the run pushes live updates when it also has EXPLORER_INGEST_TOKEN, and the dispatch token under the name the scenario library reads. */
export function scenarioEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [MEDIA_DISPATCH_ENV]: dispatch, ...rest } = env;
  return {
    ...rest,
    EXPLORER_URL,
    ...(dispatch === undefined ? {} : { [SCENARIOS_DISPATCH_ENV]: dispatch }),
  };
}

/** What a run of the scenario library writes into results/<env>/<run id>/. */
export const RESULT_FILES = ["run.json", "planned.json", "messages.ndjson"];
const PROBE_TRIES = 12;
const PROBE_WAIT_MS = 10_000;
const RETRY_WAIT_MS = 30_000;

const log = (line: string) =>
  console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

/** The URL the run waits for before it starts the scenarios in an environment. */
export function probeUrl(env: CheckEnv): string {
  return PROBE_URL.replaceAll("<env>", env);
}

/** Fixture scenarios at once, one fixture organization each, per environment; an environment not listed gets one. */
export const WORKERS: Readonly<Record<CheckEnv, number>> = {{workers}};

/** The arguments of one scenario run: fixture scenarios wherever fixtures may be created, `WORKERS` at a time, and the GitHub Action scenarios, which start workflow runs, where those may. */
export function scenarioArgs(env: CheckEnv, out: string): string[] {
  return [
    "exec",
    "flax",
    "scenarios",
    "run",
    "--env",
    env,
    ...(FIXTURE_ENVS.includes(env)
      ? ["--fixtures", "--parallel", String(WORKERS[env] ?? 1)]
      : []),
    ...(DISPATCH_ENVS.includes(env) ? ["--dispatch"] : []),
    "--out",
    out,
  ];
}

interface ScenarioRun {
  env: string;
  runId: string;
  versions: Record<string, unknown>;
  scenarios: {
    id: string;
    name: string;
    feature: string;
    status: string;
    failure?: { step: string; message: string };
  }[];
}

/** A scenario's result as a check: skipped stays skipped, and anything but passed or skipped (undefined, pending, ambiguous) fails, with the step that failed and its error. */
export function checkOf(
  s: ScenarioRun["scenarios"][number],
  screenshots = 0,
  sourceRoot?: string,
): CheckResult {
  const status =
    s.status === "passed" || s.status === "skipped" ? s.status : "failed";
  const detail =
    s.failure === undefined
      ? status === "failed"
        ? s.status
        : undefined
      : (sourceRoot === undefined
          ? s.failure.message
          : s.failure.message.replaceAll(`${sourceRoot}/`, "")
        ).trim() || undefined;
  return {
    name: `${s.feature}: ${s.name}`,
    status,
    ...(s.failure === undefined ? {} : { step: s.failure.step }),
    ...(detail === undefined ? {} : { detail }),
    ...(status === "failed" && screenshots > 0 ? { screenshots } : {}),
  };
}

interface Envelope {
  pickle?: { id: string; uri: string; location?: { line: number } };
  testCase?: { id: string; pickleId: string };
  testCaseStarted?: { id: string; testCaseId: string };
  testCaseFinished?: { testCaseStartedId: string; willBeRetried?: boolean };
  attachment?: {
    testCaseStartedId?: string;
    mediaType?: string;
    contentEncoding?: string;
  };
}

/**
 * How many screenshots cucumber's messages hold for each scenario, by the
 * id the scenario library gives it (feature file:line), counting only the
 * attempt that was not retried.
 */
export function screenshotsOf(ndjson: string): Map<string, number> {
  const pickles = new Map<string, string>();
  const testCases = new Map<string, string>();
  const started = new Map<string, string>();
  const images = new Map<string, number>();
  const retried = new Set<string>();
  for (const text of ndjson.split("\n")) {
    if (text.trim() === "") continue;
    let e: Envelope;
    try {
      e = JSON.parse(text) as Envelope;
    } catch {
      continue;
    }
    if (e.pickle)
      pickles.set(
        e.pickle.id,
        `${e.pickle.uri}:${e.pickle.location?.line ?? 0}`,
      );
    if (e.testCase) testCases.set(e.testCase.id, e.testCase.pickleId);
    if (e.testCaseStarted)
      started.set(e.testCaseStarted.id, e.testCaseStarted.testCaseId);
    if (e.testCaseFinished?.willBeRetried)
      retried.add(e.testCaseFinished.testCaseStartedId);
    const a = e.attachment;
    if (
      a?.testCaseStartedId !== undefined &&
      a.mediaType?.startsWith("image/") === true &&
      a.contentEncoding === "BASE64"
    )
      images.set(
        a.testCaseStartedId,
        (images.get(a.testCaseStartedId) ?? 0) + 1,
      );
  }
  const out = new Map<string, number>();
  for (const [startedId, count] of images) {
    if (retried.has(startedId)) continue;
    const pickle = pickles.get(
      testCases.get(started.get(startedId) ?? "") ?? "",
    );
    if (pickle !== undefined) out.set(pickle, (out.get(pickle) ?? 0) + count);
  }
  return out;
}

/** The builds a run checked, from what each service answered for its version, as flat strings. */
export function buildsOf(
  versions: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [service, value] of Object.entries(versions)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      for (const [k, v] of Object.entries(value))
        out[`${service}.${k}`] = String(v);
    else out[service] = String(value);
  }
  return out;
}

/**
 * Copies a scenario run directory into the media directory and writes
 * media.json: the run's files, and in data every scenario as a check
 * (with its screenshot count and, in a failure, the error with the
 * checkout path taken out), the builds it ran against and the scenario
 * library's commit.
 */
export async function packageRun(
  runDir: string,
  mediaDir: string,
  scenarios: { commit: string; fixtures: boolean },
  sourceRoot?: string,
): Promise<{ checks: number; failed: number }> {
  for (const file of RESULT_FILES)
    if (!existsSync(join(runDir, file)))
      throw new Error(`the run wrote no ${file}`);
  const run = JSON.parse(
    await readFile(join(runDir, "run.json"), "utf8"),
  ) as ScenarioRun;
  for (const file of RESULT_FILES)
    copyFileSync(join(runDir, file), join(mediaDir, file));
  const shots = screenshotsOf(
    await readFile(join(runDir, "messages.ndjson"), "utf8"),
  );
  const checks: Record<string, CheckResult> = {};
  for (const s of run.scenarios)
    checks[s.id] = checkOf(s, shots.get(s.id), sourceRoot);
  await writeManifest(mediaDir, RESULT_FILES, {
    env: run.env,
    runId: run.runId,
    scenarios: { repo: SCENARIOS, ...scenarios },
    checks,
    builds: {
      ...buildsOf(run.versions),
      scenarios: scenarios.commit,
    },
  });
  return {
    checks: run.scenarios.length,
    failed: Object.values(checks).filter((c) => c.status === "failed").length,
  };
}

/** media.ts's environment without the read token and the dispatch token, which only the scenario run gets. */
export function withoutGithubTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out[MEDIA_GH_TOKEN_ENV];
  delete out[MEDIA_DISPATCH_ENV];
  return out;
}

/** Runs a command with its output in the workflow log; resolves to its exit code. */
function command(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = withoutGithubTokens(process.env),
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function mustRun(cmd: string, args: string[], cwd: string) {
  const code = await command(cmd, args, cwd);
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${code}`);
}

/** Tries a setup step a second time after a pause. */
export async function twice<T>(
  what: string,
  step: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  try {
    return await step();
  } catch (err) {
    log(`${what} failed (${(err as Error).message}); trying once more`);
    await wait(RETRY_WAIT_MS);
    try {
      return await step();
    } catch (again) {
      throw new Error(`${what} failed twice: ${(again as Error).message}`);
    }
  }
}

async function probe(url: string): Promise<void> {
  let last = "";
  for (let i = 1; i <= PROBE_TRIES; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      await res.body?.cancel();
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).name;
    }
    if (i < PROBE_TRIES) await new Promise((r) => setTimeout(r, PROBE_WAIT_MS));
  }
  throw new Error(`${url} did not answer in ${PROBE_TRIES} tries (${last})`);
}

/** The one run directory a scenario run wrote under out/<env>/. */
function runDirIn(out: string, env: CheckEnv): string {
  const dir = join(out, env);
  const runs = existsSync(dir) ? readdirSync(dir) : [];
  if (runs.length !== 1 || !existsSync(join(dir, runs[0]!, "run.json")))
    throw new Error(`the scenario run wrote no results under ${env}/`);
  return join(dir, runs[0]!);
}

async function main(): Promise<void> {
  const mediaDir = process.env[MEDIA_DIR_ENV];
  if (!mediaDir) throw new Error(`${MEDIA_DIR_ENV} is not set`);
  const envs = checkEnvs();
  const env = envs.find((e) => e === process.env[TARGET_ENV_ENV]);
  if (env === undefined)
    throw new Error(`${TARGET_ENV_ENV} must be one of ${envs.join(", ")}`);
  const root = join(workspaceRoot(), mediaSourceDir(SCENARIOS));
  if (!existsSync(join(root, "package.json")))
    throw new Error(
      `${mediaSourceDir(SCENARIOS)} is missing; list ${SCENARIOS} in media.sources`,
    );
  const commit = await new Promise<string>((resolve, reject) => {
    const git = spawn("git", ["-C", root, "rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    git.stdout.on("data", (c: Buffer) => (out += c.toString()));
    git.on("error", reject);
    git.on("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error("git rev-parse failed")),
    );
  });
  log(`${SCENARIOS} at ${commit}, checking ${env}`);
  await twice("installing the scenario library's packages", () =>
    mustRun("pnpm", ["install", "--frozen-lockfile"], root),
  );
  await twice("installing Chromium", () =>
    mustRun("pnpm", ["exec", "playwright", "install", "chromium"], root),
  );
  await twice(`reaching ${probeUrl(env)}`, () => probe(probeUrl(env)));
  // Exit 1 is a run with failing scenarios; only a run that wrote no results is tried again.
  const runDir = await twice("the scenario run", async () => {
    const out = mkdtempSync(join(tmpdir(), "scenario-checks-"));
    const code = await command(
      "pnpm",
      scenarioArgs(env, out),
      root,
      scenarioEnv(process.env),
    );
    if (code !== 0 && code !== 1)
      throw new Error(`the scenario run exited ${code}`);
    return runDirIn(out, env);
  });
  const { checks, failed } = await packageRun(
    runDir,
    mediaDir,
    {
      commit,
      fixtures: FIXTURE_ENVS.includes(env),
    },
    root,
  );
  log(`media.json: ${checks} scenarios on ${env}, ${failed} failing`);
}

await runMain(import.meta.url, "{{name}}", main);
