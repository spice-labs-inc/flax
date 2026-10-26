import { type UsageFile } from "@flax/contract";
/** The day a moment falls on in a timezone, as YYYY-MM-DD. */
export declare function dayIn(ms: number, timeZone: string): string;
/** The `count` days, oldest first, that end with the day of `ms` in a timezone. */
export declare function daysEnding(ms: number, count: number, timeZone: string): string[];
/**
 * usage.json from a usage history: per item and class, the organizations as a count, the requests, the
 * requests on the history's last day and the last day used. Keys the map has no item for stay counted
 * under their own key and are named in `unmapped`, so the build log can list them.
 */
export declare function usageFile(raw: unknown, itemIds: readonly string[], envs: readonly string[], timeZone: string): UsageFile;
