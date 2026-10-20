import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Envelope, TestStepResult } from "@cucumber/messages";
import {
  SCENARIO_STATUSES,
  isRecord,
  type Env,
  type PlannedScenario,
  type RunResult,
  type ScenarioResult,
  type ScenarioStatus,
} from "@flax/contract";
import { ENVS } from "@flax/scenarios/lib/types";
import { tidyMessage } from "../scripts/scenarios.ts";
import { isScenarioId, runIdEnv } from "./ids.ts";

export type LiveStatus = "running" | "retrying" | ScenarioStatus;

/** One scenario as the live stream has it so far. */
export interface LiveScenario {
  id: string;
  name: string;
  status: LiveStatus;
  attempt: number;
  /** Steps finished and steps in all, hooks included. */
  done: number;
  steps: number;
  /** One character per Gherkin step, as the explorer's data codes them (p, f, s, u, n, a), "." until it finishes. */
  codes: string;
  startedAt: string;
  durationMs?: number;
  failure?: string;
}

export interface RunMeta {
  env: Env;
  runId: string;
  startedAt: string;
  workers: number;
  scenariosCommit?: string;
  github?: { runId: string; attempt?: string; repository: string };
  planned: number;
}

export type RunState = "running" | "finished" | "incomplete";

export interface RunSummary extends RunMeta {
  state: RunState;
  /** Scenarios the run will run, from its test cases. */
  total: number;
  passed: number;
  failed: number;
  finishedCount: number;
  gap: boolean;
  lastMessageAt: string;
  finishedAt?: string;
}

/** A server-sent event: its name and what it carries. */
export interface LiveEvent {
  event:
    | "run-started"
    | "scenario-started"
    | "scenario-finished"
    | "step-finished"
    | "run-finished"
    | "run-incomplete";
  data: Record<string, unknown>;
}

/** One step of a scenario running now, for the open scenario's page. */
export interface LiveStep {
  text: string;
  status?: string;
  ms?: number;
}

export interface ScenarioDetail extends LiveScenario {
  runId: string;
  env: Env;
  stepList: LiveStep[];
  message?: string;
  shot?: string;
}

const millis = (t: { seconds: number; nanos: number }) =>
  t.seconds * 1000 + Math.round(t.nanos / 1e6);

const WORST_FIRST: ScenarioStatus[] = [
  "failed",
  "ambiguous",
  "undefined",
  "pending",
  "skipped",
  "passed",
];

const STEP_CODE: Record<ScenarioStatus, string> = {
  passed: "p",
  failed: "f",
  skipped: "s",
  undefined: "u",
  pending: "n",
  ambiguous: "a",
};

function statusOf(r: TestStepResult): ScenarioStatus {
  const s = r.status.toLowerCase();
  return WORST_FIRST.find((w) => w === s) ?? "failed";
}

interface Attempt {
  testCaseId: string;
  scenarioId: string;
  results: { stepId: string; result: TestStepResult }[];
  image?: string;
}

const SHOT_MAX = 256 * 1024;

/** A run as its pushed messages tell it, kept in memory and in `<live>/<run id>.ndjson`. */
export class LiveRun {
  meta: RunMeta;
  state: RunState = "running";
  gap = false;
  lastMessageAt: number;
  finishedAt: number | undefined;
  readonly #file: string;
  readonly #seen = new Set<number>();
  readonly #features = new Map<string, string>();
  readonly #pickles = new Map<
    string,
    { id: string; name: string; steps: Map<string, string> }
  >();
  readonly #testCases = new Map<
    string,
    { pickleId: string; steps: { id: string; pickleStepId?: string }[] }
  >();
  readonly #attempts = new Map<string, Attempt>();
  readonly scenarios = new Map<string, LiveScenario>();
  readonly #latestAttempt = new Map<string, string>();

  constructor(dir: string, meta: RunMeta, now: number) {
    this.meta = meta;
    this.#file = join(dir, `${meta.runId}.ndjson`);
    this.lastMessageAt = now;
  }

  get total(): number {
    return this.#testCases.size;
  }

