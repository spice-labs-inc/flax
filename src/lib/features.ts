import {
  ELSEWHERE,
  ENVS,
  CONFIG,
  type CoverageModel,
  type Env,
  type EnvChoice,
  type Item,
  type MarkKind,
  type Surface,
} from "./data.ts";
import type { Persona, PersonasModel, Station } from "./personas.ts";
import {
  lastWhere,
  type FeatureEntry,
  type ScenarioDetail,
  type ScenariosModel,
} from "./scenarios.ts";

export type FeatureSurface = Surface | "core";

/** Each surface a feature file sits under, in config order, then "core" for the files under no surface. */
export const SURFACE_ORDER: readonly FeatureSurface[] = [
  ...CONFIG.surfaces.map((s) => s.name),
  "core",
];

export const SURFACE_TITLE: Record<FeatureSurface, string> = {
  ...Object.fromEntries(CONFIG.surfaces.map((s) => [s.name, s.title])),
  core: "Across the product",
};

/** One scenario of a feature: as the file writes it, and as the runs recorded it when any did. */
export interface FeatureScenario {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** Written and waiting for a feature that is not built or released yet. */
  planned: boolean;
  /** Verified outside these runs (a local scenario), never by the scheduled runs this page reads. */
  local: boolean;
  /** A row of a Scenario Outline, told apart by its cells. */
  example?: { outline: number; name: string; cells: string[] };
  detail?: ScenarioDetail;
}

export interface Feature {
  entry: FeatureEntry;
  id: string;
  /** The file's own name, as the URL names it: /features/<surface>/<stem>. */
  stem: string;
  surface: FeatureSurface;
  name: string;
  description: string;
  area: string;
  scenarios: FeatureScenario[];
  /** Surface items the feature's scenarios touch. */
  items: Item[];
  /** Personas whose journeys pass through those items. */
  personas: Persona[];
  /** Every scenario is verified outside these runs, none by the scheduled runs. */
  local: boolean;
}

export interface FeatureGroup {
  surface: FeatureSurface;
  title: string;
  features: Feature[];
}

/** A feature's state in one env at a timeline point, from its scenarios' newest results there. */
export interface FeatureState {
  kind: MarkKind;
  label: string;
  pass: number;
  fail: number;
  /** Scenarios that apply to the env but have no run yet. */
  waiting: number;
  planned: number;
}

