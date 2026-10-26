import { failedStep, shortMessage } from "./failure.ts";
import {
  CONFIG,
  ENVS,
  envLabel,
  type CoverageModel,
  type Env,
  type Item,
  type ScenarioRef,
  type Surface,
} from "./data.ts";

/** p passed, f failed, s skipped, u undefined, n pending, a ambiguous. */
export type StepCode = "p" | "f" | "s" | "u" | "n" | "a";

export interface GherkinStep {
  k: string;
  t: string;
  bg?: true;
  doc?: string;
  table?: string[][];
}

/** at: the failing step's index; -1 a hook before the steps, -2 a hook after them, -3 a step this run could not place. */
export interface Failure {
  at: number;
  message: string;
  step?: string;
}

export interface ScenarioRecord {
  run: number;
  status: StepCode;
  ms: number;
  codes: string;
  stepMs: number[];
  failure?: Failure;
  steps?: GherkinStep[];
  logs?: Record<string, string>;
  shot?: string;
}

/** A need of an API operation, in words. */
export const NEED_LABEL: Record<string, string> = {
  success: "Answers a valid request",
  "auth-refusal": "Refuses a request without a token",
  "bad-token-refusal": "Refuses a bad token",
  "session-refusal": "Refuses a dashboard session token",
  "permission-refusal": "Refuses a token without the permission",
};

export interface NeedProof {
  need: string;
  label: string;
  /** The operation lists it in its coverage needs; others are refusals proved beyond them. */
  required: boolean;
  scenarios: ScenarioRef[];
  proof: Record<Env, Proof | undefined>;
}

/** Something an item reaches for, or is reached from, with the scenarios that connect them. */
export interface Related {
  item: Item;
  scenarios: ScenarioRef[];
  /** The first step a run recorded calling the API side, when any did. */
  step?: { scenario: ScenarioRef; step: number };
  /** Every connecting run that knew its steps called it outside them, in setup. */
  setupOnly: boolean;
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

export interface Version {
  service: string;
  release?: string;
  builtAt?: string;
}

export interface RunInfo {
  env: Env;
  id: string;
  startedAt: string;
  finishedAt: string;
  versions: Version[];
  scenariosCommit?: string;
  workflowRun?: string;
  /** The cadence the run was started for; absent for an ordinary run. */
  cadence?: string;
}

/** One feature file as the catalog reads it: the product's own description of what a customer can do. */
export interface FeatureEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  surface: Surface | "core";
  area: string;
  scenarios: {
    id: string;
    name: string;
    description: string;
    tags: string[];
    /** A row of a Scenario Outline: the outline's line and name as written, and the row's cells. */
    example?: { outline: number; name: string; cells: string[] };
  }[];
}

export interface ScenariosFile {
  runs: RunInfo[];
  scenarios: ScenarioDetail[];
  features: FeatureEntry[];
}

/** The last element that matches; the page targets ES2022, which has no Array.findLast. */
export function lastWhere<T>(xs: T[], ok: (x: T) => boolean): T | undefined {
  for (let i = xs.length - 1; i >= 0; i--) if (ok(xs[i]!)) return xs[i];
  return undefined;
}

/** The steps a record ran: its own when the feature changed since, else the scenario's newest. */
export function stepsOf(d: ScenarioDetail, r?: ScenarioRecord): GherkinStep[] {
  return r?.steps ?? d.steps;
}

/** Times a scenario's result flipped between passing and failing over these records. */
export function flips(recs: ScenarioRecord[]): number {
  let n = 0;
  for (let i = 1; i < recs.length; i++)
    if ((recs[i]!.status === "p") !== (recs[i - 1]!.status === "p")) n++;
  return n;
}

export interface Proof {
  at: string;
  env: Env;
  scenario: ScenarioDetail;
}

export const STEP_LABEL: Record<StepCode, string> = {
  p: "Verified",
  f: "Failed",
  s: "Skipped",
  u: "Not written yet",
  n: "Pending",
  a: "Ambiguous",
};

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

const TAG_LABEL: Record<string, string> = {
  "@fixture": "Creates a throwaway fixture",
  "@dispatch": "Runs a GitHub workflow",
  "@planned": "Planned",
  ...Object.fromEntries(
    ENVS.map((e) => [`@env:${e}`, `Runs on ${envLabel(e).toLowerCase()}`]),
  ),
  ...CONFIG.tagLabels,
};

