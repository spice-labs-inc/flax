import { failedStep, shortMessage } from "./failure.ts";
import {
  ENVS,
  ENV_ORDER,
  envIndexes,
  type CoverageModel,
  type Env,
  type EnvChoice,
  type Item,
  excludedOn,
} from "./data.ts";
import type { FeaturesModel, Feature } from "./features.ts";
import {
  KEPT_RECORDS,
  failureKind,
  isUnreachable,
  type KindReading,
} from "./failureKind.ts";
import type { Persona, PersonasModel, Station } from "./personas.ts";
import {
  lastWhere,
  stepsOf,
  type RunInfo,
  type ScenarioDetail,
  type ScenarioRecord,
  type ScenariosModel,
  type Version,
} from "./scenarios.ts";

/** What a failure stops: the items its failing step touched, the journey stations holding them, and whose journeys those are. */
export interface Blocks {
  items: Item[];
  /** Every item was placed at the failing step by the steps its runs recorded, not only by the scenario failing. */
  atStep: boolean;
  stations: Station[];
  personas: Persona[];
}

/** One scenario failing in an env at a timeline point, with everything needed to act on it. */
export interface Failing {
  env: Env;
  scenario: ScenarioDetail;
  feature?: Feature;
  /** When the run that recorded this failure finished. */
  at: string;
  /** The builds that run ran against, as attribution for the result. */
  versions: Version[];
  /** When the scenario first failed in this unbroken stretch of failures. */
  since: string;
  /** How many runs in a row it has failed, this one included. */
  runsFailing: number;
  /** When it last passed in this env, if ever. */
  lastPassAt?: string;
  step: string;
  stepNo?: number;
  /** The failing step's zero-based index, or where outside the steps it failed: -1 setup, -2 cleanup, -3 unplaced. */
  failedAt: number;
  /** The error's first line, and the lines after it. */
  message: string;
  more: string;
  kind: KindReading;
  blocks: Blocks;
  shot?: string;
}

/** A scenario whose result flipped between the run before and this one. */
export interface Flip {
  env: Env;
  scenario: ScenarioDetail;
  feature?: Feature;
  to: "pass" | "fail";
  at: string;
}

/** Why the items on the map an env's runs do not check are not checked there, by count. */
export interface NotChecked {
  total: number;
  /** No scenario that reaches them runs here; how many of those only fixture or excluded-tag scenarios reach. */
  elsewhere: number;
  fixture: number;
  internalAdmin: number;
  partial: number;
  skipped: number;
}

export interface EnvNow {
  env: Env;
  /** The newest run in the env at the timeline point, if any. */
  run?: RunInfo;
  ran: number;
  passed: number;
  failed: number;
  /** Scenarios the run skipped on purpose, such as fixture scenarios on the reference env. */
  skipped: number;
  /** Scenarios that neither passed, failed nor were skipped: undefined, pending, ambiguous. */
  other: number;
  /** Failures that say something about the product, newest stretch first. */
  failing: Failing[];
  /** Failures where the run could not reach the env. */
  unreachable: Failing[];
  fixed: Flip[];
  broke: Flip[];
  notChecked: NotChecked;
  /** Hours since the run finished, as of the data build. */
  ageHours: number;
}

/** One scenario failing in one or more envs, reference env first. */
export interface NowCard {
  scenario: ScenarioDetail;
  feature?: Feature;
  envs: Failing[];
}

/** Cards whose errors share a first line. */
export interface NowGroup {
  message: string;
  cards: NowCard[];
}

/** The scenarios that could not reach one env, as one line. */
export interface Unreached {
  env: Env;
  failing: Failing[];
}

/** The Now door at a timeline point for the envs on show: each env's run, the failures by scenario, and what the map lights. */
export interface NowView {
  envs: EnvNow[];
  groups: NowGroup[];
  unreached: Unreached[];
  /** Items the failures' failing steps touched, where the map's dimming spreads from. */
  from: Set<number>;
  /** Items that stay lit: those, what holds them, and the stations they block. */
  lit: Set<number>;
}

/** The same error, whatever ids and counts it carries. */
export function errorKey(message: string): string {
  return message
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "#",
    )
    .replace(/\b[0-9a-f]{7,40}\b/gi, "#")
    .replace(/\d+/g, "#")
    .trim();
}