const stem = (id: string) =>
  id.replace(/^features\/[^/]+\//, "").replace(/\.feature$/, "");

const scenarioCount = (n: number) =>
  `${n} ${n === 1 ? "scenario" : "scenarios"}`;

/** The feature file a scenario id names: "features/api/roles.feature" of "features/api/roles.feature:39". */
const fileOf = (scenarioId: string) => scenarioId.replace(/:\d+$/, "");
const lineOf = (scenarioId: string) =>
  Number(/:(\d+)$/.exec(scenarioId)?.[1] ?? 0);

export const LOCAL_LABEL = `${ELSEWHERE}; results not shown here yet`;

export function featurePath(f: { surface: FeatureSurface; stem: string }) {
  return `/features/${f.surface}/${f.stem}`;
}

/** A feature as the location names it: its surface folder and its file's path below it, "cli/local/edition-gates". */
export function featureKey(f: { surface: FeatureSurface; stem: string }) {
  return `${f.surface}/${f.stem}`;
}

/**
 * Recorded scenarios the catalog does not list, by feature file, kept while an env's newest full run still ran them.
 * The service's image carries the feature files it was built with while runs use newer commits, so a scenario missing
 * from the catalog alone may be brand new; one missing from every newest full run as well is an old id and drops out.
 */
export function unlistedScenarios(
  entries: readonly FeatureEntry[],
  details: readonly ScenarioDetail[],
  runs: readonly { env: Env }[],
): Map<string, ScenarioDetail[]> {
  const ranInRun = new Map<number, number>();
  for (const d of details)
    for (const e of ENVS)
      for (const r of d.records[e])
        ranInRun.set(r.run, (ranInRun.get(r.run) ?? 0) + 1);
  // A run of a handful of scenarios says nothing about the rest; a full run ran about as many as the env's largest.
  const newestFull = new Set<number>();
  for (const e of ENVS) {
    const own = runs.flatMap((r, i) => (r.env === e ? [i] : []));
    const most = Math.max(0, ...own.map((i) => ranInRun.get(i) ?? 0));
    const full = lastWhere(own, (i) => (ranInRun.get(i) ?? 0) >= most * 0.9);
    if (full !== undefined) newestFull.add(full);
  }
  const catalogued = new Set(
    entries.flatMap((e) => e.scenarios.map((s) => s.id)),
  );
  const out = new Map<string, ScenarioDetail[]>();
  for (const d of details) {
    if (catalogued.has(d.id)) continue;
    if (!ENVS.some((e) => d.records[e].some((r) => newestFull.has(r.run))))
      continue;
    const list = out.get(fileOf(d.id)) ?? [];
    list.push(d);
    out.set(fileOf(d.id), list);
  }
  return out;
}

/** The feature catalog: every feature file with its scenarios, results, items and personas. */
export function featuresModel(
  cov: CoverageModel,
  scen: ScenariosModel,
  pers: PersonasModel,
  entries: FeatureEntry[],
) {
  const { bugs, items } = cov;
  const { detailOf, scenarioItems, recordAt, details, runs } = scen;
  const { personas } = pers;

  const personasOfItem = new Map<number, Set<Persona>>();
  const stationsOfItem = new Map<number, Station[]>();
  for (const p of personas)
    for (const st of p.stations)
      for (const it of st.items) {
        const set = personasOfItem.get(it.idx) ?? new Set<Persona>();
        set.add(p);
        personasOfItem.set(it.idx, set);
        const list = stationsOfItem.get(it.idx) ?? [];
        if (!list.includes(st)) list.push(st);
        stationsOfItem.set(it.idx, list);
      }

  const unlisted = unlistedScenarios(entries, details, runs);
  const known = new Set(entries.map((e) => e.id));
  const unknownFiles: FeatureEntry[] = [...unlisted.entries()].flatMap(
    ([file, ds]) =>
      known.has(file)
        ? []
        : [
            {
              id: file,
              name: ds[0]?.feature || stem(file),
              description: "",
              tags: [],
              surface:
                SURFACE_ORDER.find(
                  (s) => s !== "core" && file.startsWith(`features/${s}/`),
                ) ?? "core",
              area: stem(file).replace(/^.*\//, ""),
              scenarios: [],
            },
          ],
  );

  const features: Feature[] = [...entries, ...unknownFiles].map((e) => {
    const written: FeatureScenario[] = e.scenarios.map((s) => {
      const detail = detailOf(s.id);
      return {
        ...s,
        planned: s.tags.includes("@planned"),
        local: s.tags.includes("@local") && !detail,
        ...(detail ? { detail } : {}),
      };
    });
    const ranOnly: FeatureScenario[] = (unlisted.get(e.id) ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      tags: d.tags,
      planned: false,
      local: false,
      detail: d,
    }));
    const scenarios = ranOnly.length
      ? [...written, ...ranOnly].sort((a, b) => lineOf(a.id) - lineOf(b.id))
      : written;
    const itemSet = new Set<Item>();
    for (const s of scenarios)
      if (s.detail) for (const it of scenarioItems(s.detail)) itemSet.add(it);
    const itemList = [...itemSet].sort((a, b) => a.idx - b.idx);
    const personaSet = new Set<Persona>();
    for (const it of itemList)
      for (const p of personasOfItem.get(it.idx) ?? []) personaSet.add(p);
    return {
      entry: e,
      id: e.id,
      stem: stem(e.id),
      surface: e.surface,
      name: e.name,
      description: e.description,
      area: e.area,
      scenarios,
      items: itemList,
      personas: personas.filter((p) => personaSet.has(p)),
      local:
        scenarios.some((s) => s.local) &&
        scenarios.every((s) => s.local || s.planned),
    };
  });

  const byId = new Map(features.map((f) => [f.id, f]));
  const byKey = new Map(features.map((f) => [featureKey(f), f]));
  const byScenario = new Map<string, Feature>();
  for (const f of features)
    for (const s of f.scenarios) byScenario.set(s.id, f);

  const groups: FeatureGroup[] = SURFACE_ORDER.flatMap((surface) => {
    const own = features
      .filter((f) => f.surface === surface)
      .sort((a, b) => a.name.localeCompare(b.name));
    return own.length
      ? [{ surface, title: SURFACE_TITLE[surface], features: own }]
      : [];
  });

  /** The feature a scenario belongs to; one the feature no longer lists still belongs to its file. */
  function featureOf(scenarioId: string): Feature | undefined {
    return byScenario.get(scenarioId) ?? byId.get(fileOf(scenarioId));
  }

  /** The feature a location names by its surface and stem, "cli/local/edition-gates". */
  function featureAt(key: string): Feature | undefined {
    return byKey.get(key);
  }

  function featureState(f: Feature, env: Env, snap: number): FeatureState {
    let pass = 0;
    let fail = 0;
    let waiting = 0;
    let planned = 0;
    let applies = false;
    for (const s of f.scenarios) {
      if (s.planned) {
        planned++;
        continue;
      }
      const d = s.detail;
      if (!d || !d.applies.includes(env)) continue;
      applies = true;
      const r = recordAt(d, env, snap);
      if (!r) waiting++;
      else if (r.status === "p") pass++;
      else if (r.status === "f") fail++;
      else waiting++;
    }
    const counts = { pass, fail, waiting, planned };
    if (fail)
      return {
        kind: "fail",
        label: `${fail} of ${scenarioCount(pass + fail + waiting)} failing`,
        ...counts,
      };
    if (pass && !waiting)
      return {
        kind: "pass",
        label:
          pass === 1
            ? "Its 1 scenario verified"
            : `All ${pass} scenarios verified`,
        ...counts,
      };
    if (pass)
      return {
        kind: "partial",
        label: `${pass} of ${scenarioCount(pass + waiting)} verified, the rest have no run yet`,
        ...counts,
      };
    if (applies) return { kind: "none", label: "No run yet", ...counts };
    if (planned && !f.scenarios.some((s) => !s.planned))
      return {
        kind: "planned",
        label: "Written for a feature not released yet",
        ...counts,
      };
    if (f.local) return { kind: "never", label: LOCAL_LABEL, ...counts };
    return { kind: "never", label: "Does not run here", ...counts };
  }

  /** The feature's state across the envs on show: failing anywhere wins, then verified everywhere. */
  function featureSummary(
    f: Feature,
    env: EnvChoice,
    snap: number,
  ): FeatureState {
    const envs = env === "all" ? ENVS : [env];
    const states = envs.map((e) => featureState(f, e, snap));
    const sum = states.reduce(
      (a, s) => ({
        pass: a.pass + s.pass,
        fail: a.fail + s.fail,
        waiting: a.waiting + s.waiting,
        planned: s.planned,
      }),
      { pass: 0, fail: 0, waiting: 0, planned: 0 },
    );
    const failing = states.find((s) => s.kind === "fail");
    if (failing) return { ...failing, ...sum, kind: "fail" };
    const live = states.filter((s) => s.kind !== "never");
    if (live.length && live.every((s) => s.kind === "pass"))
      return { kind: "pass", label: "Verified everywhere it runs", ...sum };
    if (live.some((s) => s.kind === "pass" || s.kind === "partial"))
      return {
        kind: "partial",
        label: "Verified where it has run; some runs still missing",
        ...sum,
      };
    if (live.some((s) => s.kind === "none"))
      return { kind: "none", label: "No run yet", ...sum };
    if (live.some((s) => s.kind === "planned"))
      return {
        kind: "planned",
        label: "Written for a feature not released yet",
        ...sum,
      };
    if (f.local) return { kind: "never", label: LOCAL_LABEL, ...sum };
    return {
      kind: "never",
      label: "Does not run in these environments",
      ...sum,
    };
  }

  /** Open bugs filed against the feature's surface. */
  function featureBugs(f: Feature) {
    return bugs.filter((b) => b.surface === f.surface);
  }

  /** Open board issues on the feature's surface and area, as the map carries them. */
  function featureIssues(f: Feature): Item[] {
    return items.filter(
      (it) =>
        it.planned?.kind === "issue" &&
        it.surface === f.surface &&
        (it.planned.area === f.area || it.planned.area === f.stem),
    );
  }

  const norm = (s: string) => s.toLowerCase();

  /** Features whose name, description, scenario names or steps mention every word of the query. */
  function searchFeatures(query: string): Feature[] {
    const words = norm(query).split(/\s+/).filter(Boolean);
    if (!words.length) return features;
    return features.filter((f) => {
      const hay = norm(
        [
          f.name,
          f.description,
          f.area,
          SURFACE_TITLE[f.surface],
          ...f.scenarios.map((s) => s.name),
          ...f.scenarios.flatMap((s) =>
            s.detail ? s.detail.steps.map((st) => st.t) : [],
          ),
        ].join("\n"),
      );
      return words.every((w) => hay.includes(w));
    });
  }

  return {
    features,
    featureGroups: groups,
    featureOf,
    featureAt,
    featureState,
    featureSummary,
    featureBugs,
    featureIssues,
    searchFeatures,
    stationsOfItem: (it: Item) => stationsOfItem.get(it.idx) ?? [],
    personasOfItem: (it: Item) => [...(personasOfItem.get(it.idx) ?? [])],
  };
}

export type FeaturesModel = ReturnType<typeof featuresModel>;
