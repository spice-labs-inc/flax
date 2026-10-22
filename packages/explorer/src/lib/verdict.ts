import {
  CODE_LABEL,
  ENVS,
  ENV_LABEL,
  formatPacific,
  type CellNote,
  type Code,
  type CoverageModel,
  type Env,
  type Item,
  byEnv,
  N_ENVS,
} from "./data.ts";
import {
  lastWhere,
  type RunInfo,
  type ScenarioDetail,
  type ScenariosModel,
} from "./scenarios.ts";

export type VerdictState =
  "verified" | "failing" | "unchecked" | "none" | "planned" | "never";

const STATE_OF: Record<Code, VerdictState> = {
  [-2]: "unchecked",
  [-1]: "never",
  0: "none",
  1: "planned",
  2: "failing",
  3: "verified",
};

/** A scenario whose steps before its failing one verified the item, and the 1-based step that failed. */
export interface LaterFailure {
  scenario: ScenarioDetail;
  step?: number;
}

/** One item in one env at a timeline point: its state, why, what it rests on, and since when. */
export interface Verdict {
  state: VerdictState;
  label: string;
  /** Verified only by steps before these scenarios failed at a later step. */
  laterFailed: LaterFailure[];
  /** Why it is not checked here, as a sentence. */
  reason?: string;
  /** When the result it rests on was recorded: its proof or its failure, else the env's newest run. */
  asOf?: string;
  /** Its proof is older than twice the env's usual gap between runs. */
  stale: boolean;
  /** The cadence of the run its proof came from, whose own usual gap measures it. */
  cadence?: string;
  gap?: number;
}

/** The usual gap between runs, as the median of the gaps between these finish times; none with fewer than two. */
export function usualGap(finishedAt: string[]): number | undefined {
  const t = finishedAt.map((x) => Date.parse(x)).sort((a, b) => a - b);
  const gaps = t.slice(1).map((x, i) => x - t[i]!);
  if (!gaps.length) return undefined;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
}

/** Whether proof recorded at one time is too old at another: older than twice the usual gap. */
export function isStale(
  proofAt: string,
  pointAt: string,
  gap: number | undefined,
): boolean {
  return (
    gap !== undefined && Date.parse(pointAt) - Date.parse(proofAt) > 2 * gap
  );
}

/** A gap between runs in words: "40 minutes", "hour", "3 hours", "day", "2 days". */
export function gapWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 55) return `${Math.max(1, minutes)} minutes`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return hours === 1 ? "hour" : `${hours} hours`;
  const days = Math.round(ms / 86_400_000);
  return days === 1 ? "day" : `${days} days`;
}

/** Why a cell is not checked here when the newest build gave no sentence for that point. */
export function uncheckedFallback(note: CellNote, env: Env): string {
  if (note === "partial")
    return `Scenarios reach it on ${env} but verify only part of what it must prove.`;
  if (note === "skipped") return `Its scenarios were skipped on ${env}.`;
  if (note === "unreached")
    return `Its scenarios could not reach ${env} in the newest run.`;
  return `No scenario that reaches it runs on ${env}.`;
}

/** The "As of" line under a state, with why it fades when it is old. */
export function asOfText(
  v: Verdict,
  env: Env,
  gap: number | undefined,
): string {
  if (!v.asOf)
    return v.stale ? "As of a run older than the runs kept here." : "";
  const at = `As of ${formatPacific(v.asOf)}`;
  const g = v.cadence !== undefined ? v.gap : gap;
  const what = v.cadence !== undefined ? ` its ${v.cadence} scenarios` : "";
  return v.stale && g !== undefined
    ? `${at}, which is old: ${ENV_LABEL[env]} usually runs${what} every ${gapWords(g)}.`
    : `${at}.`;
}

