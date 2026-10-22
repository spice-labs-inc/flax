/**
 * How much each item on the map is really used, as a workspace's own relay sends it to the explorer
 * service and the page shows it. Only aggregates cross this contract: counts per item, class of use and
 * organization, where an organization is an opaque salted hash ({@link ORG_HASH}) that the page only
 * ever counts. The relay reads the product's own telemetry, decides each request's class, drops every
 * raw identity and posts two bodies with a bearer token:
 * - `POST /ingest/usage/live` ({@link UsageWindow}): one short window of requests, every minute or so;
 * - `POST /ingest/usage/history` ({@link UsageHistory}): the last 30 days, per day, every hour or so.
 * The service keeps 24 hours of windows and the newest history, streams {@link UsageLive} as the `usage`
 * event, and the data build turns the history into `usage.json` ({@link UsageFile}).
 */

/**
 * Who made a request: `outside` is anyone not marked as the organization's own; `internal` is its own
 * people; `runs` is its own scenario runs. The page names each with the labels from flax.yml.
 */
export const USE_CLASSES = ["outside", "internal", "runs"] as const;
export type UseClass = (typeof USE_CLASSES)[number];

/** An organization as it leaves the relay: a salted hash in hex, never the raw id. */
export const ORG_HASH = /^[0-9a-f]{8,64}$/;

/** Rows one body may carry. */
export const MAX_USAGE_ROWS = 100_000;

/** Days the history covers, ending with the day it was generated in the workspace's timezone. */
export const USAGE_HISTORY_DAYS = 30;

/** One window's requests for an item, class and organization; `last` is the newest request's time. */
export interface UsageWindowRow {
  item: string;
  cls: UseClass;
  org: string | null;
  n: number;
  last: string;
}

/** POST /ingest/usage/live: everything one window of requests held. A window sent again replaces the first. */
export interface UsageWindow {
  env: string;
  from: string;
  to: string;
  rows: UsageWindowRow[];
}

/** One day's requests for an item, class and organization; the day is in the workspace's timezone. */
export interface UsageDayRow {
  day: string;
  item: string;
  cls: UseClass;
  org: string | null;
  n: number;
}

/** POST /ingest/usage/history: the last {@link USAGE_HISTORY_DAYS} days. A newer history replaces the one before. */
export interface UsageHistory {
  env: string;
  generatedAt: string;
  days: UsageDayRow[];
}

/** One class's use of an item over the last 24 hours, as the service streams it. */
export interface UsageLiveClass {
  orgs: number;
  n24h: number;
  last: string;
}
export type ItemUsageLive = Partial<Record<UseClass, UsageLiveClass>>;

/** The `usage` event on /live/events, and `usage` in the snapshot and /live/state. */
export interface UsageLive {
  env: string;
  at: string;
  items: Record<string, ItemUsageLive>;
}

/** One class's use of an item over the history: organizations, requests, requests on the last day, and the last day used. */
export interface UsageClass {
  orgs: number;
  n: number;
  today: number;
  lastDay: string;
}
export type ItemUsage = Partial<Record<UseClass, UsageClass>>;

/** usage.json in the data files: the history by item, or null when there is none. */
export interface UsageFile {
  env: string;
  generatedAt: string;
  /** The window, as days (YYYY-MM-DD). */
  firstDay: string;
  lastDay: string;
  items: Record<string, ItemUsage>;
  /** Item keys the map has no item for; counted in `items` all the same. */
  unmapped: string[];
}

export const USAGE_FILE = "usage.json";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;
const isTime = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const isItem = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 400;
const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v);
const isOrg = (v: unknown): v is string | null =>
  v === null || (typeof v === "string" && ORG_HASH.test(v));

export const isUseClass = (v: unknown): v is UseClass =>
  USE_CLASSES.some((c) => c === v);

function envProblem(v: unknown, envs: readonly string[]): string | undefined {
  return typeof v === "string" && envs.includes(v)
    ? undefined
    : `env is not one of ${envs.join(", ")}`;
}

function rowsProblem(
  rows: unknown,
  name: string,
  ok: (r: Record<string, unknown>) => boolean,
  what: string,
): string | undefined {
  if (!Array.isArray(rows) || rows.length > MAX_USAGE_ROWS)
    return `${name} is not a list of at most ${MAX_USAGE_ROWS}`;
  const bad = rows.findIndex((r) => !isObj(r) || !ok(r));
  return bad >= 0 ? `${name} ${bad} is not ${what}` : undefined;
}

