import { invalidate } from "$app/navigation";
import { byEnv, ENV_ORDER, ENVS, type Env, type EnvChoice } from "./data.ts";

/** One scenario of a run in progress, as the explorer service streams it. */
export interface LiveScenario {
  id: string;
  name: string;
  status:
    | "running"
    | "retrying"
    | "passed"
    | "failed"
    | "skipped"
    | "undefined"
    | "pending"
    | "ambiguous";
  attempt: number;
  done: number;
  steps: number;
  /** One character per Gherkin step (p, f, s, u, n, a), "." until it finishes. */
  codes: string;
  startedAt: string;
  durationMs?: number;
  failure?: string;
}

export interface LiveRun {
  env: Env;
  runId: string;
  startedAt: string;
  workers: number;
  github?: { runId: string; attempt?: string; repository: string };
  state: "running" | "finished" | "incomplete";
  total: number;
  gap: boolean;
  lastMessageAt: string;
  finishedAt?: string;
}

/** A scheduled run GitHub says is running that pushed nothing here. */
export interface RunningWorkflow {
  id: number;
  url: string;
  env?: Env;
  event: string;
  startedAt: string;
}

/** A scenario's place in the live run of one env. */
export interface ScenarioRun {
  env: Env;
  run: LiveRun;
  scenario: LiveScenario;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isEnv = (v: unknown): v is Env => ENVS.some((e) => e === v);

function liveRun(v: unknown): LiveRun | undefined {
  if (
    !isObject(v) ||
    !isEnv(v["env"]) ||
    typeof v["runId"] !== "string" ||
    typeof v["startedAt"] !== "string" ||
    (v["state"] !== "running" &&
      v["state"] !== "finished" &&
      v["state"] !== "incomplete")
  )
    return undefined;
  const gh = v["github"];
  return {
    env: v["env"],
    runId: v["runId"],
    startedAt: v["startedAt"],
    workers: typeof v["workers"] === "number" ? v["workers"] : 1,
    state: v["state"],
    total: typeof v["total"] === "number" ? v["total"] : 0,
    gap: v["gap"] === true,
    lastMessageAt:
      typeof v["lastMessageAt"] === "string"
        ? v["lastMessageAt"]
        : v["startedAt"],
    ...(typeof v["finishedAt"] === "string"
      ? { finishedAt: v["finishedAt"] }
      : {}),
    ...(isObject(gh) &&
    typeof gh["runId"] === "string" &&
    typeof gh["repository"] === "string"
      ? { github: { runId: gh["runId"], repository: gh["repository"] } }
      : {}),
  };
}

const STATUSES: LiveScenario["status"][] = [
  "running",
  "retrying",
  "passed",
  "failed",
  "skipped",
  "undefined",
  "pending",
  "ambiguous",
];

function liveScenario(v: unknown): LiveScenario | undefined {
  if (
    !isObject(v) ||
    typeof v["id"] !== "string" ||
    typeof v["name"] !== "string" ||
    typeof v["startedAt"] !== "string"
  )
    return undefined;
  const status = STATUSES.find((s) => s === v["status"]);
  if (!status) return undefined;
  const num = (k: string) => (typeof v[k] === "number" ? v[k] : 0);
  return {
    id: v["id"],
    name: v["name"],
    status,
    attempt: num("attempt"),
    done: num("done"),
    steps: num("steps"),
    codes: typeof v["codes"] === "string" ? v["codes"] : "",
    startedAt: v["startedAt"],
    ...(typeof v["durationMs"] === "number"
      ? { durationMs: v["durationMs"] }
      : {}),
    ...(typeof v["failure"] === "string" ? { failure: v["failure"] } : {}),
  };
}

function runningWorkflows(v: unknown): RunningWorkflow[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((w): RunningWorkflow[] =>
    isObject(w) &&
    typeof w["id"] === "number" &&
    typeof w["url"] === "string" &&
    w["url"].startsWith("https://github.com/") &&
    typeof w["event"] === "string" &&
    typeof w["startedAt"] === "string"
      ? [
          {
            id: w["id"],
            url: w["url"],
            event: w["event"],
            startedAt: w["startedAt"],
            ...(isEnv(w["env"]) ? { env: w["env"] } : {}),
          },
        ]
      : [],
  );
}

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/**
 * The page's one connection to the explorer service's event stream: scheduled runs as they go. It is live
 * state, not loader data; the loader's data moves to a new run only when the service says a new version is built.
 */
class Live {
  /** Whether the stream is open; false before the first connection and while reconnecting. */
  connected = $state(false);
  /** Whether a connection was ever made, so a page without the service never claims to be reconnecting. */
  started = $state(false);
  /** Whether a connection failed, so a page whose service is away says live updates are paused. */
  errored = $state(false);
  /** Newest first, per env. */
  runs = $state<Record<Env, LiveRun[]>>(byEnv(() => []));
  /** Per run id, its scenarios by id. */
  scenarios = $state<Record<string, Record<string, LiveScenario>>>({});
  running = $state.raw<RunningWorkflow[]>([]);
  /** The page's clock for "3 minutes ago" and the map's pulses; it ticks every 15 seconds while the stream is open. */
  clock = $state(Date.now());
  #tick: ReturnType<typeof setInterval> | undefined;
  #source: EventSource | undefined;
  #retryMs = RETRY_MIN_MS;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #loaded: () => string | null = () => null;
  #asked: string | undefined;

