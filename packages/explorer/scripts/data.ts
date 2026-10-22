import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  surfaceOfScenarioId,
  type CoverageFile,
  type DocSource,
  type Env,
  type HistoryFile,
  type JourneysFile,
  type Persona,
  type PlannedScenario,
  type RunResult,
  type SurfaceFile,
  type SurfaceName,
} from "@flax/contract";
import { config, envConfig, surfaceConfig } from "@flax/scenarios/config";
import {
  buildCoverage,
  mergeRuns,
  type CoverageItem,
  type CoverageMap,
} from "@flax/scenarios/coverage/map";
import type { JourneyResolution } from "@flax/scenarios/dataset/journeys";
import { ENVS } from "@flax/scenarios/lib/types";
import { envsForTags, leftOutBy, type LeftOut } from "@flax/scenarios/run/tags";
import { isUnreachable } from "../src/lib/unreachable.ts";
import {
  attemptsFrom,
  currentByEnv,
  fixturesRun,
  readEnvelopes,
} from "./scenarios.ts";

/** One scheduled run as `pnpm results:fetch` leaves it: `<results>/<env>/<id>/run.json` and `planned.json`. */
export interface RunOnDisk {
  env: Env;
  id: string;
  run: RunResult;
  planned: PlannedScenario[];
}

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

export type { DocSource };

/** A README or internal doc that documents items, from the documentation file beside the coverage map; absent means none. */
export function readDocumentation(root: string): DocSource[] {
  const p = join(root, config().paths.documentation);
  if (!existsSync(p)) return [];
  const raw = readJson(p) as { sources?: unknown };
  if (!Array.isArray(raw.sources)) return [];
  return raw.sources.flatMap((s): DocSource[] => {
    if (typeof s !== "object" || s === null) return [];
    const o = s as Record<string, unknown>;
    if (
      typeof o["id"] !== "string" ||
      (o["kind"] !== "readme" && o["kind"] !== "internal-doc") ||
      typeof o["title"] !== "string" ||
      typeof o["url"] !== "string" ||
      !Array.isArray(o["documents"])
    )
      return [];
    return [
      {
        id: o["id"],
        kind: o["kind"],
        title: o["title"],
        url: o["url"],
        documents: o["documents"].filter(
          (x): x is string => typeof x === "string",
        ),
      },
    ];
  });
}

export function readSurfaces(root: string): SurfaceFile[] {
  return config()
    .surfaces.map((s) => join(root, config().paths.surfaces, `${s.name}.json`))
    .filter(existsSync)
    .map((p) => readJson(p) as SurfaceFile);
}

/** Every run on disk, oldest finish first. */
export function readRuns(resultsDir: string): RunOnDisk[] {
  const runs: RunOnDisk[] = [];
  for (const env of ENVS) {
    const dir = join(resultsDir, env);
    if (!existsSync(dir)) continue;
    for (const id of readdirSync(dir).sort()) {
      const runFile = join(dir, id, "run.json");
      if (!existsSync(runFile)) continue;
      const plannedFile = join(dir, id, "planned.json");
      runs.push({
        env,
        id,
        run: withFailingSteps(
          readJson(runFile) as RunResult,
          join(dir, id, "messages.ndjson"),
        ),
        planned: existsSync(plannedFile)
          ? (readJson(plannedFile) as PlannedScenario[])
          : [],
      });
    }
  }
  return runs.sort(
    (a, b) =>
      a.run.finishedAt.localeCompare(b.run.finishedAt) ||
      a.id.localeCompare(b.id),
  );
}

/** Places each failure at its step from the run's messages, for runs whose run.json predates failure.at. */
function withFailingSteps(run: RunResult, messages: string): RunResult {
  const unplaced = run.scenarios.filter(
    (s) => s.failure && s.failure.at === undefined,
  );
  if (unplaced.length === 0 || !existsSync(messages)) return run;
  const at = new Map(
    attemptsFrom(readEnvelopes(messages)).flatMap((a) =>
      a.failure ? [[a.scenarioId, a.failure.at]] : [],
    ),
  );
  for (const s of unplaced) {
    const step = at.get(s.id);
    if (step !== undefined && s.failure) s.failure.at = step;
  }
  return run;
}