  summary(): RunSummary {
    let passed = 0;
    let failed = 0;
    let finishedCount = 0;
    for (const s of this.scenarios.values()) {
      if (s.status === "running" || s.status === "retrying") continue;
      finishedCount++;
      if (s.status === "passed") passed++;
      else if (s.status !== "skipped") failed++;
    }
    return {
      ...this.meta,
      state: this.state,
      total: this.total,
      passed,
      failed,
      finishedCount,
      gap: this.gap,
      lastMessageAt: new Date(this.lastMessageAt).toISOString(),
      ...(this.finishedAt
        ? { finishedAt: new Date(this.finishedAt).toISOString() }
        : {}),
    };
  }

  /** Takes a batch whose first envelope has this sequence number; envelopes already seen are skipped. */
  ingest(
    first: number,
    envelopes: Envelope[],
    now: number,
    persist = true,
  ): LiveEvent[] {
    const events: LiveEvent[] = [];
    const fresh: string[] = [];
    envelopes.forEach((e, i) => {
      const seq = first + i;
      if (this.#seen.has(seq)) return;
      this.#seen.add(seq);
      if (persist) fresh.push(JSON.stringify({ s: seq, e }));
      try {
        this.#apply(e, events);
      } catch {
        // An envelope not in the shape cucumber writes only misses the live view; the artifact still has the run.
      }
    });
    if (fresh.length > 0) {
      if (persist) appendFileSync(this.#file, `${fresh.join("\n")}\n`);
      this.lastMessageAt = now;
    }
    return events;
  }

  /** Every envelope received, in sequence order. */
  envelopes(): Envelope[] {
    if (!existsSync(this.#file)) return [];
    return readEnvelopeLines(this.#file)
      .sort((a, b) => a.s - b.s)
      .map((l) => l.e);
  }

  detail(scenarioId: string): ScenarioDetail | undefined {
    const s = this.scenarios.get(scenarioId);
    const attemptId = this.#latestAttempt.get(scenarioId);
    const a = attemptId ? this.#attempts.get(attemptId) : undefined;
    const tc = a ? this.#testCases.get(a.testCaseId) : undefined;
    const pickle = tc ? this.#pickles.get(tc.pickleId) : undefined;
    if (!s || !a || !tc || !pickle) return undefined;
    const results = new Map(a.results.map((r) => [r.stepId, r.result]));
    const stepList: LiveStep[] = [];
    let message: string | undefined;
    for (const ts of tc.steps) {
      const r = results.get(ts.id);
      if (r?.status === "FAILED" && message === undefined)
        message = tidyMessage(r.message ?? "");
      if (!ts.pickleStepId) continue;
      stepList.push({
        text: pickle.steps.get(ts.pickleStepId) ?? "",
        ...(r
          ? { status: r.status.toLowerCase(), ms: millis(r.duration) }
          : {}),
      });
    }
    return {
      ...s,
      runId: this.meta.runId,
      env: this.meta.env,
      stepList,
      ...(message !== undefined ? { message } : {}),
      ...(a.image ? { shot: a.image } : {}),
    };
  }

  #apply(e: Envelope, events: LiveEvent[]): void {
    const base = { env: this.meta.env, runId: this.meta.runId };
    if (e.gherkinDocument?.uri && e.gherkinDocument.feature)
      this.#features.set(e.gherkinDocument.uri, e.gherkinDocument.feature.name);
    if (e.pickle)
      this.#pickles.set(e.pickle.id, {
        id: `${e.pickle.uri}:${e.pickle.location?.line ?? 0}`,
        name: e.pickle.name,
        steps: new Map(e.pickle.steps.map((s) => [s.id, s.text])),
      });
    if (e.testCase)
      this.#testCases.set(e.testCase.id, {
        pickleId: e.testCase.pickleId,
        steps: e.testCase.testSteps.map((s) => ({
          id: s.id,
          ...(s.pickleStepId ? { pickleStepId: s.pickleStepId } : {}),
        })),
      });
    if (e.testCaseStarted) {
      const tc = this.#testCases.get(e.testCaseStarted.testCaseId);
      const pickle = tc ? this.#pickles.get(tc.pickleId) : undefined;
      if (!tc || !pickle) return;
      this.#attempts.set(e.testCaseStarted.id, {
        testCaseId: e.testCaseStarted.testCaseId,
        scenarioId: pickle.id,
        results: [],
      });
      this.#latestAttempt.set(pickle.id, e.testCaseStarted.id);
      const s: LiveScenario = {
        id: pickle.id,
        name: pickle.name,
        status: "running",
        attempt: e.testCaseStarted.attempt,
        done: 0,
        steps: tc.steps.length,
        codes: ".".repeat(tc.steps.filter((x) => x.pickleStepId).length),
        startedAt: new Date(millis(e.testCaseStarted.timestamp)).toISOString(),
      };
      this.scenarios.set(pickle.id, s);
      events.push({
        event: "scenario-started",
        data: { ...base, total: this.#testCases.size, scenario: s },
      });
    }
    if (e.testStepFinished) {
      const a = this.#attempts.get(e.testStepFinished.testCaseStartedId);
      const s = a && this.scenarios.get(a.scenarioId);
      const tc = a && this.#testCases.get(a.testCaseId);
      if (
        !a ||
        !s ||
        !tc ||
        this.#latestAttempt.get(a.scenarioId) !==
          e.testStepFinished.testCaseStartedId
      )
        return;
      a.results.push({
        stepId: e.testStepFinished.testStepId,
        result: e.testStepFinished.testStepResult,
      });
      s.done = a.results.length;
      const status = statusOf(e.testStepFinished.testStepResult);
      if (status === "failed" && s.failure === undefined)
        s.failure = firstLine(e.testStepFinished.testStepResult.message ?? "");
      const index = tc.steps
        .filter((x) => x.pickleStepId)
        .findIndex((x) => x.id === e.testStepFinished!.testStepId);
      const code = STEP_CODE[status];
      if (index >= 0 && index < s.codes.length)
        s.codes = s.codes.slice(0, index) + code + s.codes.slice(index + 1);
      events.push({
        event: "step-finished",
        data: {
          ...base,
          scenarioId: s.id,
          index,
          status,
          code,
          ms: millis(e.testStepFinished.testStepResult.duration),
          done: s.done,
          steps: s.steps,
        },
      });
    }
    const att = e.attachment;
    if (
      att?.testCaseStartedId &&
      att.mediaType.startsWith("image/") &&
      att.contentEncoding === "BASE64" &&
      att.body.length <= SHOT_MAX
    ) {
      const a = this.#attempts.get(att.testCaseStartedId);
      if (a) a.image = `data:${att.mediaType};base64,${att.body}`;
    }
    if (e.testCaseFinished) {
      const a = this.#attempts.get(e.testCaseFinished.testCaseStartedId);
      const s = a && this.scenarios.get(a.scenarioId);
      if (
        !a ||
        !s ||
        this.#latestAttempt.get(a.scenarioId) !==
          e.testCaseFinished.testCaseStartedId
      )
        return;
      let status: ScenarioStatus = "passed";
      for (const r of a.results) {
        const st = statusOf(r.result);
        if (WORST_FIRST.indexOf(st) < WORST_FIRST.indexOf(status)) status = st;
      }
      s.status = e.testCaseFinished.willBeRetried ? "retrying" : status;
      s.durationMs =
        millis(e.testCaseFinished.timestamp) - Date.parse(s.startedAt);
      if (status !== "failed") delete a.image;
      if (e.testCaseFinished.willBeRetried) delete s.failure;
      events.push({
        event: "scenario-finished",
        data: { ...base, scenario: { ...s } },
      });
    }
  }

  remove(): void {
    rmSync(this.#file, { force: true });
    rmSync(metaPath(join(this.#file, ".."), this.meta.runId), { force: true });
  }
}

function firstLine(message: string): string {
  const line =
    tidyMessage(message)
      .split("\n")
      .find((l) => l.trim()) ?? "";
  return line.length > 300 ? `${line.slice(0, 300)}...` : line;
}

function readEnvelopeLines(file: string): { s: number; e: Envelope }[] {
  const out: { s: number; e: Envelope }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isRecord(v) && typeof v["s"] === "number" && isRecord(v["e"]))
        out.push({ s: v["s"], e: v["e"] as Envelope });
    } catch {
      // A line cut short by a crash mid-write; the rest of the file still counts.
    }
  }
  return out;
}

