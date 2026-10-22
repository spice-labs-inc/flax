import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Envelope,
  GherkinDocument,
  Pickle,
  PickleStep,
  TestCase,
  TestStepResult,
} from "@cucumber/messages";
import {
  STATUS_CODE,
  currentRuns,
  type Env,
  type RunResult,
  type ScenarioStatus,
  type ScenariosFile,
  type StepCode,
} from "@flax/contract";
import { config } from "@flax/scenarios/config";
import { ENVS } from "@flax/scenarios/lib/types";
import { envsForTags } from "@flax/scenarios/run/tags";
import type { RunOnDisk } from "./data.ts";
import { featuresCatalog } from "./features.ts";
export type { StepCode };

const STEP_CODE: Record<string, StepCode> = {
  PASSED: "p",
  FAILED: "f",
  SKIPPED: "s",
  UNDEFINED: "u",
  PENDING: "n",
  AMBIGUOUS: "a",
};
const SCENARIO_CODE: Record<ScenarioStatus, StepCode> = STATUS_CODE;

export interface GherkinStep {
  /** Keyword as written: Given, When, Then, And, But, *. */
  k: string;
  t: string;
  /** From the feature's Background. */
  bg?: true;
  /** A doc string, or a data table as rows of cells. */
  doc?: string;
  table?: string[][];
}

/** A step failed, or a hook before (-1) or after (-2) the steps did. */
export interface Failure {
  at: number;
  message: string;
  /** The failing step as run.json names it, when the run kept no messages to place it by. */
  step?: string;
}

/** What one run recorded for one scenario. */
export interface Attempt {
  scenarioId: string;
  name: string;
  feature: string;
  tags: string[];
  description: string;
  status: StepCode;
  durationMs: number;
  steps: GherkinStep[];
  codes: string;
  stepMs: number[];
  failure?: Failure;
  /** Log lines a step attached, by step index. */
  logs: Record<number, string>;
  /** The last image a failing attempt attached, base64. */
  shot?: { mediaType: string; base64: string };
}

const millis = (d: { seconds: number; nanos: number }) =>
  d.seconds * 1000 + Math.round(d.nanos / 1e6);

// Absolute runner paths up to the workspace name are made relative; the workspace name is the config repo.s last segment.
const RUNNER_PATH = (): RegExp => {
  const name = config().repo.workspace.split("/").pop() || "[^/]+";
  return new RegExp(
    `(?:\/[\\w.@-]+)+\/${name}\/(?=src\/|${config().paths.features}\/)`,
    "g",
  );
};
const LOG_MAX = 600;