  /** Opens the stream; `loaded` names the data version the page shows, so a newer one reloads the data. */
  start(loaded: () => string | null): void {
    this.#loaded = loaded;
    if (this.#source || typeof EventSource === "undefined") return;
    this.#tick ??= setInterval(() => (this.clock = Date.now()), 15_000);
    this.#connect();
  }

  stop(): void {
    clearTimeout(this.#timer);
    clearInterval(this.#tick);
    this.#tick = undefined;
    this.#source?.close();
    this.#source = undefined;
    this.connected = false;
  }

  /** The current run per env, when it is still running or has not reached the data yet. */
  current(env: Env): LiveRun | undefined {
    return this.runs[env][0];
  }

  /** Scenarios running now in the envs on show. */
  runningScenarios(env: EnvChoice): LiveScenario[] {
    const envs = env === "all" ? ENVS : [env];
    return envs.flatMap((e) => {
      const run = this.current(e);
      if (!run || run.state !== "running") return [];
      return Object.values(this.scenarios[run.runId] ?? {}).filter(
        (s) => s.status === "running" || s.status === "retrying",
      );
    });
  }

  /** Where one scenario stands in each env's current run. */
  scenarioRuns(id: string): ScenarioRun[] {
    return ENV_ORDER.flatMap((env) => {
      const run = this.current(env);
      const scenario = run ? this.scenarios[run.runId]?.[id] : undefined;
      return run && scenario ? [{ env, run, scenario }] : [];
    });
  }

  /** Counts of a run's scenarios so far. */
  counts(runId: string): { finished: number; passed: number; failed: number } {
    let finished = 0;
    let passed = 0;
    let failed = 0;
    for (const s of Object.values(this.scenarios[runId] ?? {})) {
      if (s.status === "running" || s.status === "retrying") continue;
      finished++;
      if (s.status === "passed") passed++;
      else if (s.status !== "skipped") failed++;
    }
    return { finished, passed, failed };
  }

  #connect(): void {
    const es = new EventSource("/live/events");
    this.#source = es;
    es.onopen = () => {
      this.connected = true;
      this.started = true;
      this.#retryMs = RETRY_MIN_MS;
    };
    es.onerror = () => {
      this.connected = false;
      this.errored = true;
      // The browser retries a dropped stream itself, but gives up on an answer that is not a stream (a 502 from Caddy).
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        this.#source = undefined;
        this.#timer = setTimeout(() => this.#connect(), this.#retryMs);
        this.#retryMs = Math.min(RETRY_MAX_MS, this.#retryMs * 2);
      }
    };
    const on = (name: string, fn: (data: unknown) => void) =>
      es.addEventListener(name, (e) => {
        try {
          fn(JSON.parse((e as MessageEvent<string>).data));
        } catch {
          // One unreadable event is skipped; the next snapshot sets everything right.
        }
      });
    on("snapshot", (d) => this.#snapshot(d));
    on("run-started", (d) => this.#upsert(liveRun(d)));
    on("run-finished", (d) => this.#upsert(liveRun(d)));
    on("run-incomplete", (d) => {
      if (!isObject(d) || !isEnv(d["env"])) return;
      const run = this.runs[d["env"]].find((r) => r.runId === d["runId"]);
      if (!run) return;
      if (d["reason"] === "gap") run.gap = true;
      else run.state = "incomplete";
    });
    on("scenario-started", (d) => this.#scenario(d));
    on("scenario-finished", (d) => this.#scenario(d));
    on("step-finished", (d) => {
      if (!isObject(d) || typeof d["runId"] !== "string") return;
      const s =
        typeof d["scenarioId"] === "string"
          ? this.scenarios[d["runId"]]?.[d["scenarioId"]]
          : undefined;
      if (!s) return;
      if (typeof d["done"] === "number") s.done = d["done"];
      const i = d["index"];
      const code = d["code"];
      if (
        typeof i === "number" &&
        i >= 0 &&
        i < s.codes.length &&
        typeof code === "string" &&
        code.length === 1
      )
        s.codes = s.codes.slice(0, i) + code + s.codes.slice(i + 1);
    });
    on("running", (d) => (this.running = runningWorkflows(d)));
    on("data", (d) => this.#data(d));
  }

  #snapshot(d: unknown): void {
    if (!isObject(d)) return;
    const runs: Record<Env, LiveRun[]> = byEnv(() => []);
    const runsByEnv = d["runs"];
    if (isObject(runsByEnv))
      for (const env of ENVS) {
        const list = runsByEnv[env];
        if (Array.isArray(list))
          runs[env] = list.flatMap((r) => liveRun(r) ?? []);
      }
    this.runs = runs;
    const scen: Record<string, Record<string, LiveScenario>> = {};
    const raw = d["scenarios"];
    if (isObject(raw))
      for (const [runId, list] of Object.entries(raw))
        if (Array.isArray(list))
          scen[runId] = Object.fromEntries(
            list.flatMap((s) => {
              const v = liveScenario(s);
              return v ? [[v.id, v]] : [];
            }),
          );
    this.scenarios = scen;
    this.running = runningWorkflows(d["running"]);
    this.#data(d["data"]);
  }

  #upsert(run: LiveRun | undefined): void {
    if (!run) return;
    const list = this.runs[run.env].filter((r) => r.runId !== run.runId);
    this.runs[run.env] = [run, ...list].sort((a, b) =>
      b.runId.localeCompare(a.runId),
    );
    this.scenarios[run.runId] ??= {};
  }

  #scenario(d: unknown): void {
    if (!isObject(d) || typeof d["runId"] !== "string") return;
    const s = liveScenario(d["scenario"]);
    if (!s) return;
    const total = d["total"];
    const run = isEnv(d["env"])
      ? this.runs[d["env"]].find((r) => r.runId === d["runId"])
      : undefined;
    if (run && typeof total === "number" && total > run.total)
      run.total = total;
    (this.scenarios[d["runId"]] ??= {})[s.id] = s;
  }

  #data(d: unknown): void {
    if (!isObject(d) || typeof d["version"] !== "string") return;
    const version = d["version"];
    if (version === this.#loaded() || version === this.#asked) return;
    this.#asked = version;
    void invalidate("explorer:data");
  }
}

export const live = new Live();
