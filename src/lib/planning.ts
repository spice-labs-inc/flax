import {
  countItems,
  countStations,
  leadEnv,
  stationUncheckedSentence,
  uncheckedKind,
  type StationCount,
  type UncheckedKind,
} from "./counts.ts";
import {
  ENVS,
  ENV_LABEL,
  ENV_ORDER,
  type CoverageModel,
  type Env,
  type EnvChoice,
  type Item,
  REFERENCE_ENV,
} from "./data.ts";
import type { Feature, FeaturesModel } from "./features.ts";
import type { PersonaDef, PersonaDefsModel } from "./personaDefs.ts";
import {
  STAGES,
  type Persona,
  type PersonasModel,
  type Stage,
  type Station,
  type StationState,
} from "./personas.ts";
import type { ScenarioDetail, ScenariosModel } from "./scenarios.ts";

/** A planned feature from the Engineering Board, as the map carries it. */
export interface PlannedIssue {
  item: Item;
  url: string;
  board: string;
  area: string;
  personas: string[];
}

/** One station on a persona's journey with what proves it and what is planned for it. */
export interface StationCoverage {
  station: Station;
  state: StationState;
  /** Per env, the station's state. */
  byEnv: Record<Env, StationState>;
  /** On the reference env, how the pipeline envs read beside it when they break: "Breaks on test; verified on live." */
  pipeline?: string;
  scenarios: ScenarioDetail[];
  features: Feature[];
  planned: PlannedIssue[];
}

export interface PersonaCoverage {
  persona: Persona;
  stations: StationCoverage[];
  /** The env its count leads with: the one on show, else the reference env, else the env nearest it its journey runs in. */
  lead: Env;
  /** Its stations counted in the lead env. */
  count: StationCount;
  /** Board issues naming this persona. */
  planned: PlannedIssue[];
}

/** The station that blocks a persona most in its lead env, why, and every persona whose journey passes through it. */
export interface Block {
  station: Station;
  state: StationState;
  reason: string;
  personas: Persona[];
}

/** A scenario that verifies a station, the step where it first reaches it, and when. */
export interface StationProof {
  scenario: ScenarioDetail;
  at: string;
  step?: { n: number; text: string };
}

/** A persona on the worst-served ranking: its coverage and what blocks it, if anything does. */
export interface Served {
  coverage: PersonaCoverage;
  block?: Block;
}

export interface MatrixCell {
  persona: Persona;
  stage: Stage;
  stations: Station[];
  state: StationState | "empty";
}

/** Where the product and the plan leave a persona short. */
export interface Gaps {
  /** Journey stations with no scenario proving them (and no planned feature behind them). */
  unproven: { persona: Persona; station: Station }[];
  /** Board issues that name no persona. */
  plannedForNobody: PlannedIssue[];
  /** Personas the product is designed for that have no journey yet. */
  withoutJourney: PersonaDef[];
  /** Surface items no persona's journey touches. */
  unclaimed: Item[];
  /** Features whose scenarios touch nothing on any persona's journey. */
  featuresForNobody: Feature[];
}

const STATE_RANK: Record<StationState, number> = {
  fail: 0,
  partial: 1,
  none: 2,
  unchecked: 3,
  planned: 4,
  never: 5,
  elsewhere: 6,
  pass: 7,
};

/** What blocks a journey, worst first: a failing station, then one with no scenario, one waiting on a feature, one not checked, one partly verified. */
const BLOCK_ORDER: readonly StationState[] = [
  "fail",
  "none",
  "planned",
  "unchecked",
  "partial",
];