/** Scenarios failing in several envs as one card each, cards with the same error together, biggest group first. */
export function cardsOf(list: Failing[]): NowGroup[] {
  const cards = new Map<string, NowCard>();
  for (const f of list) {
    const c = cards.get(f.scenario.id) ?? {
      scenario: f.scenario,
      ...(f.feature ? { feature: f.feature } : {}),
      envs: [],
    };
    c.envs.push(f);
    cards.set(f.scenario.id, c);
  }
  const groups = new Map<string, NowGroup>();
  for (const c of cards.values()) {
    c.envs.sort((a, b) => ENV_ORDER.indexOf(a.env) - ENV_ORDER.indexOf(b.env));
    const message = c.envs[0]!.message;
    const key = errorKey(message);
    const g = groups.get(key) ?? { message, cards: [] };
    g.cards.push(c);
    groups.set(key, g);
  }
  const since = (c: NowCard) =>
    c.envs.reduce((m, f) => (f.since > m ? f.since : m), "");
  for (const g of groups.values())
    g.cards.sort((a, b) => since(b).localeCompare(since(a)));
  return [...groups.values()].sort(
    (a, b) =>
      b.cards.length - a.cards.length ||
      since(b.cards[0]!).localeCompare(since(a.cards[0]!)),
  );
}

