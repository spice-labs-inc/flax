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
export declare const USE_CLASSES: readonly ["outside", "internal", "runs"];
export type UseClass = (typeof USE_CLASSES)[number];
/** An organization as it leaves the relay: a salted hash in hex, never the raw id. */
export declare const ORG_HASH: RegExp;
/** Rows one body may carry. */
export declare const MAX_USAGE_ROWS = 100000;
/** Days the history covers, ending with the day it was generated in the workspace's timezone. */
export declare const USAGE_HISTORY_DAYS = 30;
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
export declare const USAGE_FILE = "usage.json";
export declare const isUseClass: (v: unknown) => v is UseClass;
/** Why a body is not a usage window for one of `envs`, or undefined when it is one. */
export declare function usageWindowProblem(v: unknown, envs: readonly string[]): string | undefined;
export declare function isUsageWindow(v: unknown, envs: readonly string[]): v is UsageWindow;
/** Why a body is not a usage history for one of `envs`, or undefined when it is one. */
export declare function usageHistoryProblem(v: unknown, envs: readonly string[]): string | undefined;
export declare function isUsageHistory(v: unknown, envs: readonly string[]): v is UsageHistory;
/** The live use in a `usage` event or a snapshot, or undefined when it is not that shape. */
export declare function usageLiveOf(v: unknown): UsageLive | undefined;
/** usage.json as the page reads it, or undefined when it is not that shape. */
export declare function usageFileOf(v: unknown): UsageFile | undefined;