const WEEK = 7 * 86_400_000;
const californiaDay = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: config().timezone }).format(
    new Date(iso),
  );

/** The runs the timeline stops at: every run of the last week, and before that the last run of each day in the configured timezone. */
export function historyPoints<T extends { run: { finishedAt: string } }>(
  runs: T[],
): T[] {
  const latest = runs.at(-1);
  if (!latest) return [];
  const latestAt = new Date(latest.run.finishedAt).getTime();
  return runs.filter((r, i) => {
    if (latestAt - new Date(r.run.finishedAt).getTime() <= WEEK) return true;
    const next = runs[i + 1];
    return (
      !next ||
      californiaDay(next.run.finishedAt) !== californiaDay(r.run.finishedAt)
    );
  });
}

/** Each env's runs as one, merged as `pnpm coverage` merges them. */
function mergedByEnv(runs: RunOnDisk[]): RunResult[] {
  return ENVS.flatMap((env) => {
    const own = runs
      .filter((r) => r.env === env)
      .sort((a, b) => a.id.localeCompare(b.id));
    const m = mergeRuns(own.map((r) => r.run));
    return m ? [m] : [];
  });
}

/** The coverage map as it stood once these runs had finished. */
export function coverageAfter(
  files: SurfaceFile[],
  runs: RunOnDisk[],
  builtAt: string,
): CoverageMap {
  return buildCoverage(files, builtAt, {
    runs: mergedByEnv(runs),
    planned: [],
  });
}

/** What one env's merged run shows of the items: those a passed scenario touched, those a passed or failed one touched, those a scenario that reached the env failed on, and the scenarios it neither passed nor failed. */
interface Reach {
  passed: Set<string>;
  ran: Set<string>;
  failedThere: Set<string>;
  notRun: Set<string>;
}

function reachOf(run: RunResult | undefined): Reach {
  const reach: Reach = {
    passed: new Set(),
    ran: new Set(),
    failedThere: new Set(),
    notRun: new Set(),
  };
  for (const s of run?.scenarios ?? []) {
    if (s.status !== "passed" && s.status !== "failed") {
      reach.notRun.add(s.id);
      continue;
    }
    const reached =
      s.status === "passed" || !isUnreachable(s.failure?.message ?? "");
    for (const t of s.touches) {
      reach.ran.add(t.item);
      if (s.status === "passed") reach.passed.add(t.item);
      else if (reached) reach.failedThere.add(t.item);
    }
  }
  return reach;
}

/** Why an item that scenarios reach is still not checked in an env: none of them runs there, the ones there verify only part of what it must prove, or they were skipped. */
type Unchecked = "elsewhere" | "partial" | "skipped";

function uncheckedKind(i: CoverageItem, r: Reach): Unchecked | undefined {
  if (i.scenarios.length === 0) return undefined;
  if (r.ran.has(i.id)) return "partial";
  if (i.scenarios.some((id) => r.notRun.has(id))) return "skipped";
  return "elsewhere";
}

const CODE = {
  passing: "3",
  failing: "2",
  planned: "1",
  uncovered: "0",
} as const;
const UNCHECKED_CODE: Record<Unchecked, string> = {
  elsewhere: "5",
  partial: "6",
  skipped: "7",
};

/**
 * One item in one env as history.json spells it: - not there, 0 no scenario, 1 planned, 2 failing, 3 verified,
 * 4 verified only by steps before a later step failed, and not checked here: 5 no scenario that reaches it runs
 * here, 6 the ones here verify only part of what it must prove, 7 they were skipped, 8 the scenarios that failed
 * on it could not reach the env.
 */