/** A failure message as a reader needs it: runner paths made repo-relative, at most 20 lines. */
export function tidyMessage(message: string): string {
  const text = message
    .replace(RUNNER_PATH(), "")
    .split("\n")
    .slice(0, 20)
    .join("\n");
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

function stepArg(step: PickleStep): Pick<GherkinStep, "doc" | "table"> {
  const doc = step.argument?.docString?.content;
  if (doc !== undefined)
    return { doc: doc.length > 400 ? `${doc.slice(0, 400)}...` : doc };
  const rows = step.argument?.dataTable?.rows;
  if (rows)
    return { table: rows.slice(0, 8).map((r) => r.cells.map((c) => c.value)) };
  return {};
}

/** Keyword and Background membership for every Gherkin step id in a document. */
function gherkinSteps(doc: GherkinDocument) {
  const steps = new Map<string, { keyword: string; background: boolean }>();
  const scenarios = new Map<string, string>();
  const visit = (
    children: NonNullable<GherkinDocument["feature"]>["children"],
  ) => {
    for (const c of children) {
      if (c.background)
        for (const s of c.background.steps)
          steps.set(s.id, { keyword: s.keyword.trim(), background: true });
      if (c.scenario) {
        scenarios.set(c.scenario.id, c.scenario.description.trim());
        for (const s of c.scenario.steps)
          steps.set(s.id, { keyword: s.keyword.trim(), background: false });
      }
      if (c.rule) visit(c.rule.children);
    }
  };
  if (doc.feature) visit(doc.feature.children);
  return { steps, scenarios };
}

interface Started {
  testCaseId: string;
  startedMs: number;
  results: Map<string, TestStepResult>;
  logs: Map<string, string[]>;
  images: { mediaType: string; base64: string }[];
  touchesSeen: boolean;
}

/** Every scenario's final attempt in one run's cucumber message stream, step by step. */
export function attemptsFrom(envelopes: Envelope[]): Attempt[] {
  const features = new Map<string, string>();
  const gherkin = new Map<string, { keyword: string; background: boolean }>();
  const descriptions = new Map<string, string>();
  const pickles = new Map<string, Pickle>();
  const testCases = new Map<string, TestCase>();
  const started = new Map<string, Started>();
  const finished: { started: Started; finishedMs: number }[] = [];

  for (const e of envelopes) {
    if (e.gherkinDocument) {
      const doc = e.gherkinDocument;
      if (doc.uri && doc.feature) features.set(doc.uri, doc.feature.name);
      const g = gherkinSteps(doc);
      for (const [k, v] of g.steps) gherkin.set(k, v);
      for (const [k, v] of g.scenarios) descriptions.set(k, v);
    }
    if (e.pickle) pickles.set(e.pickle.id, e.pickle);
    if (e.testCase) testCases.set(e.testCase.id, e.testCase);
    if (e.testCaseStarted)
      started.set(e.testCaseStarted.id, {
        testCaseId: e.testCaseStarted.testCaseId,
        startedMs: millis(e.testCaseStarted.timestamp),
        results: new Map(),
        logs: new Map(),
        images: [],
        touchesSeen: false,
      });
    if (e.testStepFinished)
      started
        .get(e.testStepFinished.testCaseStartedId)
        ?.results.set(
          e.testStepFinished.testStepId,
          e.testStepFinished.testStepResult,
        );
    const a = e.attachment;
    if (a?.testCaseStartedId) {
      const s = started.get(a.testCaseStartedId);
      if (
        s &&
        a.mediaType.startsWith("image/") &&
        a.contentEncoding === "BASE64"
      )
        s.images.push({ mediaType: a.mediaType, base64: a.body });
      else if (
        s &&
        a.testStepId &&
        a.mediaType === "text/x.cucumber.log+plain"
      ) {
        const list = s.logs.get(a.testStepId) ?? [];
        list.push(a.body);
        s.logs.set(a.testStepId, list);
      }
    }
    if (e.testCaseFinished && !e.testCaseFinished.willBeRetried) {
      const s = started.get(e.testCaseFinished.testCaseStartedId);
      if (s)
        finished.push({
          started: s,
          finishedMs: millis(e.testCaseFinished.timestamp),
        });
    }
  }

  const out: Attempt[] = [];
  for (const { started: s, finishedMs } of finished) {
    const testCase = testCases.get(s.testCaseId);
    const pickle = testCase && pickles.get(testCase.pickleId);
    if (!testCase || !pickle) continue;
    const pickleSteps = new Map(pickle.steps.map((p) => [p.id, p]));
    const steps: GherkinStep[] = [];
    const codes: StepCode[] = [];
    const stepMs: number[] = [];
    const logs: Record<number, string> = {};
    let failure: Failure | undefined;
    let status: StepCode = "p";
    for (const ts of testCase.testSteps) {
      const result = s.results.get(ts.id);
      const code = (result && STEP_CODE[result.status]) ?? "s";
      const pickleStep = ts.pickleStepId
        ? pickleSteps.get(ts.pickleStepId)
        : undefined;
      if (pickleStep) {
        const g = gherkin.get(pickleStep.astNodeIds[0] ?? "");
        steps.push({
          k: g?.keyword ?? "*",
          t: pickleStep.text,
          ...(g?.background ? { bg: true as const } : {}),
          ...stepArg(pickleStep),
        });
        codes.push(code);
        stepMs.push(result ? millis(result.duration) : 0);
        const log = s.logs.get(ts.id)?.join("\n");
        if (log)
          logs[steps.length - 1] =
            log.length > LOG_MAX ? `${log.slice(0, LOG_MAX)}...` : log;
      }
      if (code === "f" && !failure)
        failure = {
          at: pickleStep ? steps.length - 1 : steps.length ? -2 : -1,
          message: tidyMessage(result?.message ?? ""),
        };
      if (code !== "p" && code !== "s" && status === "p") status = code;
      if (code === "f") status = "f";
    }
    const lastImage = s.images.at(-1);
    out.push({
      scenarioId: `${pickle.uri}:${pickle.location?.line ?? 0}`,
      name: pickle.name,
      feature: features.get(pickle.uri) ?? pickle.uri,
      tags: pickle.tags.map((t) => t.name),
      description: descriptions.get(pickle.astNodeIds[0] ?? "") ?? "",
      status,
      durationMs: finishedMs - s.startedMs,
      steps,
      codes: codes.join(""),
      stepMs,
      ...(failure ? { failure } : {}),
      logs,
      ...(status === "f" && lastImage ? { shot: lastImage } : {}),
    });
  }
  return out;
}

export function readEnvelopes(path: string): Envelope[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Envelope);
}