const metaPath = (dir: string, runId: string) => join(dir, `${runId}.json`);

export class InvalidStart extends Error {}

/** A start call's body, checked against the run id in its path. */
export function parseStart(runId: string, body: unknown): RunMeta {
  const env = runIdEnv(runId);
  if (!env) throw new InvalidStart("not a run id");
  if (!isRecord(body)) throw new InvalidStart("the body is not an object");
  if (body["runId"] !== runId || body["env"] !== env)
    throw new InvalidStart("the body names another run");
  const startedAt = body["startedAt"];
  const workers = body["workers"];
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt)))
    throw new InvalidStart("startedAt is not a time");
  if (
    typeof workers !== "number" ||
    !Number.isInteger(workers) ||
    workers < 1 ||
    workers > 64
  )
    throw new InvalidStart("workers is not a count");
  const commit = body["scenariosCommit"];
  const gh = body["github"];
  const planned = body["planned"];
  const github =
    isRecord(gh) &&
    typeof gh["runId"] === "string" &&
    /^\d{1,20}$/.test(gh["runId"]) &&
    typeof gh["repository"] === "string" &&
    /^[\w.-]+\/[\w.-]+$/.test(gh["repository"])
      ? {
          runId: gh["runId"],
          repository: gh["repository"],
          ...(typeof gh["attempt"] === "string" &&
          /^\d{1,4}$/.test(gh["attempt"])
            ? { attempt: gh["attempt"] }
            : {}),
        }
      : undefined;
  return {
    env,
    runId,
    startedAt,
    workers,
    ...(typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit)
      ? { scenariosCommit: commit }
      : {}),
    ...(github ? { github } : {}),
    planned: Array.isArray(planned)
      ? planned.length
      : typeof planned === "number" && Number.isInteger(planned) && planned >= 0
        ? planned
        : 0,
  };
}