function cellCode(i: CoverageItem, e: Env, r: Reach): string {
  if (!i.envs.includes(e)) return "-";
  const s = i.status[e] ?? "uncovered";
  if (s === "passing")
    return i.laterFailed?.[e] && !r.passed.has(i.id) ? "4" : "3";
  if (s === "failing" && !r.failedThere.has(i.id)) return "8";
  const why = s === "uncovered" ? uncheckedKind(i, r) : undefined;
  return why ? UNCHECKED_CODE[why] : CODE[s];
}

const listed = (xs: string[], last = "and") =>
  xs.length <= 1
    ? (xs[0] ?? "")
    : `${xs.slice(0, -1).join(", ")} ${last} ${xs[xs.length - 1]}`;

/** What a rule that leaves scenarios out of an env does, said of one scenario, of several, and as a short clause. The tag labels come from the config. */
function leftOutPhrase(kind: LeftOut, env: Env) {
  const label = envConfig(env).label;
  if (kind.kind === "fixture")
    return {
      one: `creates a fixture, which ${label} runs never do`,
      many: `create a fixture, which ${label} runs never do`,
      short: "creates a fixture",
    };
  if (kind.kind === "excluded") {
    const what = config().tagLabels[kind.tag] ?? `is tagged ${kind.tag}`;
    return {
      one: `${what}, which ${label} runs leave out`,
      many: `${what}, which ${label} runs leave out`,
      short: what,
    };
  }
  if (kind.kind === "cadence")
    return {
      one: `is left for the ${kind.cadence} run`,
      many: `are left for the ${kind.cadence} run`,
      short: `is left for the ${kind.cadence} run`,
    };
  const pinned = kind.envs.map((e) => envConfig(e).label);
  return {
    one: `runs only on ${listed(pinned)}`,
    many: `run only on ${listed(pinned)}`,
    short: `runs only on ${listed(pinned)}`,
  };
}

const NEED_PHRASE: Record<string, string> = {
  success: "answers a valid request",
  "auth-refusal": "refuses a request without a token",
  "bad-token-refusal": "refuses a bad token",
  "session-refusal": "refuses a dashboard session token",
  "permission-refusal": "refuses a token without the permission",
};

/** What the reasons need from the runs: each env's merged run, the scenarios each env ever passed or failed, and each scenario's newest tags. */
interface ReasonContext {
  reach: Map<Env, Reach>;
  ranEver: Map<Env, Set<string>>;
  tags: Map<string, string[]>;
  /** Per env, whether its current runs (the newest ordinary one and the newest of each cadence) ran fixture scenarios. */
  runsFixtures: Map<Env, boolean>;
}

function reasonContext(runs: RunOnDisk[]): ReasonContext {
  const merged = mergedByEnv(runs);
  const ranEver = new Map<Env, Set<string>>(ENVS.map((e) => [e, new Set()]));
  const tags = new Map<string, string[]>();
  for (const r of runs)
    for (const s of r.run.scenarios) {
      tags.set(s.id, s.tags);
      if (s.status === "passed" || s.status === "failed")
        ranEver.get(r.env)!.add(s.id);
    }
  const fixtures = fixturesRun(runs);
  const runsFixtures = new Map(ENVS.map((e) => [e, fixtures(e)]));
  return {
    reach: new Map(
      ENVS.map((e) => [e, reachOf(merged.find((m) => m.env === e))]),
    ),
    ranEver,
    tags,
    runsFixtures,
  };
}