/** The PM's view: each persona's journey against what exists and what is planned. */
export function planningModel(
  cov: CoverageModel,
  scen: ScenariosModel,
  pers: PersonasModel,
  defs: PersonaDefsModel,
  feats: FeaturesModel,
) {
  const { items } = cov;
  const { itemDetails, failureOn, recordAt, refOf, runs, scenarioItems } = scen;
  const { itemSteps } = cov;
  const { personas, stationState, pipelineNote, orphans } = pers;
  const { personaDefs } = defs;
  const { features, featureOf } = feats;

  const plannedIssues: PlannedIssue[] = items.flatMap((it) =>
    it.planned?.kind === "issue"
      ? [
          {
            item: it,
            url: it.planned.url,
            board: it.planned.board,
            area: it.planned.area,
            personas: it.planned.personas,
          },
        ]
      : [],
  );

  const signedIn = personas.filter((p) =>
    p.stations.some((s) => s.key === "signin"),
  );
  /** A list of personas that is everyone whose journey signs in, so naming them singles nobody out. */
  function everyoneSignedIn(list: readonly Persona[]): boolean {
    return (
      signedIn.length > 1 &&
      list.length === signedIn.length &&
      signedIn.every((p) => list.includes(p))
    );
  }

  function plannedFor(p: Persona): PlannedIssue[] {
    return plannedIssues.filter((i) => i.personas.includes(p.id));
  }

  /** Issues the station's own items carry (a station of kind planned matches issue items). */
  function plannedAt(st: Station): PlannedIssue[] {
    return plannedIssues.filter((i) => st.items.includes(i.item));
  }

  function stationScenarios(st: Station): ScenarioDetail[] {
    const seen = new Set<ScenarioDetail>();
    for (const it of st.items) for (const d of itemDetails(it)) seen.add(d);
    return [...seen];
  }

  function stationCoverage(
    st: Station,
    snap: number,
    env: EnvChoice,
  ): StationCoverage {
    const scenarios = stationScenarios(st);
    const pipeline = env === REFERENCE_ENV ? pipelineNote(st, snap) : undefined;
    const fs = new Set<Feature>();
    for (const d of scenarios) {
      const f = featureOf(d.id);
      if (f) fs.add(f);
    }
    return {
      station: st,
      state: stationState(st, snap, env),
      byEnv: Object.fromEntries(
        ENVS.map((e) => [e, stationState(st, snap, e)]),
      ) as Record<Env, StationState>,
      ...(pipeline ? { pipeline } : {}),
      scenarios,
      features: [...fs],
      planned: plannedAt(st),
    };
  }

  function personaCoverage(
    p: Persona,
    snap: number,
    env: EnvChoice,
  ): PersonaCoverage {
    const stations = p.stations.map((st) => stationCoverage(st, snap, env));
    const lead = leadEnv(
      (e) => stations.some((s) => s.byEnv[e] !== "never"),
      env,
    );
    return {
      persona: p,
      stations,
      lead,
      count: countStations(
        stations.map((s) => s.byEnv[lead]),
        lead,
      ),
      planned: plannedFor(p),
    };
  }

  /**
   * The 1 to 3 scenarios that verify a station in an env, the env on show or else the nearest to the reference env that has any:
   * each picked for the most of its items it reaches that the ones before did not.
   */
  function stationProof(
    st: Station,
    snap: number,
    env: EnvChoice,
  ): { env: Env; rows: StationProof[] } | undefined {
    const items = new Set(st.items.filter((it) => !it.planned));
    for (const e of env === "all" ? ENV_ORDER : [env]) {
      const passed = stationScenarios(st).flatMap((d) => {
        const r = recordAt(d, e, snap);
        if (r?.status !== "p") return [];
        const reach = scenarioItems(d).filter((it) => items.has(it));
        return reach.length
          ? [
              {
                d,
                at: runs[r.run]!.finishedAt,
                reach,
                all: scenarioItems(d).length,
              },
            ]
          : [];
      });
      if (!passed.length) continue;
      const rows: StationProof[] = [];
      const seen = new Set<Item>();
      while (rows.length < 3) {
        const gain = (x: (typeof passed)[number]) =>
          x.reach.filter((it) => !seen.has(it)).length;
        const next = passed
          .filter((x) => gain(x) > 0)
          .sort(
            (a, b) =>
              gain(b) - gain(a) || a.all - b.all || b.at.localeCompare(a.at),
          )[0];
        if (!next) break;
        for (const it of next.reach) seen.add(it);
        const sIdx = refOf(next.d.id)?.sIdx;
        const steps =
          sIdx === undefined
            ? []
            : next.reach.flatMap((it) => itemSteps(it, sIdx) ?? []);
        const first = steps.length ? Math.min(...steps) : undefined;
        const step = first === undefined ? undefined : next.d.steps[first];
        rows.push({
          scenario: next.d,
          at: next.at,
          ...(step && first !== undefined
            ? { step: { n: first + 1, text: `${step.k.trim()} ${step.t}` } }
            : {}),
        });
      }
      return { env: e, rows };
    }
    return undefined;
  }

  /** Why a station blocks a journey in an env, as a sentence. */
  function blockReason(
    s: StationCoverage,
    state: StationState,
    env: Env,
    snap: number,
  ): string {
    const e = ENV_LABEL[env].toLowerCase();
    const issues = s.planned.length;
    const board = issues
      ? `${issues} ${issues === 1 ? "issue" : "issues"} on the board ${issues === 1 ? "is" : "are"} planned for it`
      : "nothing on the board is planned for it";
    if (state === "fail") {
      const n = failureOn(s.scenarios, env, snap);
      return n
        ? `${n.scenario.name} fails on ${e} at the step "${n.step}".`
        : `A scenario that reaches it fails on ${e}.`;
    }
    if (state === "none") return `No scenario checks it yet, and ${board}.`;
    if (state === "planned")
      return `Its feature is not built yet${issues ? `, and ${board}` : ""}.`;
    const items = s.station.items.filter((it) => !it.planned);
    if (state === "unchecked") {
      const kinds = new Map<UncheckedKind, number>();
      const ei = ENVS.indexOf(env);
      for (const it of items)
        if (cov.status[snap]![it.idx]![ei] === -2) {
          const k = uncheckedKind(cov, it, snap, env);
          kinds.set(k, (kinds.get(k) ?? 0) + 1);
        }
      const top = [...kinds].sort((a, b) => b[1] - a[1])[0]?.[0];
      return stationUncheckedSentence(top ?? "elsewhere", env);
    }
    const c = countItems(cov, items, snap, env);
    return `Scenarios verify ${c.verified} of the ${c.total} items it needs on ${e}.`;
  }

  /** What blocks a persona most in its lead env, or nothing when every station there is verified. */
  function blockOf(c: PersonaCoverage, snap: number): Block | undefined {
    for (const state of BLOCK_ORDER) {
      const s = c.stations.find((x) => x.byEnv[c.lead] === state);
      if (s)
        return {
          station: s.station,
          state,
          reason: blockReason(s, state, c.lead, snap),
          personas: personas.filter((p) => p.stations.includes(s.station)),
        };
    }
    return undefined;
  }

  /**
   * Personas worst-served first in each one's lead env: the most failing stations, then the most with no scenario,
   * waiting on a feature or not checked, then the most only partly verified. Each with the station that blocks it.
   */
  function worstServed(snap: number, env: EnvChoice): Served[] {
    const score = (c: StationCount) => [
      c.failing,
      c.none + c.waiting + c.unchecked,
      c.partial,
    ];
    return personas
      .map((p) => {
        const coverage = personaCoverage(p, snap, env);
        const block = blockOf(coverage, snap);
        return { coverage, ...(block ? { block } : {}) };
      })
      .map((x, i) => ({ x, i, s: score(x.coverage.count) }))
      .sort((a, b) => {
        for (let k = 0; k < a.s.length; k++)
          if (a.s[k] !== b.s[k]) return b.s[k]! - a.s[k]!;
        return a.i - b.i;
      })
      .map(({ x }) => x);
  }

  function worst(states: StationState[]): StationState | "empty" {
    if (!states.length) return "empty";
    return states.reduce((a, b) => (STATE_RANK[b] < STATE_RANK[a] ? b : a));
  }

  /** Personas by journey stage: the worst station state in each cell. */
  function matrix(snap: number, env: EnvChoice): MatrixCell[][] {
    return personas.map((p) =>
      STAGES.map((stage) => {
        const stations = p.stations.filter((s) => s.stage === stage);
        return {
          persona: p,
          stage,
          stations,
          state: worst(stations.map((s) => stationState(s, snap, env))),
        };
      }),
    );
  }

  function gaps(snap: number, env: EnvChoice): Gaps {
    const unproven: Gaps["unproven"] = [];
    const seen = new Set<Station>();
    for (const p of personas)
      for (const st of p.stations) {
        if (seen.has(st)) continue;
        seen.add(st);
        const s = stationState(st, snap, env);
        if (s === "none" || s === "never")
          unproven.push({ persona: p, station: st });
      }
    const withJourney = new Set(personas.map((p) => p.id));
    return {
      unproven,
      plannedForNobody: plannedIssues.filter((i) => i.personas.length === 0),
      withoutJourney: personaDefs.filter(
        (d) => d.type !== "negative" && !withJourney.has(d.id),
      ),
      unclaimed: orphans,
      featuresForNobody: features.filter(
        (f) => f.personas.length === 0 && f.scenarios.some((s) => !s.planned),
      ),
    };
  }

  return {
    plannedIssues,
    plannedFor,
    everyoneSignedIn,
    stationCoverage,
    personaCoverage,
    stationProof,
    worstServed,
    matrix,
    gaps,
  };
}

export type PlanningModel = ReturnType<typeof planningModel>;
