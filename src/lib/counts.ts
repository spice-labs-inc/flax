import {
  ENVS,
  ENV_LABEL,
  ENV_ORDER,
  singleHome,
  type CellNote,
  type CoverageModel,
  type Env,
  type EnvChoice,
  type Item,
  byEnv,
  CONFIG,
  REFERENCE_ENV,
} from "./data.ts";
import type { StationState } from "./personas.ts";

/** What the counts read from the coverage model. */
export type CountSource = Pick<CoverageModel, "status" | "cellNote" | "LATEST">;

/** How many items of a list stand in each state in one env; planned scenarios and open issues are not items to verify yet. */
export interface ItemCount {
  env: Env;
  verified: number;
  failing: number;
  unchecked: number;
  none: number;
  planned: number;
  /** Items that exist in this env. */
  total: number;
  /** Items that do not exist in this env at all. */
  absent: number;
}

export function countItems(
  src: CountSource,
  list: readonly Item[],
  snap: number,
  env: Env,
): ItemCount {
  const c: ItemCount = {
    env,
    verified: 0,
    failing: 0,
    unchecked: 0,
    none: 0,
    planned: 0,
    total: 0,
    absent: 0,
  };
  const ei = ENVS.indexOf(env);
  const rows = src.status[snap]!;
  for (const it of list) {
    if (it.planned) continue;
    const code = rows[it.idx]![ei]!;
    if (code === -1) {
      c.absent++;
      continue;
    }
    c.total++;
    if (code === 3) c.verified++;
    else if (code === 2) c.failing++;
    else if (code === -2) c.unchecked++;
    else if (code === 1) c.planned++;
    else c.none++;
  }
  return c;
}

/** Every env's count of a list, by env. */
export function countByEnv(
  src: CountSource,
  list: readonly Item[],
  snap: number,
): Record<Env, ItemCount> {
  return byEnv((e) => countItems(src, list, snap, e));
}

/** The env a headline leads with: the one chosen, else the reference env, else the first env nearest it the things exist in. */
export function leadEnv(has: (env: Env) => boolean, env: EnvChoice): Env {
  if (env !== "all") return env;
  return ENV_ORDER.find(has) ?? REFERENCE_ENV;
}

const onEnv = (env: Env) => `on ${ENV_LABEL[env].toLowerCase()}`;

/** "159 of 312 items verified on live"; a website names no env, since it has one home. */
export function verifiedText(
  c: ItemCount,
  noun: [string, string] = ["item", "items"],
  where = true,
): string {
  const n = c.total === 1 ? noun[0] : noun[1];
  return `${c.verified} of ${c.total} ${n} verified${where ? ` ${onEnv(c.env)}` : ""}`;
}

/**
 * The short count an island label, a surface row and a part list carry, reference env first: "2 of 86 verified on live,
 * 84 not checked there"; brief, for the map, it leaves out the not-checked clause. Not in the lead env at all, it names
 * the nearest env it is in.
 */
export function shortCount(
  src: CountSource,
  list: readonly Item[],
  snap: number,
  env: EnvChoice,
  brief = false,
): string {
  const real = list.filter((it) => !it.planned);
  const by = countByEnv(src, real, snap);
  const lead = leadEnv((e) => by[e].total > 0, env);
  const c = by[lead];
  const where = !real.length || !real.every(singleHome);
  if (c.total === 0) return `Not ${onEnv(lead)}`;
  const head = `${c.verified} of ${c.total} verified${where ? ` ${onEnv(lead)}` : ""}`;
  if (c.failing) return `${head}, ${c.failing} failing`;
  if (c.unchecked && !brief) return `${head}, ${c.unchecked} not checked there`;
  return head;
}

/** Why items are not checked in an env, grouped by the rule or gap behind it. */
export type UncheckedKind =
  | "fixture"
  | "admin"
  | "pinned"
  | "partial"
  | "skipped"
  | "not-yet"
  | "unreached"
  | "elsewhere";