/** Why an item is not checked in an env, as one sentence: the runner's tag rules, the needs left unproved, or the skips. */
function uncheckedReason(
  i: CoverageItem,
  e: Env,
  why: Unchecked,
  needs: string[],
  ctx: ReasonContext,
): string {
  const reach = ctx.reach.get(e)!;
  const ranEver = ctx.ranEver.get(e)!;
  if (why === "partial") {
    const proven = i.proven?.[e] ?? [];
    const proved = [...proven, ...(i.alsoProven?.[e] ?? [])].flatMap(
      (n) => NEED_PHRASE[n] ?? [],
    );
    const missing = needs
      .filter((n) => !proven.includes(n))
      .flatMap((n) => NEED_PHRASE[n] ?? []);
    return proved.length && missing.length
      ? `Scenarios reach it on ${e} but verify only that it ${listed(proved)}, not that it ${listed(missing)}.`
      : `Scenarios reach it on ${e} but verify only part of what it must prove.`;
  }
  if (why === "skipped") {
    const skipped = i.scenarios.filter((id) => reach.notRun.has(id));
    const when = skipped.some((id) => ranEver.has(id))
      ? `the newest ${e} run`
      : `every ${e} run`;
    return skipped.length === 1
      ? `Its scenario was skipped in ${when}.`
      : `Its ${skipped.length} scenarios were skipped in ${when}.`;
  }
  const out = i.scenarios.map((id) =>
    leftOutBy(ctx.tags.get(id) ?? [], e, ctx.runsFixtures.get(e) ?? false),
  );
  const kinds = [
    ...new Map(
      out.flatMap((k) => (k ? [[JSON.stringify(k), k] as const] : [])),
    ).values(),
  ];
  const n = i.scenarios.length;
  if (kinds.length && out.every((k) => k)) {
    if (kinds.length > 1)
      return `None of its ${n} scenarios runs on ${e}: each one ${listed(
        kinds.map((k) => leftOutPhrase(k, e).short),
        "or",
      )}.`;
    const p = leftOutPhrase(kinds[0]!, e);
    return n === 1
      ? `Its scenario ${p.one}.`
      : `${n === 2 ? "Both its scenarios" : `All ${n} of its scenarios`} ${p.many}.`;
  }
  const applying = i.scenarios.filter((_, k) => !out[k]);
  const one = applying.length === 1;
  return applying.some((id) => ranEver.has(id))
    ? `${one ? "Its scenario runs" : "Its scenarios run"} on ${e} but ${one ? "does" : "do"} not reach it there.`
    : `${one ? "Its scenario has" : "Its scenarios have"} not run on ${e} yet.`;
}

/** A surface drawn as several islands, from the config: each takes the areas, planned scenario features and notes it names. */
interface IslandSpec {
  island: string;
  title: string;
  areas: string[];
  features: string[];
  notes: RegExp;
}

function splitOf(surface: SurfaceName): IslandSpec[] | undefined {
  const islands = surfaceConfig(surface)?.islands ?? [];
  return islands.length
    ? islands.map((i) => ({ ...i, notes: new RegExp(i.notes) }))
    : undefined;
}

/** The islands one surface is drawn as; areas no split names stay on an island named for the surface. */
function islandsOf(s: CoverageMap["surfaces"][number], map: CoverageMap) {
  const whole = {
    island: s.surface as string,
    surface: s.surface,
    title: surfaceConfig(s.surface)?.title ?? s.surface,
    areas: [] as string[],
    features: [] as string[],
    items: s.items,
    notes: s.notes,
    outOfScope: s.outOfScope,
  };
  const split = splitOf(s.surface);
  if (!split) return [whole];
  const own = map.items.filter((i) => i.surface === s.surface);
  const shared = (text: string) => !split.some((i) => i.notes.test(text));
  const islands = split.map((i) => ({
    island: i.island,
    surface: s.surface,
    title: i.title,
    areas: i.areas,
    features: i.features,
    items: own.filter((it) => i.areas.includes(it.area)).length,
    notes: s.notes.filter((n) => i.notes.test(n) || shared(n)),
    outOfScope: s.outOfScope.filter(
      (o) => i.notes.test(o.label) || shared(o.label),
    ),
  }));
  const named = new Set(split.flatMap((i) => i.areas));
  const rest = [
    ...new Set(own.filter((it) => !named.has(it.area)).map((it) => it.area)),
  ];
  return rest.length
    ? [
        ...islands,
        {
          ...whole,
          areas: rest,
          items: own.filter((it) => !named.has(it.area)).length,
        },
      ]
    : islands;
}