/** A finish call's body: the run's run.json and planned.json, checked against the run id. */
export function parseFinish(
  runId: string,
  body: unknown,
): { run: RunResult; planned: PlannedScenario[]; incomplete: boolean } {
  if (!isRecord(body) || !isRecord(body["run"]))
    throw new InvalidStart("the body has no run");
  const run = body["run"];
  const env = runIdEnv(runId);
  if (run["runId"] !== runId || !env || run["env"] !== env)
    throw new InvalidStart("the run is another run");
  if (
    !Array.isArray(run["scenarios"]) ||
    typeof run["finishedAt"] !== "string" ||
    typeof run["startedAt"] !== "string"
  )
    throw new InvalidStart("the run has no scenarios");
  const scenarios = run["scenarios"].filter(isScenarioResult);
  if (scenarios.length !== run["scenarios"].length)
    throw new InvalidStart("the run has scenarios not in run.json's shape");
  const planned = Array.isArray(body["planned"])
    ? body["planned"].filter(isPlanned)
    : [];
  const versions = isRecord(run["versions"]) ? run["versions"] : {};
  const parallel = run["parallel"];
  const dropped = body["dropped"];
  const unsent = body["unsent"];
  return {
    run: {
      env,
      runId,
      startedAt: run["startedAt"],
      finishedAt: run["finishedAt"],
      versions,
      ...(typeof parallel === "number" ? { parallel } : {}),
      scenarios,
    },
    planned,
    incomplete:
      (typeof dropped === "number" && dropped > 0) ||
      (typeof unsent === "number" && unsent > 0),
  };
}

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function isScenarioResult(v: unknown): v is ScenarioResult {
  if (!isRecord(v)) return false;
  const failure = v["failure"];
  return (
    typeof v["id"] === "string" &&
    isScenarioId(v["id"]) &&
    typeof v["name"] === "string" &&
    typeof v["feature"] === "string" &&
    isStrings(v["tags"]) &&
    SCENARIO_STATUSES.some((s) => s === v["status"]) &&
    typeof v["durationMs"] === "number" &&
    Array.isArray(v["touches"]) &&
    v["touches"].every(
      (t) =>
        isRecord(t) &&
        typeof t["item"] === "string" &&
        (t["need"] === undefined || typeof t["need"] === "string"),
    ) &&
    (failure === undefined ||
      (isRecord(failure) &&
        typeof failure["step"] === "string" &&
        typeof failure["message"] === "string"))
  );
}

