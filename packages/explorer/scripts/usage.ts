import {
  isUsageHistory,
  USAGE_HISTORY_DAYS,
  usageHistoryProblem,
  type ItemUsage,
  type UsageClass,
  type UsageFile,
} from "@flax/contract";

/** The day a moment falls on in a timezone, as YYYY-MM-DD. */
export function dayIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** The `count` days, oldest first, that end with the day of `ms` in a timezone. */
export function daysEnding(
  ms: number,
  count: number,
  timeZone: string,
): string[] {
  const [y, m, d] = dayIn(ms, timeZone).split("-").map(Number);
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(y!, m! - 1, d! - (count - 1 - i), 12))
      .toISOString()
      .slice(0, 10),
  );
}

/**
 * usage.json from a usage history: per item and class, the organizations as a count, the requests, the
 * requests on the history's last day and the last day used. Keys the map has no item for stay counted
 * under their own key and are named in `unmapped`, so the build log can list them.
 */
export function usageFile(
  raw: unknown,
  itemIds: readonly string[],
  envs: readonly string[],
  timeZone: string,
): UsageFile {
  if (!isUsageHistory(raw, envs))
    throw new Error(
      `the usage history is not the shape the explorer reads (${usageHistoryProblem(raw, envs)})`,
    );
  const at = Date.parse(raw.generatedAt);
  const today = dayIn(at, timeZone);
  const orgs = new Map<UsageClass, Set<string>>();
  const items: Record<string, ItemUsage> = {};
  for (const r of raw.days) {
    const use = ((items[r.item] ??= {})[r.cls] ??= {
      orgs: 0,
      n: 0,
      today: 0,
      lastDay: r.day,
    });
    const set = orgs.get(use) ?? new Set<string>();
    orgs.set(use, set);
    if (r.org) set.add(r.org);
    use.orgs = set.size;
    use.n += r.n;
    if (r.day === today) use.today += r.n;
    if (r.day > use.lastDay) use.lastDay = r.day;
  }
  const known = new Set(itemIds);
  return {
    env: raw.env,
    generatedAt: raw.generatedAt,
    firstDay: daysEnding(at, USAGE_HISTORY_DAYS, timeZone)[0]!,
    lastDay: today,
    items,
    unmapped: Object.keys(items)
      .filter((id) => !known.has(id))
      .sort(),
  };
}
