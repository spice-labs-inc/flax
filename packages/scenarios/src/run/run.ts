// @cucumber/cucumber first: it requires @cucumber/gherkin itself, and node refuses that require when this module imported gherkin before it.
import { loadConfiguration, runCucumber } from "@cucumber/cucumber/api";
import { existsSync, statSync } from "node:fs";
import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Envelope } from "@cucumber/messages";
import { makeRunId } from "@flax/contract";
import { config, envConfig, envVariables } from "../config.ts";
import { fetchText } from "../lib/http.ts";
import { ENVS } from "../lib/types.ts";
import { fixtureEnvNames } from "./env.ts";
import { githubRun, livePushFromEnv, scenariosCommit } from "./live.ts";
import { scenarioResults } from "./messages.ts";
import { plannedScenarios } from "./planned.ts";
import { tagExpression } from "./tags.ts";
import type { RunResult } from "./results.ts";

/** The loader that runs TypeScript step files on a plain Node: see strip-types-loader.mjs. */
const STRIP_LOADER = new URL("./strip-types-loader.mjs", import.meta.url).href;

/** `flax scenarios run --env <env> ...`: the cucumber run loop, writing results/<env>/<run id>/. */
export async function runScenarios(argv: string[]): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const kit = config();
  const variables = envVariables(kit);

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      env: { type: "string" },
      tags: { type: "string" },
      out: { type: "string", default: kit.paths.results },
      "dry-run": { type: "boolean", default: false },
      fixtures: { type: "boolean", default: false },
      dispatch: { type: "boolean", default: false },
      parallel: { type: "string", default: "1" },
    },
  });

  const env = ENVS.find((e) => e === values.env);
  if (!env) {
    console.error(
      `usage: flax scenarios run --env <${ENVS.join("|")}> [--tags <expression>] [--out <dir>] [--dry-run] [--fixtures] [--dispatch] [--parallel <n>] [feature paths...]`,
    );
    return 2;
  }

  const parallel = Number(values.parallel);
  if (!Number.isInteger(parallel) || parallel < 1) {
    console.error("--parallel takes a whole number of workers, 1 or more");
    return 2;
  }

  const fixtures = values.fixtures ?? false;
  const fixtureEnvs = fixtureEnvNames();
  if (fixtures && !fixtureEnvs.includes(env)) {
    console.error(`--fixtures runs only on ${fixtureEnvs.join(", ")}`);
    return 2;
  }

  const startedAt = new Date();
  const runId = makeRunId(env, startedAt);
  process.env[variables.env] = env;
  process.env[variables.runId] = runId;
  if (fixtures) process.env[variables.fixtures] = "1";

  const versions: Record<string, unknown> = {};
  const probe = kit.versionProbe;
  if (probe) {
    const host = envConfig(env, kit).hosts[probe.host];
    if (host)
      try {
        const res = await fetchText(`${host}${probe.path}`);
        versions[probe.host] =
          res.status === 200 ? JSON.parse(res.body) : res.status;
      } catch (e) {
        versions[probe.host] = (e as Error).message;
      }
  }

  const paths = (
    positionals.length > 0 ? positionals : [kit.cucumber.features]
  ).map((p) =>
    existsSync(p) && statSync(p).isDirectory()
      ? `${p.replace(/\/+$/, "")}/**/*.feature`
      : p,
  );
  const { runConfiguration } = await loadConfiguration({
    provided: {
      paths,
      import: kit.cucumber.imports,
      loader: [
        ...(kit.cucumber.stripTypes ? [STRIP_LOADER] : []),
        ...kit.cucumber.loaders,
      ],
      tags: tagExpression(env, values.tags, fixtures, values.dispatch ?? false),
      format: ["progress"],
      strict: true,
      dryRun: values["dry-run"] ?? false,
      parallel: parallel > 1 ? parallel : 0,
    },
  });
  const featureFiles: string[] = [];
  for (const p of paths) for await (const f of glob(p)) featureFiles.push(f);
  const planned = await plannedScenarios(
    await Promise.all(
      featureFiles.map(async (f) => ({
        uri: f,
        text: await readFile(f, "utf8"),
      })),
    ),
  );

  const live = values["dry-run"]
    ? undefined
    : livePushFromEnv(process.env, runId);
  if (live) {
    const commit = scenariosCommit();
    const github = githubRun(process.env);
    live.start({
      env,
      runId,
      startedAt: startedAt.toISOString(),
      workers: parallel,
      ...(commit ? { scenariosCommit: commit } : {}),
      ...(github ? { github } : {}),
      planned,
    });
  }

  const envelopes: Envelope[] = [];
  const { success } = await runCucumber(runConfiguration, undefined, (m) => {
    envelopes.push(m);
    live?.message(m);
  });

  if (values["dry-run"]) {
    const missing = envelopes.filter((m) =>
      ["UNDEFINED", "AMBIGUOUS"].includes(
        m.testStepFinished?.testStepResult.status ?? "",
      ),
    ).length;
    const defined = success && missing === 0;
    console.error(
      `${env}: dry run, ${defined ? "every step is defined" : `${missing} undefined or ambiguous steps above`}; ${planned.length} planned; nothing written`,
    );
    return defined ? 0 : 1;
  }

  const run: RunResult = {
    env,
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    versions,
    ...(parallel > 1 ? { parallel } : {}),
    scenarios: scenarioResults(envelopes),
  };
  const dir = join(values.out ?? kit.paths.results, env, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  await writeFile(
    join(dir, "planned.json"),
    `${JSON.stringify(planned, null, 2)}\n`,
  );
  await writeFile(
    join(dir, "messages.ndjson"),
    envelopes.map((m) => JSON.stringify(m)).join("\n") + "\n",
  );
  const count = (s: string) =>
    run.scenarios.filter((r) => r.status === s).length;
  console.error(
    `${env}: ${run.scenarios.length} scenarios, ${count("passed")} passed, ${count("failed")} failed, ${planned.length} planned, ${Math.round((Date.parse(run.finishedAt) - startedAt.getTime()) / 60_000)} min${parallel > 1 ? ` with ${parallel} workers` : ""}; ${dir}`,
  );
  await live?.finish(run, planned);
  return success ? 0 : 1;
}