const usageKeys = (r: Record<string, unknown>) =>
  isItem(r["item"]) &&
  isUseClass(r["cls"]) &&
  isOrg(r["org"]) &&
  isCount(r["n"]);

/** Why a body is not a usage window for one of `envs`, or undefined when it is one. */
export function usageWindowProblem(
  v: unknown,
  envs: readonly string[],
): string | undefined {
  if (!isObj(v)) return "the body is not an object";
  const env = envProblem(v["env"], envs);
  if (env) return env;
  if (!isTime(v["from"]) || !isTime(v["to"]))
    return "from and to are not times";
  if (Date.parse(v["from"]) >= Date.parse(v["to"]))
    return "from is not before to";
  return rowsProblem(
    v["rows"],
    "rows",
    (r) => usageKeys(r) && isTime(r["last"]),
    "an item, class, organization hash, count and time",
  );
}

export function isUsageWindow(
  v: unknown,
  envs: readonly string[],
): v is UsageWindow {
  return usageWindowProblem(v, envs) === undefined;
}

/** Why a body is not a usage history for one of `envs`, or undefined when it is one. */
export function usageHistoryProblem(
  v: unknown,
  envs: readonly string[],
): string | undefined {
  if (!isObj(v)) return "the body is not an object";
  const env = envProblem(v["env"], envs);
  if (env) return env;
  if (!isTime(v["generatedAt"])) return "generatedAt is not a time";
  return rowsProblem(
    v["days"],
    "day row",
    (r) => usageKeys(r) && isDay(r["day"]),
    "a day, item, class, organization hash and count",
  );
}

export function isUsageHistory(
  v: unknown,
  envs: readonly string[],
): v is UsageHistory {
  return usageHistoryProblem(v, envs) === undefined;
}

function byClass<T>(
  v: unknown,
  ok: (x: unknown) => x is T,
): Partial<Record<UseClass, T>> | undefined {
  if (!isObj(v)) return undefined;
  const out: Partial<Record<UseClass, T>> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!isUseClass(k) || !ok(x)) return undefined;
    out[k] = x;
  }
  return out;
}

function itemsOf<T>(
  v: unknown,
  ok: (x: unknown) => x is T,
): Record<string, Partial<Record<UseClass, T>>> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, Partial<Record<UseClass, T>>> = {};
  for (const [id, x] of Object.entries(v)) {
    const c = byClass(x, ok);
    if (!c) return undefined;
    out[id] = c;
  }
  return out;
}

const isLiveClass = (v: unknown): v is UsageLiveClass =>
  isObj(v) && isCount(v["orgs"]) && isCount(v["n24h"]) && isTime(v["last"]);

const isUsageClass = (v: unknown): v is UsageClass =>
  isObj(v) &&
  isCount(v["orgs"]) &&
  isCount(v["n"]) &&
  isCount(v["today"]) &&
  isDay(v["lastDay"]);

/** The live use in a `usage` event or a snapshot, or undefined when it is not that shape. */
export function usageLiveOf(v: unknown): UsageLive | undefined {
  if (!isObj(v) || typeof v["env"] !== "string" || !isTime(v["at"]))
    return undefined;
  const items = itemsOf(v["items"], isLiveClass);
  return items ? { env: v["env"], at: v["at"], items } : undefined;
}

/** usage.json as the page reads it, or undefined when it is not that shape. */
export function usageFileOf(v: unknown): UsageFile | undefined {
  if (
    !isObj(v) ||
    typeof v["env"] !== "string" ||
    !isTime(v["generatedAt"]) ||
    !isDay(v["firstDay"]) ||
    !isDay(v["lastDay"])
  )
    return undefined;
  const items = itemsOf(v["items"], isUsageClass);
  const unmapped = v["unmapped"];
  if (
    !items ||
    !Array.isArray(unmapped) ||
    !unmapped.every((u) => typeof u === "string")
  )
    return undefined;
  return {
    env: v["env"],
    generatedAt: v["generatedAt"],
    firstDay: v["firstDay"],
    lastDay: v["lastDay"],
    items,
    unmapped,
  };
}