export function tagLabel(tag: string): string {
  const area = /^@area:(.+)$/.exec(tag);
  if (area) return `Area: ${area[1]!.replaceAll("-", " ")}`;
  return TAG_LABEL[tag] ?? tag.replace(/^@/, "");
}

/** Why a scenario fails in one env at a timeline point, short enough for a summary. */
export interface FailNote {
  env: Env;
  scenario: ScenarioDetail;
  at: string;
  step: string;
  /** 1-based step to open the scenario at, when the failure was in a step. */
  stepNo?: number;
  message: string;
  shot: boolean;
  /** Other scenarios among the list failing in the same env. */
  more: number;
}

/** Every recorded scenario with its runs, from scenarios.json and shots.json, joined to the map's items. */
export function scenariosModel(
  cov: CoverageModel,
  file: ScenariosFile,
  shots: Record<string, string>,
) {
  const {
    items,
    itemScenarios,
    itemNeeds,
    itemSteps,
    scenarios: scenarioRefs,
    snapshots,
    status,
  } = cov;
  const runs = file.runs;

  if (
    file.scenarios.length !== scenarioRefs.length ||
    file.scenarios.some((s, i) => s.id !== scenarioRefs[i]!.id)
  )
    throw new Error(
      "scenarios.json and history.json disagree; run pnpm explorer",
    );

  const details = file.scenarios;
  const byId = new Map(details.map((d, i) => [d.id, i]));

  function detailOf(id: string): ScenarioDetail | undefined {
    const i = byId.get(id);
    return i === undefined ? undefined : details[i];
  }

  function refOf(id: string): ScenarioRef | undefined {
    const i = byId.get(id);
    return i === undefined ? undefined : scenarioRefs[i];
  }

  const finishedAt = (r: ScenarioRecord) => runs[r.run]!.finishedAt;

  /** The newest record in an env at a timeline point. */
  function recordAt(
    d: ScenarioDetail,
    env: Env,
    snap: number,
  ): ScenarioRecord | undefined {
    const at = snapshots[snap]!.at;
    return lastWhere(d.records[env], (r) => finishedAt(r) <= at);
  }

  function recordsUpTo(
    d: ScenarioDetail,
    env: Env,
    snap: number,
  ): ScenarioRecord[] {
    const at = snapshots[snap]!.at;
    return d.records[env].filter((r) => finishedAt(r) <= at);
  }

  /** The newest passing run in an env among these scenarios, up to a timeline point. */
  function lastPass(
    list: ScenarioDetail[],
    env: Env,
    snap: number,
  ): Proof | undefined {
    let best: Proof | undefined;
    for (const d of list) {
      const r = lastWhere(recordsUpTo(d, env, snap), (x) => x.status === "p");
      if (r && (!best || finishedAt(r) > best.at))
        best = { at: finishedAt(r), env, scenario: d };
    }
    return best;
  }

  function itemDetails(it: Item): ScenarioDetail[] {
    return itemScenarios(it).flatMap((s) => details[s.sIdx] ?? []);
  }

  /** Per env, when a scenario touching the item last passed and which one. */
  function itemProof(it: Item, snap: number): Record<Env, Proof | undefined> {
    const list = itemDetails(it);
    return Object.fromEntries(
      ENVS.map((e) => [e, lastPass(list, e, snap)]),
    ) as Record<Env, Proof | undefined>;
  }

  const itemsOf = new Map<number, Item[]>();
  for (const it of items)
    for (const s of itemScenarios(it)) {
      const list = itemsOf.get(s.sIdx) ?? [];
      list.push(it);
      itemsOf.set(s.sIdx, list);
    }

  /**
   * What an item reaches for, at scenario granularity: for a page, command or tool, the API operations the
   * scenarios touching it also touched (their setup calls included); for an API operation, the pages, commands
   * and tools whose scenarios call it. Each with the scenarios that connect them.
   */
  function relatedItems(it: Item): Related[] {
    const api = it.surface === "api";
    const out = new Map<number, Related>();
    for (const s of itemScenarios(it))
      for (const other of itemsOf.get(s.sIdx) ?? []) {
        if (other.idx === it.idx || other.planned) continue;
        if (other.kind === "Element" || other.kind === "Shared elements")
          continue;
        if ((other.surface === "api") === api) continue;
        const e = out.get(other.idx) ?? {
          item: other,
          scenarios: [],
          setupOnly: false,
        };
        e.scenarios.push(s);
        // The step is where the API side was called, whichever side this panel shows.
        const steps = itemSteps(api ? it : other, s.sIdx);
        if (steps?.length && !e.step) e.step = { scenario: s, step: steps[0]! };
        out.set(other.idx, e);
      }
    for (const e of out.values())
      e.setupOnly = !e.step && e.scenarios.some((s) => s.stepped);
    return [...out.values()].sort(
      (a, b) =>
        Number(a.setupOnly) - Number(b.setupOnly) ||
        b.scenarios.length - a.scenarios.length ||
        a.item.label.localeCompare(b.item.label),
    );
  }

  /**
   * What an API operation must prove and what else scenarios proved about it: per need, the scenarios whose touches
   * named it and the newest verification per env. A required need nothing names is a gap.
   */
  function needProofs(it: Item, snap: number): NeedProof[] {
    const needs = new Map<string, ScenarioRef[]>();
    for (const n of it.needs ?? []) needs.set(n, []);
    for (const s of itemScenarios(it))
      for (const n of itemNeeds(it, s.sIdx)) {
        const list = needs.get(n) ?? [];
        list.push(s);
        needs.set(n, list);
      }
    return [...needs].map(([need, scenarios]) => {
      const list = scenarios.flatMap((s) => details[s.sIdx] ?? []);
      return {
        need,
        label: NEED_LABEL[need] ?? need,
        required: (it.needs ?? []).includes(need),
        scenarios,
        proof: Object.fromEntries(
          ENVS.map((e) => [e, lastPass(list, e, snap)]),
        ) as Record<Env, Proof | undefined>,
      };
    });
  }

  /** Surface items any run recorded the scenario touching. */
  function scenarioItems(d: ScenarioDetail): Item[] {
    const i = byId.get(d.id);
    return i === undefined ? [] : (itemsOf.get(i) ?? []);
  }

  /** A run's own snapshot on the timeline, when it is one. */
  function snapOfRun(run: number): number {
    const id = runs[run]!.id;
    return snapshots.findIndex((s) => s.runId === id);
  }

  /** The newest failure in an env among these scenarios, up to a timeline point. */
  function failureOn(
    list: ScenarioDetail[],
    env: Env,
    snap: number,
  ): FailNote | undefined {
    const failing = list.flatMap((d) => {
      const r = recordAt(d, env, snap);
      return r?.status === "f" ? [{ d, r }] : [];
    });
    const newest = failing.sort((a, b) =>
      finishedAt(b.r).localeCompare(finishedAt(a.r)),
    )[0];
    if (!newest) return undefined;
    const { d, r } = newest;
    const f = r.failure;
    const at = f?.at ?? -3;
    const s = at >= 0 ? stepsOf(d, r)[at] : undefined;
    return {
      env,
      scenario: d,
      at: finishedAt(r),
      step: failedStep(at, s, f?.step),
      ...(s && !r.steps ? { stepNo: at + 1 } : {}),
      message: shortMessage(f?.message ?? ""),
      shot: !!r.shot && !!shots[r.shot],
      more: failing.length - 1,
    };
  }

  /** Per env the item fails in at a timeline point, the newest failing scenario that touches it. */
  function itemFailures(
    it: Item,
    snap: number,
    envs: readonly Env[] = ENVS,
  ): FailNote[] {
    if (it.planned) return [];
    const codes = status[snap]![it.idx]!;
    const list = itemDetails(it);
    return envs.flatMap((e) =>
      codes[ENVS.indexOf(e)] === 2 ? (failureOn(list, e, snap) ?? []) : [],
    );
  }

  return {
    runs,
    shots,
    details,
    detailOf,
    refOf,
    recordAt,
    recordsUpTo,
    lastPass,
    itemDetails,
    itemProof,
    scenarioItems,
    relatedItems,
    needProofs,
    snapOfRun,
    failureOn,
    itemFailures,
  };
}

export type ScenariosModel = ReturnType<typeof scenariosModel>;