/** What is broken, what just changed and what ran, per env, for the Now page. */
export function nowModel(
  cov: CoverageModel,
  scen: ScenariosModel,
  feats: Pick<FeaturesModel, "featureOf">,
  pers: Pick<PersonasModel, "personas">,
) {
  const {
    snapshots,
    builtAt,
    items,
    mapItems,
    status,
    cellNote,
    scenarios,
    ownScenarios,
    itemScenarios,
    itemSteps,
    holderChain,
    tally,
  } = cov;
  const { runs, details, shots } = scen;
  const { featureOf } = feats;
  const { personas } = pers;
  const stations = [...new Set(personas.flatMap((p) => p.stations))];
  const indexOf = new Map(details.map((d, i) => [d.id, i]));

  const finishedAt = (r: ScenarioRecord) => runs[r.run]!.finishedAt;
  const firstRun = new Map(
    ENVS.map((e) => [e, runs.findIndex((r) => r.env === e)]),
  );

  /** Whether a scenario's failing step reached the item, by the step its touches recorded, when its runs recorded steps. */
  function touchedAtFailure(it: Item, sIdx: number, at: number): boolean {
    if (!scenarios[sIdx]?.stepped) return true;
    const steps = itemSteps(it, sIdx);
    if (at === -2) return !steps?.length;
    if (at < 0) return true;
    return !!steps?.includes(at);
  }

  /**
   * The items a failure blocks: failing here and touched by this scenario. Where several failing scenarios touch an
   * item, only those whose failing step reached it block it.
   */
  function blocksOf(
    d: ScenarioDetail,
    env: Env,
    snap: number,
    at: number,
    failingHere: Set<number>,
  ) {
    const sIdx = indexOf.get(d.id)!;
    const ei = ENVS.indexOf(env);
    const hit = items.filter(
      (it) =>
        !it.planned &&
        it.kind !== "Shared elements" &&
        status[snap]![it.idx]![ei] === 2 &&
        ownScenarios(it).some((s) => s.sIdx === sIdx) &&
        (ownScenarios(it).filter((s) => failingHere.has(s.sIdx)).length === 1 ||
          touchedAtFailure(it, sIdx, at)),
    );
    const ids = new Set(hit.map((it) => it.idx));
    const stepped = !!scenarios[sIdx]?.stepped;
    const st = stations.filter((s) => s.items.some((it) => ids.has(it.idx)));
    return {
      items: hit,
      atStep:
        stepped && at >= 0 && hit.every((it) => touchedAtFailure(it, sIdx, at)),
      stations: st,
      personas: personas.filter((p) => p.stations.some((s) => st.includes(s))),
    };
  }

  function failingOf(
    d: ScenarioDetail,
    env: Env,
    recs: ScenarioRecord[],
    snap: number,
    failingHere: Set<number>,
  ): Failing {
    const r = recs[recs.length - 1]!;
    let first = recs.length - 1;
    while (first > 0 && recs[first - 1]!.status === "f") first--;
    const lastPass = lastWhere(recs, (x) => x.status === "p");
    const f = r.failure;
    const at = f?.at ?? -3;
    const s = at >= 0 ? stepsOf(d, r)[at] : undefined;
    const feature = featureOf(d.id);
    const lines = shortMessage(f?.message ?? "", 24, 2400).split("\n");
    let head = lines[0] ?? "";
    let more = lines.slice(1).join("\n");
    if (head.length > 160) {
      more = [head, more].filter(Boolean).join("\n");
      const cut = head.lastIndexOf(" ", 140);
      head = `${head.slice(0, cut > 80 ? cut : 140).trimEnd()}…`;
    }
    const all = d.records[env];
    const whole =
      all.length < KEPT_RECORDS && all[0]?.run !== firstRun.get(env);
    return {
      env,
      scenario: d,
      ...(feature ? { feature } : {}),
      at: finishedAt(r),
      versions: runs[r.run]!.versions,
      since: finishedAt(recs[first]!),
      runsFailing: recs.length - first,
      ...(lastPass ? { lastPassAt: finishedAt(lastPass) } : {}),
      step: failedStep(at, s, f?.step),
      ...(s && !r.steps ? { stepNo: at + 1 } : {}),
      failedAt: at,
      message: head,
      more,
      kind: failureKind(recs, runs, env, whole),
      blocks: blocksOf(d, env, snap, at, failingHere),
      ...(r.shot && shots[r.shot] ? { shot: r.shot } : {}),
    };
  }

  /** The map's items an env's runs do not check at a timeline point, by why. */
  function notCheckedOf(env: Env, snap: number): NotChecked {
    const ei = ENVS.indexOf(env);
    const out: NotChecked = {
      total: tally(mapItems, snap, env).unchecked,
      elsewhere: 0,
      fixture: 0,
      internalAdmin: 0,
      partial: 0,
      skipped: 0,
    };
    for (const it of mapItems) {
      if (it.planned || status[snap]![it.idx]![ei] !== -2) continue;
      const note = cellNote(it, snap, ei);
      if (note === "partial") out.partial++;
      else if (note === "skipped") out.skipped++;
      else {
        out.elsewhere++;
        const tags = itemScenarios(it).map((s) => details[s.sIdx]?.tags ?? []);
        if (tags.length && tags.every((t) => t.includes("@fixture")))
          out.fixture++;
        else if (tags.length && tags.every((t) => excludedOn(t, env)))
          out.internalAdmin++;
      }
    }
    return out;
  }

  /** The env's state at a timeline point. */
  function envNow(env: Env, snap: number): EnvNow {
    const upTo = snapshots[snap]!.at;
    const run = lastWhere(runs, (r) => r.env === env && r.finishedAt <= upTo);
    const out: EnvNow = {
      env,
      ...(run ? { run } : {}),
      ran: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      other: 0,
      failing: [],
      unreachable: [],
      fixed: [],
      broke: [],
      notChecked: notCheckedOf(env, snap),
      ageHours: run
        ? (new Date(builtAt).getTime() - new Date(run.finishedAt).getTime()) /
          3_600_000
        : Infinity,
    };
    if (!run) return out;
    const runIdx = runs.indexOf(run);
    const failingHere = new Set(
      details.flatMap((d, i) =>
        lastWhere(d.records[env], (r) => finishedAt(r) <= upTo)?.status === "f"
          ? [i]
          : [],
      ),
    );
    for (const d of details) {
      const recs = d.records[env].filter((r) => finishedAt(r) <= upTo);
      const r = recs[recs.length - 1];
      if (!r || r.run !== runIdx) continue;
      out.ran++;
      if (r.status === "p") out.passed++;
      else if (r.status === "f") out.failed++;
      else if (r.status === "s") out.skipped++;
      else out.other++;
      if (r.status === "f") {
        const f = failingOf(d, env, recs, snap, failingHere);
        (f.kind.kind === "unreachable" ? out.unreachable : out.failing).push(f);
      }
      const prev = recs[recs.length - 2];
      if (!prev) continue;
      const feature = featureOf(d.id);
      const flip = (to: Flip["to"]): Flip => ({
        env,
        scenario: d,
        ...(feature ? { feature } : {}),
        to,
        at: finishedAt(r),
      });
      const reached = (x: ScenarioRecord) =>
        x.status !== "f" || !isUnreachable(x.failure?.message ?? "");
      if (!reached(prev) || !reached(r)) continue;
      if (prev.status === "f" && r.status === "p") out.fixed.push(flip("pass"));
      if (prev.status === "p" && r.status === "f") out.broke.push(flip("fail"));
    }
    out.failing.sort((a, b) => b.since.localeCompare(a.since));
    return out;
  }

  function now(snap: number): EnvNow[] {
    return ENV_ORDER.map((e) => envNow(e, snap));
  }

  const viewCache = new Map<string, NowView>();
  /** The Now door for the envs on show at a timeline point. */
  function nowView(snap: number, env: EnvChoice): NowView {
    const key = `${snap}:${env}`;
    const known = viewCache.get(key);
    if (known) return known;
    const eis = envIndexes(env);
    const envs = ENV_ORDER.filter((e) => eis.includes(ENVS.indexOf(e))).map(
      (e) => envNow(e, snap),
    );
    const from = new Set<number>();
    const lit = new Set<number>();
    const light = (it: Item) => {
      lit.add(it.idx);
      for (const h of holderChain(it)) lit.add(h.idx);
    };
    for (const e of envs)
      for (const f of e.failing) {
        for (const it of f.blocks.items) {
          from.add(it.idx);
          for (const h of holderChain(it)) from.add(h.idx);
          light(it);
        }
        for (const s of f.blocks.stations) s.items.forEach(light);
      }
    const view: NowView = {
      envs,
      groups: cardsOf(envs.flatMap((e) => e.failing)),
      unreached: envs
        .filter((e) => e.unreachable.length)
        .map((e) => ({ env: e.env, failing: e.unreachable })),
      from,
      lit,
    };
    viewCache.set(key, view);
    return view;
  }

  return { envNow, now, nowView };
}

export type NowModel = ReturnType<typeof nowModel>;