export interface Version {
  service: string;
  release?: string;
  builtAt?: string;
}

/** run.json's versions as flat strings, whatever shape each service answered in. */
export function versionsOf(v: RunResult["versions"]): Version[] {
  return Object.entries(v).map(([service, raw]) => {
    const o: Record<string, unknown> =
      raw && typeof raw === "object" ? { ...raw } : { release: raw };
    const release = o["release"] ?? o["commit"] ?? o["version"];
    const builtAt = o["built_at"] ?? o["builtAt"];
    return {
      service,
      ...(typeof release === "string" ? { release } : {}),
      ...(typeof builtAt === "string" ? { builtAt } : {}),
    };
  });
}

/** One scenario's result in one run, compact: steps as one code per character. */
export interface ScenarioRecord {
  run: number;
  status: StepCode;
  ms: number;
  codes: string;
  stepMs: number[];
  failure?: Failure;
  /** The run's steps when they differ from the scenario's newest. */
  steps?: GherkinStep[];
  logs?: Record<number, string>;
  shot?: string;
}

export interface ScenarioDetail {
  id: string;
  name: string;
  feature: string;
  tags: string[];
  description: string;
  steps: GherkinStep[];
  applies: Env[];
  records: Record<Env, ScenarioRecord[]>;
}

const RECORDS_PER_ENV = 80;
const sameSteps = (a: GherkinStep[], b: GherkinStep[]) =>
  a.length === b.length &&
  a.every((s, i) => s.k === b[i]!.k && s.t === b[i]!.t);

/**
 * data/scenarios.json and the failure screenshots: every recorded scenario with its Gherkin steps and each run's
 * step results per env, newest last. A run without messages.ndjson still gives each scenario's status, duration and failing step.
 * Logs ride on the newest record per env; a screenshot only on the newest failure per env.
 */