/** Where an item can be opened in a browser: a site page.s one address, or a page of a surface with a link host on each environment it runs in. Pages whose route takes a parameter have no address to give. */
export function itemLinks(
  item: { id: string; surface: SurfaceName; envs: Env[] },
  details?: Record<string, unknown>,
): { env?: Env; url: string }[] {
  const routeId = details?.["routeId"];
  const linkHost = surfaceConfig(item.surface)?.linkHost;
  if (linkHost && typeof routeId === "string") {
    if (Array.isArray(details?.["params"]) && details["params"].length)
      return [];
    return ENVS.filter((env) => item.envs.includes(env)).flatMap((env) => {
      const origin = envConfig(env).hosts[linkHost];
      return origin ? [{ env, url: origin + routeId }] : [];
    });
  }
  const url = details?.["url"];
  return typeof url === "string" && /^https?:\/\//.test(url) ? [{ url }] : [];
}

/** The edition a CLI command belongs to, in its own words ("Pro edition"); a part takes its command's. Two editions can carry the same command, and the panels tell them apart by it. */
function editionOf(
  files: SurfaceFile[],
  surface: SurfaceName,
  id: string,
): string | undefined {
  const own = files
    .find((f) => f.surface === surface)
    ?.items.find((x) => x.id === id);
  if (!own) return undefined;
  const title = own.details?.["editionTitle"];
  if (typeof title === "string" && title) return title;
  return own.parent ? editionOf(files, surface, own.parent) : undefined;
}

/** What kind of thing an item is, in product words, from the surface config: by details.kind, else by the id.s second segment, else the default. */
export function itemKind(
  id: string,
  details?: Record<string, unknown>,
): string {
  const [surface = "", second = ""] = id.split(":");
  const kinds = surfaceConfig(surface)?.kinds;
  if (!kinds) return "Item";
  const detail = details?.["kind"];
  return (
    (typeof detail === "string" ? kinds.byDetailKind[detail] : undefined) ??
    kinds.bySegment[second] ??
    kinds.default
  );
}

/** The kind words a surface uses for a page that holds elements, and for an element; "Page" and "Element" unless the config says otherwise. */
export function pageElementKinds(surface: string): {
  page: string;
  element: string;
} {
  const s = surfaceConfig(surface);
  return { page: s?.pageKind ?? "Page", element: s?.elementKind ?? "Element" };
}

const PAGE_FILE = /^src\/routes(.*)\/\+(page|layout)\.svelte$/;

/** The page an element sits on: the route whose file the surface builder saw it in, else its area's only page. */
export function pageOfElement(
  files: SurfaceFile[],
  item: { id: string; surface: string },
): string | undefined {
  const kinds = pageElementKinds(item.surface);
  if (itemKind(item.id) !== kinds.element) return undefined;
  const file = files.find((f) => f.surface === item.surface);
  const raw = file?.items.find((i) => i.id === item.id)?.details?.["files"];
  if (!Array.isArray(raw)) return undefined;
  for (const path of raw) {
    if (typeof path !== "string") continue;
    const m = PAGE_FILE.exec(path);
    if (!m) continue;
    const routeId = (m[1] || "/").replace(/\[([^\]=]+)=[^\]]+\]/g, "[$1]");
    const id = `${item.surface}:route:${routeId}`;
    if (file?.items.some((i) => i.id === id)) return id;
  }
  // A component the surface builder filed under one area belongs to that area's page when it has only one.
  const area = file?.items.find((i) => i.id === item.id)?.area;
  const pages =
    file?.items.filter(
      (i) => itemKind(i.id) === kinds.page && i.area === area,
    ) ?? [];
  return pages.length === 1 ? pages[0]!.id : undefined;
}