/** The spine's one verdict per item and env, for every renderer: map, panels, search. */
export function verdictModel(cov: CoverageModel, scen: ScenariosModel) {
  const {
    status,
    snapshots,
    LATEST,
    cellNote,
    ownScenarios,
    itemScenarios,
    items,
  } = cov;
  const { runs, details, recordAt } = scen;

  /** An env's runs of one cadence, the ordinary ones when it is undefined. */
  const runsOf = (env: Env, cadence?: string) =>
    runs.filter((r) => r.env === env && r.cadence === cadence);
  /** An env's ordinary runs, or all its runs when it has only cadence runs. */
  const mainRuns = (env: Env) =>
    runs.some((r) => r.env === env && r.cadence === undefined)
      ? runsOf(env)
      : runs.filter((r) => r.env === env);
  const gaps: Record<Env, number | undefined> = byEnv((e) =>
    usualGap(mainRuns(e).map((r) => r.finishedAt)),
  );
  const cadenceGaps = new Map<string, number | undefined>();
  const gapOf = (env: Env, cadence: string | undefined) => {
    if (cadence === undefined) return gaps[env];
    const key = `${env}/${cadence}`;
    if (!cadenceGaps.has(key))
      cadenceGaps.set(
        key,
        usualGap(runsOf(env, cadence).map((r) => r.finishedAt)),
      );
    return cadenceGaps.get(key);
  };

  /** The env's newest ordinary run at a timeline point (its newest run when it has only cadence runs). */
  function runAt(env: Env, snap: number): RunInfo | undefined {
    const at = snapshots[snap]!.at;
    return lastWhere(mainRuns(env), (r) => r.finishedAt <= at);
  }

  /** The scenarios an item's state rests on: its own touches, or its elements' for a shared hex. */
  function behind(it: Item): ScenarioDetail[] {
    const refs =
      it.kind === "Shared elements" ? itemScenarios(it) : ownScenarios(it);
    return refs.flatMap((s) => details[s.sIdx] ?? []);
  }

  /** The run of the newest record of these statuses among the item's scenarios, at a timeline point. */
  function newestRecord(
    it: Item,
    env: Env,
    snap: number,
    want: string,
  ): RunInfo | undefined {
    let best: RunInfo | undefined;
    for (const d of behind(it)) {
      const r = recordAt(d, env, snap);
      if (!r || !want.includes(r.status)) continue;
      const run = runs[r.run]!;
      if (!best || run.finishedAt > best.finishedAt) best = run;
    }
    return best;
  }

  function laterFailures(it: Item, env: Env, snap: number): LaterFailure[] {
    const ids = snap === LATEST ? it.laterFailed?.[env] : undefined;
    const list = ids
      ? ids.flatMap((id) => details.find((d) => d.id === id) ?? [])
      : behind(it).filter((d) => recordAt(d, env, snap)?.status === "f");
    return list.map((scenario) => {
      const at = recordAt(scenario, env, snap)?.failure?.at;
      return at !== undefined && at >= 0
        ? { scenario, step: at + 1 }
        : { scenario };
    });
  }

  function verdict(it: Item, env: Env, snap: number): Verdict {
    const ei = ENVS.indexOf(env);
    const code = status[snap]![it.idx]![ei]!;
    const state = STATE_OF[code];
    const note = cellNote(it, snap, ei);
    const v: Verdict = {
      state,
      label: CODE_LABEL[code],
      laterFailed: note === "later-failed" ? laterFailures(it, env, snap) : [],
      stale: false,
    };
    if (state === "verified" || state === "failing") {
      const run = newestRecord(
        it,
        env,
        snap,
        state === "failing" || note === "later-failed" ? "f" : "p",
      );
      if (run) {
        const gap = gapOf(env, run.cadence);
        v.asOf = run.finishedAt;
        v.stale = isStale(run.finishedAt, snapshots[snap]!.at, gap);
        if (run.cadence !== undefined) {
          v.cadence = run.cadence;
          if (gap !== undefined) v.gap = gap;
        }
      } else v.stale = behind(it).length > 0;
    } else if (state === "unchecked" || state === "none") {
      const run = runAt(env, snap);
      if (run) v.asOf = run.finishedAt;
    }
    if (state === "unchecked" && note && note !== "later-failed") {
      const latest = cellNote(it, LATEST, ei);
      const given = it.unchecked?.[env];
      v.reason =
        latest === note && given ? given : uncheckedFallback(note, env);
    }
    return v;
  }

  const staleCache = new Map<number, Uint8Array>();
  /** Per item idx * N_ENVS + env index, 1 where a verified or failing cell rests on old proof, at a timeline point. */
  function staleCells(snap: number): Uint8Array {
    const known = staleCache.get(snap);
    if (known) return known;
    const out = new Uint8Array(items.length * N_ENVS);
    for (const it of items) {
      if (it.planned) continue;
      ENVS.forEach((env, ei) => {
        const c = status[snap]![it.idx]![ei]!;
        if (c !== 2 && c !== 3) return;
        if (verdict(it, env, snap).stale) out[it.idx * N_ENVS + ei] = 1;
      });
    }
    staleCache.set(snap, out);
    return out;
  }

  /** An env's newest run at a timeline point, measured against a clock: overdue past twice its usual gap. */
  function runAge(
    env: Env,
    snap: number,
    ref: number,
  ): { last: string; gap?: number; overdue: boolean } | undefined {
    const run = runAt(env, snap);
    if (!run) return undefined;
    const gap = gaps[env];
    const now = snap === LATEST ? ref : Date.parse(snapshots[snap]!.at);
    return {
      last: run.finishedAt,
      ...(gap !== undefined ? { gap } : {}),
      overdue: gap !== undefined && now - Date.parse(run.finishedAt) > 2 * gap,
    };
  }

  return { runGaps: gaps, verdict, staleCells, runAge };
}

export type VerdictModel = ReturnType<typeof verdictModel>;

/** The muted note on a cell verified only before a later step failed: "Verified here; a later step of Org deletion failed." */
export function laterFailedText(v: Verdict): string | undefined {
  if (!v.laterFailed.length) return undefined;
  const names = v.laterFailed.map((f) => f.scenario.name);
  const list =
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Verified here; a later step of ${list} failed.`;
}

/** What a cell says beyond its state, as sentences: the later failure, why it is not checked, and its age. */
export function verdictLines(
  v: Verdict,
  env: Env,
  gap: number | undefined,
  withAge: boolean,
): string[] {
  const age = withAge || v.stale ? asOfText(v, env, gap) : "";
  return [laterFailedText(v), v.reason, age].filter((x): x is string => !!x);
}