export function scenariosFile(
  root: string,
  resultsDir: string,
  runs: RunOnDisk[],
  order: { id: string }[],
) {
  const index = new Map(order.map((s, i) => [s.id, i]));
  const details: ScenarioDetail[] = order.map((s) => ({
    id: s.id,
    name: "",
    feature: "",
    tags: [],
    description: "",
    steps: [],
    applies: [],
    records: Object.fromEntries(ENVS.map((e) => [e, []])),
  }));
  const shots: {
    key: string;
    env: Env;
    at: string;
    mediaType: string;
    base64: string;
  }[] = [];

  runs.forEach((r, runIdx) => {
    const messages = join(resultsDir, r.env, r.id, "messages.ndjson");
    const attempts = new Map(
      existsSync(messages)
        ? attemptsFrom(readEnvelopes(messages)).map((a) => [a.scenarioId, a])
        : [],
    );
    for (const s of r.run.scenarios) {
      const i = index.get(s.id);
      if (i === undefined) continue;
      const d = details[i]!;
      const a = attempts.get(s.id);
      Object.assign(d, { name: s.name, feature: s.feature, tags: s.tags });
      if (a) Object.assign(d, { description: a.description, steps: a.steps });
      const rec: ScenarioRecord & { attempt?: Attempt } = {
        run: runIdx,
        status: SCENARIO_CODE[s.status],
        ms: s.durationMs,
        codes: a?.codes ?? "",
        stepMs: a?.stepMs ?? [],
      };
      if (a?.failure) rec.failure = a.failure;
      else if (s.failure)
        rec.failure = {
          at: s.failure.at ?? -3,
          step: s.failure.step,
          message: tidyMessage(s.failure.message),
        };
      if (a) rec.attempt = a;
      d.records[r.env]!.push(rec);
    }
  });

  const runsFixtures = fixturesRun(runs);

  details.forEach((d, i) => {
    d.applies = envsForTags(d.tags, runsFixtures);
    for (const env of ENVS) {
      const recs = d.records[env]!.slice(
        -RECORDS_PER_ENV,
      ) as (ScenarioRecord & {
        attempt?: Attempt;
      })[];
      const newestShot = recs.findLastIndex((x) => x.attempt?.shot);
      recs.forEach((rec, k) => {
        if (rec.failure?.at === -3) {
          const at = d.steps.findIndex((x) => x.t === rec.failure!.step);
          if (at >= 0) rec.failure = { at, message: rec.failure.message };
        }
        const a = rec.attempt;
        delete rec.attempt;
        if (!a) return;
        if (!sameSteps(a.steps, d.steps)) rec.steps = a.steps;
        if (k === recs.length - 1 && Object.keys(a.logs).length)
          rec.logs = a.logs;
        if (k === newestShot && a.shot) {
          rec.shot = `${env}/${i}`;
          shots.push({
            key: rec.shot,
            env,
            at: runs[rec.run]!.run.finishedAt,
            ...a.shot,
          });
        }
      });
      d.records[env] = recs;
    }
  });

  return {
    file: {
      runs: runs.map((r) => ({
        env: r.env,
        id: r.id,
        startedAt: r.run.startedAt,
        finishedAt: r.run.finishedAt,
        versions: versionsOf(r.run.versions),
        ...(r.run.cadence !== undefined ? { cadence: r.run.cadence } : {}),
        ...runIndex(join(resultsDir, r.env, r.id, "index.json")),
      })),
      scenarios: details,
      features: featuresCatalog(root),
    },
    shots,
  };
}

/** Per env, its runs that speak for it now (oldest first): the newest ordinary run and the newest run of each cadence. */
export function currentByEnv(
  runs: readonly RunOnDisk[],
): Map<Env, RunOnDisk[]> {
  return new Map(
    ENVS.map((e) => [
      e,
      currentRuns(
        runs.filter((r) => r.env === e),
        (r) => r.run.cadence,
      ),
    ]),
  );
}

/** Whether an env's current runs ran fixture scenarios. */
export function fixturesRun(runs: readonly RunOnDisk[]): (env: Env) => boolean {
  const current = currentByEnv(runs);
  return (e) =>
    (current.get(e) ?? []).some((r) =>
      r.run.scenarios.some((s) => s.tags.includes("@fixture")),
    );
}

/** The scenarios commit and workflow run index.json records for a run, when it has one. */
function runIndex(path: string): {
  scenariosCommit?: string;
  workflowRun?: string;
} {
  if (!existsSync(path)) return {};
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object") return {};
  const idx = raw as {
    builds?: Record<string, unknown>;
    run?: { workflowRun?: unknown };
  };
  const commit = idx.builds?.[config().repo.workspace.split("/").pop() ?? ""];
  const url = idx.run?.workflowRun;
  return {
    ...(typeof commit === "string" ? { scenariosCommit: commit } : {}),
    ...(typeof url === "string" && url.startsWith("https://github.com/")
      ? { workflowRun: url }
      : {}),
  };
}

/** Newest screenshots first until the byte budget is spent; the rest are dropped and their records lose the key. */
export function withinBudget<
  T extends { key: string; at: string; base64: string },
>(shots: T[], budget: number): { kept: T[]; dropped: Set<string> } {
  let spent = 0;
  const kept: T[] = [];
  const dropped = new Set<string>();
  for (const s of [...shots].sort((a, b) => b.at.localeCompare(a.at))) {
    if (spent + s.base64.length <= budget) {
      kept.push(s);
      spent += s.base64.length;
    } else dropped.add(s.key);
  }
  return { kept, dropped };
}