/** The component an element belongs to, as words, from the first source file the surface builder saw it in. */
export function componentOfElement(
  files: SurfaceFile[],
  item: { id: string; surface: string },
): string | undefined {
  if (itemKind(item.id) !== pageElementKinds(item.surface).element)
    return undefined;
  const file = files.find((f) => f.surface === item.surface);
  const raw = file?.items.find((i) => i.id === item.id)?.details?.["files"];
  const path = Array.isArray(raw)
    ? raw.find((p) => typeof p === "string")
    : undefined;
  if (typeof path !== "string") return undefined;
  const base = path
    .split("/")
    .pop()!
    .replace(/\.[a-z]+$/, "");
  if (base === "+page") return "Page";
  if (base === "+layout") return "Layout";
  const words = base.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function coverageFile(
  map: CoverageMap,
  files: SurfaceFile[],
  documentation: DocSource[] = [],
  runs: RunOnDisk[] = [],
): CoverageFile {
  const ctx = reasonContext(runs);
  return {
    builtAt: map.builtAt,
    envs: [...ENVS],
    surfaces: map.surfaces.flatMap((s) => islandsOf(s, map)),
    // READMEs and internal docs: not on the map, but a thing's panel names them beside the docs pages.
    documentation: documentation
      .map((d) => ({
        ...d,
        // A README's heading may open with an emoji or a badge; the panel wants the words.
        title: d.title.replace(/^[^\p{L}\p{N}]+/u, ""),
        documents: d.documents.filter((id) =>
          map.items.some((x) => x.id === id),
        ),
      }))
      .filter((d) => d.documents.length > 0),
    items: map.items.map((i) => {
      const own = files
        .find((f) => f.surface === i.surface)
        ?.items.find((x) => x.id === i.id);
      const kind = itemKind(i.id, own?.details);
      const elementKind = pageElementKinds(i.surface).element;
      // The surface builder.s parent wins; the file and area fallbacks place the rest.
      const page =
        kind === elementKind
          ? (own?.parent ?? pageOfElement(files, i))
          : undefined;
      const parent = kind === elementKind ? undefined : own?.parent;
      const component = componentOfElement(files, i);
      const rawUsedBy = own?.details?.["usedBy"];
      const usedBy = Array.isArray(rawUsedBy)
        ? rawUsedBy.filter((x): x is string => typeof x === "string")
        : [];
      // A docs page or control names what it documents; an API reference section at least its operation. Both ways on the panels.
      const op = own?.details?.["operation"];
      const rawDocs = own?.details?.["documents"];
      const documents = [
        ...new Set([
          ...(Array.isArray(rawDocs)
            ? rawDocs.filter((x): x is string => typeof x === "string")
            : []),
          ...(kind === "API reference section" && typeof op === "string"
            ? [`api:${op}`]
            : []),
        ]),
      ].filter((id) => map.items.some((x) => x.id === id));
      const links = itemLinks(i, own?.details);
      const edition = editionOf(files, i.surface, i.id);
      const rawNeeds = own?.details?.["coverageNeeds"];
      const needs = Array.isArray(rawNeeds)
        ? rawNeeds.filter((x): x is string => typeof x === "string")
        : [];
      const laterFailed: Partial<Record<Env, string[]>> = {};
      const unchecked: Partial<Record<Env, string>> = {};
      for (const e of i.envs) {
        const reach = ctx.reach.get(e)!;
        if (cellCode(i, e, reach) === "4" && i.laterFailed?.[e])
          laterFailed[e] = i.laterFailed[e];
        const why =
          i.status[e] === "uncovered" ? uncheckedKind(i, reach) : undefined;
        if (why)
          unchecked[e] = uncheckedReason(
            i,
            e,
            why,
            needs.length ? needs : [""],
            ctx,
          );
      }
      return {
        id: i.id,
        label: i.label,
        surface: i.surface,
        area: i.area,
        envs: i.envs,
        status: i.status,
        kind,
        ...(Object.keys(laterFailed).length ? { laterFailed } : {}),
        ...(Object.keys(unchecked).length ? { unchecked } : {}),
        ...(parent ? { parent } : {}),
        ...(page ? { page } : {}),
        ...(usedBy.length ? { usedBy } : {}),
        ...(documents.length ? { documents } : {}),
        ...(links.length ? { links } : {}),
        ...(edition ? { edition } : {}),
        ...(needs.length ? { needs } : {}),
        ...(component ? { component } : {}),
      };
    }),
  };
}

/** data/journeys.json: personas, and journeys with their stations resolved to item ids. */
export function journeysFile(
  personas: Persona[],
  resolved: JourneyResolution,
  commit: string,
): JourneysFile {
  return {
    commit,
    coverageMapBuiltAt: resolved.coverageMapBuiltAt,
    personas,
    stations: resolved.stations.map((s) => ({
      key: s.key,
      name: s.name,
      stage: s.stage,
      kind: s.kind,
      items: s.items,
    })),
    journeys: resolved.journeys,
    orphans: resolved.orphans,
    broken: resolved.broken,
    deadMatchers: resolved.deadMatchers,
  };
}

/** A planned scenario's description up to its first step, where "Waiting on:" lives. */
function waitingOn(root: string, id: string): string {
  const m = /^(.*):(\d+)$/.exec(id);
  const path = m?.[1] && join(root, m[1]);
  if (!m || !path || !existsSync(path)) return "";
  const text: string[] = [];
  for (const ln of readFileSync(path, "utf8").split("\n").slice(Number(m[2]))) {
    const t = ln.trim();
    if (!t || /^(Given|When|Then|And|But|\*)\b/.test(t)) break;
    text.push(t);
  }
  return text.join(" ");
}

function statusString(map: CoverageMap, merged: RunResult[]): string {
  const reach = new Map(
    ENVS.map((e) => [e, reachOf(merged.find((m) => m.env === e))]),
  );
  return map.items
    .map((i) => ENVS.map((e) => cellCode(i, e, reach.get(e)!)).join(""))
    .join("");
}

/**
 * data/history.json: the coverage map after each timeline point, rebuilt with the coverage map's own merge rules,
 * plus every scenario any run recorded and the planned scenarios the current runs list.
 */
export function historyFile(
  root: string,
  files: SurfaceFile[],
  runs: RunOnDisk[],
  commit: string,
  builtAt: string,
) {
  const scenarioIndex = new Map<string, number>();
  const scenarios: {
    id: string;
    name: string;
    feature: string;
    /** Some run recorded which step each touch came from. */
    stepped?: true;
  }[] = [];
  const itemScenarios = new Map<string, Set<number>>();
  const itemSteps = new Map<string, Map<number, Set<number>>>();
  const itemNeeds = new Map<string, Map<number, Set<string>>>();
  for (const r of runs) {
    for (const s of r.run.scenarios) {
      let idx = scenarioIndex.get(s.id);
      if (idx === undefined) {
        idx = scenarios.length;
        scenarioIndex.set(s.id, idx);
        scenarios.push({ id: s.id, name: s.name, feature: s.feature });
      } else
        Object.assign(scenarios[idx]!, { name: s.name, feature: s.feature });
      for (const t of s.touches) {
        const set = itemScenarios.get(t.item) ?? new Set<number>();
        set.add(idx);
        itemScenarios.set(t.item, set);
        if (t.need) {
          const by = itemNeeds.get(t.item) ?? new Map<number, Set<string>>();
          const needs = by.get(idx) ?? new Set<string>();
          needs.add(t.need);
          by.set(idx, needs);
          itemNeeds.set(t.item, by);
        }
        if (typeof t.step === "number") {
          scenarios[idx]!.stepped = true;
          const by = itemSteps.get(t.item) ?? new Map<number, Set<number>>();
          const steps = by.get(idx) ?? new Set<number>();
          steps.add(t.step);
          by.set(idx, steps);
          itemSteps.set(t.item, by);
        }
      }
    }
  }

  const current = (upTo: RunOnDisk[]) =>
    [...currentByEnv(upTo).values()].flat();
  const runsFixtures = fixturesRun(runs);

  /** The envs a scheduled run would run a planned scenario in, by the runner.s tag rules. */
  const plannedEnvs = (tags: string[]): Env[] =>
    envsForTags(tags, runsFixtures);

  const plannedNow = new Map<string, PlannedScenario>();
  for (const r of current(runs))
    for (const p of r.planned) plannedNow.set(p.id, p);
  const planned = [...plannedNow.values()]
    .flatMap((p) => {
      const surface = surfaceOfScenarioId(
        p.id,
        config().surfaces.map((s) => s.name),
        config().paths.features,
      );
      return surface
        ? [
            {
              id: p.id,
              name: p.name,
              feature: p.feature,
              surface,
              envs: plannedEnvs(p.tags),
              waitingOn: waitingOn(root, p.id),
            },
          ]
        : [];
    })
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));

  const snapshots = historyPoints(runs).map((point) => {
    const upTo = runs.filter((r) => r.run.finishedAt <= point.run.finishedAt);
    const merged = mergedByEnv(upTo);
    const map = buildCoverage(files, point.run.finishedAt, {
      runs: merged,
      planned: [],
    });
    const byEnv = new Map(
      merged.map((m) => [
        m.env,
        new Map(m.scenarios.map((s) => [s.id, s.status])),
      ]),
    );
    const scen = scenarios
      .map((s) =>
        ENVS.map((e) => {
          const status = byEnv.get(e)?.get(s.id);
          return status === "passed"
            ? "p"
            : status === "failed"
              ? "f"
              : status
                ? "o"
                : "-";
        }).join(""),
      )
      .join("");
    const plannedThen = new Set(
      current(upTo).flatMap((r) => r.planned.map((p) => p.id)),
    );
    const ran = point.run.scenarios;
    const ranIn = (e: Env) => upTo.filter((r) => r.env === e).length;
    return {
      at: point.run.finishedAt,
      env: point.env,
      runId: point.id,
      ran: {
        scenarios: ran.length,
        passed: ran.filter((s) => s.status === "passed").length,
        failed: ran.filter((s) => s.status === "failed").length,
      },
      runs: Object.fromEntries(ENVS.map((e) => [e, ranIn(e)])),
      status: statusString(map, merged),
      scen,
      planned: planned.map((p) => (plannedThen.has(p.id) ? "1" : "0")).join(""),
    };
  });

  const file: HistoryFile = {
    builtAt,
    scenariosCommit: /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    envs: [...ENVS],
    itemCount: files.reduce((n, f) => n + f.items.length, 0),
    scenarios,
    itemNeeds: Object.fromEntries(
      [...itemNeeds].map(([id, by]) => [
        id,
        Object.fromEntries(
          [...by].map(([sIdx, needs]) => [sIdx, [...needs].sort()]),
        ),
      ]),
    ),
    itemSteps: Object.fromEntries(
      [...itemSteps].map(([id, by]) => [
        id,
        Object.fromEntries(
          [...by].map(([sIdx, steps]) => [
            sIdx,
            [...steps].sort((a, b) => a - b),
          ]),
        ),
      ]),
    ),
    itemScenarios: Object.fromEntries(
      [...itemScenarios].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]),
    ),
    planned,
    snapshots,
  };
  return file;
}

export type { BoardEntry, BoardFile } from "@flax/contract";
import type { BoardEntry } from "@flax/contract";

/** One GraphQL query reading whether each board issue is still open. */
export function boardQuery(entries: BoardEntry[]): string {
  const fields = entries.map((e, i) => {
    const m = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(e.url);
    if (!m) throw new Error(`not an issue url: ${e.url}`);
    return `i${i}: repository(owner: ${JSON.stringify(m[1])}, name: ${JSON.stringify(m[2])}) { issue(number: ${m[3]}) { state } }`;
  });
  return `{ ${fields.join(" ")} }`;
}