function isPlanned(v: unknown): v is PlannedScenario {
  return (
    isRecord(v) &&
    typeof v["id"] === "string" &&
    isScenarioId(v["id"]) &&
    typeof v["name"] === "string" &&
    typeof v["feature"] === "string" &&
    isStrings(v["tags"])
  );
}

export const RECENT_PER_ENV = 5;
export const QUIET_MS = 15 * 60_000;

/** Every live run: per env the current one and the last few, restored from `<live>/` at start. */
export class LiveRuns {
  readonly #dir: string;
  readonly runs = new Map<string, LiveRun>();

  constructor(dir: string, now: number) {
    this.#dir = dir;
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const m = /^(.+)\.json$/.exec(name);
      if (!m?.[1] || !runIdEnv(m[1])) continue;
      try {
        const saved: unknown = JSON.parse(
          readFileSync(join(dir, name), "utf8"),
        );
        if (!isRecord(saved)) continue;
        const run = new LiveRun(dir, parseStart(m[1], saved["start"]), now);
        const ndjson = join(dir, `${m[1]}.ndjson`);
        if (existsSync(ndjson))
          for (const l of readEnvelopeLines(ndjson).sort((a, b) => a.s - b.s))
            run.ingest(l.s, [l.e], now, false);
        if (saved["state"] === "finished" || saved["state"] === "incomplete")
          run.state = saved["state"];
        if (typeof saved["finishedAt"] === "string")
          run.finishedAt = Date.parse(saved["finishedAt"]);
        run.gap = saved["gap"] === true;
        if (typeof saved["lastMessageAt"] === "string")
          run.lastMessageAt = Date.parse(saved["lastMessageAt"]);
        this.runs.set(run.meta.runId, run);
      } catch {
        // A run whose saved state cannot be read is left to its artifact.
      }
    }
    this.#prune();
  }

  get(runId: string): LiveRun | undefined {
    return this.runs.get(runId);
  }

  /** The run, started now when it was not yet known (a start call, or messages whose start was lost). */
  open(meta: RunMeta, now: number): { run: LiveRun; created: boolean } {
    const known = this.runs.get(meta.runId);
    if (known) return { run: known, created: false };
    const run = new LiveRun(this.#dir, meta, now);
    this.runs.set(meta.runId, run);
    this.save(run);
    this.#prune();
    return { run, created: true };
  }

  save(run: LiveRun): void {
    writeFileSync(
      metaPath(this.#dir, run.meta.runId),
      JSON.stringify({
        start: run.meta,
        state: run.state,
        gap: run.gap,
        lastMessageAt: new Date(run.lastMessageAt).toISOString(),
        ...(run.finishedAt
          ? { finishedAt: new Date(run.finishedAt).toISOString() }
          : {}),
      }),
    );
  }

  /** Running runs that went quiet, now marked incomplete. */
  sweep(now: number): LiveRun[] {
    const quiet: LiveRun[] = [];
    for (const run of this.runs.values())
      if (run.state === "running" && now - run.lastMessageAt > QUIET_MS) {
        run.state = "incomplete";
        this.save(run);
        quiet.push(run);
      }
    return quiet;
  }

  /** Per env, newest first: the runs the snapshot carries. */
  byEnv(): Record<Env, RunSummary[]> {
    const out = Object.fromEntries(ENVS.map((e) => [e, []])) as Record<
      Env,
      RunSummary[]
    >;
    for (const env of ENVS)
      out[env] = [...this.runs.values()]
        .filter((r) => r.meta.env === env)
        .sort((a, b) => b.meta.runId.localeCompare(a.meta.runId))
        .map((r) => r.summary());
    return out;
  }

  #prune(): void {
    for (const env of ENVS) {
      const own = [...this.runs.values()]
        .filter((r) => r.meta.env === env)
        .sort((a, b) => b.meta.runId.localeCompare(a.meta.runId));
      for (const r of own.slice(RECENT_PER_ENV)) {
        r.remove();
        this.runs.delete(r.meta.runId);
      }
    }
  }
}