/** The group an item's not-checked reason falls in: by the sentence the build wrote for it, else by its cell note. */
export function uncheckedKind(
  src: CountSource,
  it: Item,
  snap: number,
  env: Env,
): UncheckedKind {
  const ei = ENVS.indexOf(env);
  const note: CellNote | undefined = src.cellNote(it, snap, ei);
  if (note === "partial") return "partial";
  if (note === "skipped") return "skipped";
  const said =
    src.cellNote(it, src.LATEST, ei) === note ? it.unchecked?.[env] : undefined;
  if (!said) return "elsewhere";
  if (/creates? a fixture/.test(said)) return "fixture";
  if (/which has no .* site/.test(said)) return "admin";
  if (/runs? only on/.test(said)) return "pinned";
  if (/not run on .* yet/.test(said)) return "not-yet";
  if (/not reach it/.test(said)) return "unreached";
  return "elsewhere";
}

/** The surfaces the config says have no deployment in an env, named for a reason: "Admin" or "Admin and Billing". */
function absentSurfaces(env: Env): string {
  const titles = CONFIG.surfaces
    .filter((s) => s.envs.length > 0 && !s.envs.includes(env))
    .map((s) => s.title);
  return titles.length ? envsProseOf(titles) : "another surface";
}
function envsProseOf(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A group of items not checked in an env, as a sentence that counts them. */
export function uncheckedSentence(
  kind: UncheckedKind,
  n: number,
  env: Env,
): string {
  const e = ENV_LABEL[env].toLowerCase();
  const one = n === 1;
  const have = one ? "has" : "have";
  switch (kind) {
    case "fixture":
      return `${n} ${have} only scenarios that create a fixture, which ${e} runs never do.`;
    case "admin":
      return `${n} ${have} only scenarios that use ${absentSurfaces(env)}, which ${e} has no site for.`;
    case "pinned":
      return `${n} ${have} only scenarios pinned to other environments.`;
    case "partial":
      return `${n} ${one ? "is" : "are"} reached on ${e}, but ${one ? "its" : "their"} scenarios there verify only part of what ${one ? "it" : "each"} must prove.`;
    case "skipped":
      return `${n} ${have} scenarios that were skipped on ${e}.`;
    case "not-yet":
      return `${n} ${have} scenarios that have not run on ${e} yet.`;
    case "unreached":
      return `${n} ${have} scenarios that run on ${e} but do not reach ${one ? "it" : "them"} there.`;
    case "elsewhere":
      return `${n} ${have} scenarios, but none that reaches ${one ? "it" : "them"} runs on ${e}.`;
  }
}

/** The same reason said of one station: "Its scenarios create a fixture, which Live runs never do." */
export function stationUncheckedSentence(
  kind: UncheckedKind,
  env: Env,
): string {
  const e = ENV_LABEL[env].toLowerCase();
  switch (kind) {
    case "fixture":
      return `Its scenarios create a fixture, which ${e} runs never do.`;
    case "admin":
      return `Its scenarios use ${absentSurfaces(env)}, which ${e} has no site for.`;
    case "pinned":
      return "Its scenarios are pinned to other environments.";
    case "partial":
      return `Scenarios reach it on ${e} but verify only part of what it must prove.`;
    case "skipped":
      return `Its scenarios were skipped on ${e}.`;
    case "not-yet":
      return `Its scenarios have not run on ${e} yet.`;
    case "unreached":
      return `Its scenarios run on ${e} but do not reach it there.`;
    case "elsewhere":
      return `No scenario that reaches it runs on ${e}.`;
  }
}

/** The items of a list not checked in an env, grouped by why, the biggest group first. */
export function uncheckedGroups(
  src: CountSource,
  list: readonly Item[],
  snap: number,
  env: Env,
): { kind: UncheckedKind; n: number }[] {
  const ei = ENVS.indexOf(env);
  const by = new Map<UncheckedKind, number>();
  for (const it of list) {
    if (it.planned || src.status[snap]![it.idx]![ei] !== -2) continue;
    const k = uncheckedKind(src, it, snap, env);
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by].map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n);
}

/** A sentence under a headline; `under` sets it beneath the sentence before it that ends in a colon. */
export interface GapLine {
  text: string;
  under?: true;
}

/** What a headline says under its figure, as sentences: why the rest is not verified in the lead env. */
export function gapSentences(
  src: CountSource,
  list: readonly Item[],
  snap: number,
  c: ItemCount,
): GapLine[] {
  const out: GapLine[] = [];
  const say = (text: string) => out.push({ text });
  const e = ENV_LABEL[c.env].toLowerCase();
  if (c.failing)
    say(`${c.failing} ${c.failing === 1 ? "is" : "are"} failing on ${e}.`);
  if (c.unchecked) {
    say(
      `${c.unchecked} ${c.unchecked === 1 ? "is" : "are"} not checked on ${e}:`,
    );
    for (const g of uncheckedGroups(src, list, snap, c.env))
      out.push({ text: uncheckedSentence(g.kind, g.n, c.env), under: true });
  }
  if (c.none)
    say(`${c.none} ${c.none === 1 ? "has" : "have"} no scenario yet.`);
  if (c.planned)
    say(
      `${c.planned} ${c.planned === 1 ? "has" : "have"} only a planned scenario.`,
    );
  if (c.absent)
    say(
      `${c.absent} ${c.absent === 1 ? "item does" : "items do"} not exist on ${e} at all.`,
    );
  return out;
}

/** The other envs read as the pipeline beside the lead env: "Staging: 191 of 201 verified." */
export function pipelineSentences(by: Record<Env, ItemCount>, lead: Env) {
  return ENV_ORDER.filter((e) => e !== lead && by[e].total > 0).map((e) => {
    const c = by[e];
    return `${ENV_LABEL[e]}: ${c.verified} of ${c.total} verified${c.failing ? `, ${c.failing} failing` : ""}.`;
  });
}

/** How many of a journey's stations stand in each state in one env; stations that are not in that env do not count. */
export interface StationCount {
  env: Env;
  verified: number;
  failing: number;
  partial: number;
  unchecked: number;
  none: number;
  /** Behavior verified outside these runs (station kind elsewhere), not by these scenarios. */
  edition: number;
  /** Waiting on a feature not built. */
  waiting: number;
  total: number;
}

export function countStations(
  states: readonly StationState[],
  env: Env,
): StationCount {
  const c: StationCount = {
    env,
    verified: 0,
    failing: 0,
    partial: 0,
    unchecked: 0,
    none: 0,
    edition: 0,
    waiting: 0,
    total: 0,
  };
  for (const s of states) {
    if (s === "never") continue;
    c.total++;
    if (s === "pass") c.verified++;
    else if (s === "fail") c.failing++;
    else if (s === "partial") c.partial++;
    else if (s === "unchecked") c.unchecked++;
    else if (s === "elsewhere") c.edition++;
    else if (s === "planned") c.waiting++;
    else c.none++;
  }
  return c;
}

/** "4 of 7 stations verified on live"; with `where` false the env is left to the row that names it. */
export function stationsText(c: StationCount, where = true): string {
  if (c.total === 0) return `Not ${onEnv(c.env)}`;
  return `${c.verified} of ${c.total} ${c.total === 1 ? "station" : "stations"} verified${where ? ` ${onEnv(c.env)}` : ""}`;
}

/** A journey's count, then the rest by state: "3 of 25 stations verified on live", "13 partly", "8 not checked there". */
export function stationParts(c: StationCount): string[] {
  if (c.total === 0) return [stationsText(c)];
  const parts = [stationsText(c)];
  if (c.failing) parts.push(`${c.failing} failing`);
  if (c.partial) parts.push(`${c.partial} partly`);
  if (c.unchecked) parts.push(`${c.unchecked} not checked there`);
  if (c.none) parts.push(`${c.none} with no scenario yet`);
  if (c.waiting)
    parts.push(
      `${c.waiting} waiting on ${c.waiting === 1 ? "a feature" : "features"} not built`,
    );
  if (c.edition) parts.push(`${c.edition} verified elsewhere`);
  return parts;
}

/**
 * A journey's count as one sentence:
 * "3 of 25 stations verified on live, 13 partly, 8 not checked there, 1 with no scenario yet; nothing planned on the board."
 */
export function stationsSentence(c: StationCount, planned: number): string {
  if (c.total === 0) return `${stationsText(c)}.`;
  const board = planned
    ? `${planned} planned ${planned === 1 ? "feature" : "features"} on the board`
    : "nothing planned on the board";
  return `${stationParts(c).join(", ")}; ${board}.`;
}
