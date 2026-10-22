import {
  USE_CLASSES,
  type ItemUsage,
  type ItemUsageLive,
  type UsageClass,
  type UsageFile,
  type UsageLive,
  type UsageLiveClass,
  type UseClass,
} from "@flax/contract";
import {
  CONFIG,
  ENVS,
  envLabel,
  formatPacific,
  formatPacificDay,
  type Env,
  type Item,
} from "./data.ts";
import type { Verdict } from "./verdict.ts";

/** Whether flax.yml turns the usage view on; without it nothing on the page mentions use. */
export const USAGE_ON = CONFIG.usage !== null;
/** The environment the use comes from. */
export const USE_ENV: Env = CONFIG.usage?.env ?? ENVS[0] ?? "";
const USE_ENV_LABEL = envLabel(USE_ENV);

export const CLASS_WORDS: Record<UseClass, string> = CONFIG.usage?.labels ?? {
  outside: "from outside",
  internal: "our team",
  runs: "our runs",
};
const ORG = CONFIG.usage?.org ?? { one: "organization", many: "organizations" };

/** A hex pulses while its newest request is at most this old. */
export const PULSE_MS = 10 * 60_000;

/** What a pulsing hex means, per class. */
export const PULSE_WORDS: Record<UseClass, string> = {
  outside: `Used on ${USE_ENV_LABEL} in the last ${PULSE_MS / 60_000} minutes, ${CLASS_WORDS.outside}`,
  internal: `Used on ${USE_ENV_LABEL} in the last ${PULSE_MS / 60_000} minutes by ${CLASS_WORDS.internal}`,
  runs: `Used on ${USE_ENV_LABEL} in the last ${PULSE_MS / 60_000} minutes by ${CLASS_WORDS.runs}`,
};

/** One class's use of an item: the live stream's last 24 hours when it saw any, else the history. */
export interface ClassUse {
  orgs: number;
  n: number;
  span: "day" | "month";
  /** The newest request, from the live stream. */
  last?: string;
  /** The newest day used, from the history. */
  lastDay?: string;
}
export type ItemUse = Partial<Record<UseClass, ClassUse>>;

const SPAN_WORDS = {
  day: "in the last 24 hours",
  month: "in 30 days",
} as const;

function classUse(
  days: UsageClass | undefined,
  live: UsageLiveClass | undefined,
): ClassUse | undefined {
  if (live && live.n24h + live.orgs > 0)
    return {
      orgs: live.orgs,
      n: live.n24h,
      span: "day",
      last: live.last,
      ...(days ? { lastDay: days.lastDay } : {}),
    };
  if (days && days.n > 0)
    return {
      orgs: days.orgs,
      n: days.n,
      span: "month",
      lastDay: days.lastDay,
      ...(live ? { last: live.last } : {}),
    };
  if (live) return { orgs: 0, n: 0, span: "day", last: live.last };
  return undefined;
}

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: CONFIG.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayOf = (ms: number) => dayFormat.format(new Date(ms));

/** "3 minutes ago", or the time in the workspace's timezone once it is an hour old. */
export function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (ms < 60_000) return "less than a minute ago";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60)
    return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  return `at ${formatPacific(iso)}`;
}

function lastWords(u: ClassUse, now: number): string {
  if (u.last) return ago(u.last, now);
  if (!u.lastDay) return "";
  if (u.lastDay === dayOf(now)) return "today";
  if (u.lastDay === dayOf(now - 86_400_000)) return "yesterday";
  return `on ${formatPacificDay(`${u.lastDay}T12:00:00Z`)}`;
}

const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) =>
  `${num(n)} ${n === 1 ? one : many}`;
const orgs = (n: number) => plural(n, ORG.one, ORG.many);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** How often, in words: on a surface that counts requests, the requests; elsewhere its uses. */
function often(n: number, requests: boolean): string {
  if (requests) return plural(n, "request");
  return n === 1 ? "once" : `${num(n)} times`;
}

/** The part of the line about outside use. */
function outsidePart(u: ClassUse, now: number): string {
  const span = u.span === "month" ? ` ${SPAN_WORDS.month}` : "";
  const who =
    u.orgs > 0
      ? `${orgs(u.orgs)} ${CLASS_WORDS.outside}${span}`
      : `${plural(u.n, "request")} with no ${ORG.one}, ${CLASS_WORDS.outside}${span}`;
  const last = lastWords(u, now);
  return last ? `${who}, last ${last}` : who;
}

/** Who used an item, for a list row: "Used by 1 organization from outside, our team and our runs." */
export function usedBy(use: ItemUse): string {
  const who: string[] = [];
  if (use.outside)
    who.push(
      use.outside.orgs > 0
        ? `${orgs(use.outside.orgs)} ${CLASS_WORDS.outside}`
        : `requests with no ${ORG.one}`,
    );
  if (use.internal?.n) who.push(CLASS_WORDS.internal);
  if (use.runs?.n) who.push(CLASS_WORDS.runs);
  if (!who.length) return "";
  const last = who.pop()!;
  return `Used by ${who.length ? `${who.join(", ")} and ${last}` : last}.`;
}

/** "Use on Live: 2 organizations from outside, last 3 minutes ago; our team 14 times in the last 24 hours." */
export function useLine(
  use: ItemUse,
  now: number,
  requests = false,
): string | undefined {
  const parts: string[] = [];
  if (use.outside) parts.push(outsidePart(use.outside, now));
  for (const cls of ["internal", "runs"] as const) {
    const u = use[cls];
    if (u && u.n > 0)
      parts.push(
        `${CLASS_WORDS[cls]} ${often(u.n, requests)} ${SPAN_WORDS[u.span]}`,
      );
  }
  return parts.length
    ? `Use on ${USE_ENV_LABEL}: ${parts.join("; ")}.`
    : undefined;
}

/** A feature's line, over its items: organizations as the most on any one item, and how many items each class used. */
export function featureUseLine(
  uses: ItemUse[],
  now: number,
): string | undefined {
  const parts: string[] = [];
  const outside = uses.flatMap((u) => (u.outside ? [u.outside] : []));
  if (outside.length) {
    const most = Math.max(...outside.map((u) => u.orgs));
    const newest = outside.reduce<string | undefined>(
      (a, u) => (u.last && (!a || u.last > a) ? u.last : a),
      undefined,
    );
    const lastDay = outside.reduce<string | undefined>(
      (a, u) => (u.lastDay && (!a || u.lastDay > a) ? u.lastDay : a),
      undefined,
    );
    const live = outside.some((u) => u.span === "day");
    const who =
      most > 0
        ? `${outside.length > 1 ? "at least " : ""}${orgs(most)} ${CLASS_WORDS.outside}`
        : `requests with no ${ORG.one}, ${CLASS_WORDS.outside},`;
    const last = lastWords(
      {
        orgs: most,
        n: 0,
        span: live ? "day" : "month",
        ...(newest ? { last: newest } : {}),
        ...(lastDay ? { lastDay } : {}),
      },
      now,
    );
    parts.push(
      `${who} used ${outside.length} of its items ${live ? SPAN_WORDS.day : SPAN_WORDS.month}${last ? `, last ${last}` : ""}`,
    );
  }
  for (const cls of ["internal", "runs"] as const) {
    const used = uses.flatMap((u) => {
      const c = u[cls];
      return c && c.n > 0 ? [c] : [];
    });
    if (!used.length) continue;
    const live = used.some((u) => u.span === "day");
    const counted = live ? used.filter((u) => u.span === "day") : used;
    parts.push(
      `${CLASS_WORDS[cls]} used ${counted.length} of its items ${live ? SPAN_WORDS.day : SPAN_WORDS.month}`,
    );
  }
  return parts.length
    ? `Use on ${USE_ENV_LABEL}: ${parts.join("; ")}.`
    : undefined;
}

/** The class a hex pulses for: the first class, in contract order, with a request in the last few minutes. */
export function pulseClass(
  live: UsageLive | null,
  id: string,
  now: number,
): UseClass | undefined {
  const it: ItemUsageLive | undefined = live?.items[id];
  if (!it) return undefined;
  return USE_CLASSES.find((c) => {
    const l = it[c];
    return l !== undefined && now - Date.parse(l.last) <= PULSE_MS;
  });
}

/** The Now door's headings and leads, in the workspace's words. */
export const USE_WORDS = {
  usedHeading: `Used on ${USE_ENV_LABEL}, not verified on ${USE_ENV_LABEL}`,
  usedLead: (count: string, one: boolean) =>
    `${cap(CLASS_WORDS.internal)} or ${ORG.many} ${CLASS_WORDS.outside} used ${count} on ${USE_ENV_LABEL} that ${one ? "is" : "are"} not verified there.`,
  allVerified: `Everything used on ${USE_ENV_LABEL} is verified there.`,
  reachedHeading: `Reached by ${CLASS_WORDS.runs} on ${USE_ENV_LABEL}`,
  reachedLead: (count: string, one: boolean) =>
    `${cap(CLASS_WORDS.runs)} reached ${count} on ${USE_ENV_LABEL} that ${one ? "is" : "are"} not verified there. Reaching an item is not verifying it.`,
  envLabel: USE_ENV_LABEL,
};

export interface UseRow {
  item: Item;
  use: ItemUse;
  verdict: Verdict;
  orgs: number;
  requests: number;
}

/** Use against the map's items, from the build's history and the service's live stream. */
export function usageModel(
  items: Item[],
  file: UsageFile | null,
  verdict: (it: Item, env: Env, snap: number) => Verdict,
) {
  const real = items.filter((it) => !it.planned);
  const requestSurfaces = new Set(CONFIG.usage?.requestSurfaces ?? []);

  function useOf(it: Item, live: UsageLive | null): ItemUse {
    const days: ItemUsage | undefined = file?.items[it.id];
    const now = live?.items[it.id];
    const out: ItemUse = {};
    for (const c of USE_CLASSES) {
      const u = classUse(days?.[c], now?.[c]);
      if (u) out[c] = u;
    }
    return out;
  }

  const lineOf = (it: Item, live: UsageLive | null, now: number) =>
    useLine(useOf(it, live), now, requestSurfaces.has(it.surface));

  const featureLine = (its: Item[], live: UsageLive | null, now: number) =>
    featureUseLine(
      its.map((it) => useOf(it, live)),
      now,
    );

  /** Which hexes pulse, by item idx, and for which class. */
  function pulses(live: UsageLive | null, now: number): Map<number, UseClass> {
    const out = new Map<number, UseClass>();
    if (!live) return out;
    for (const it of real) {
      const c = pulseClass(live, it.id, now);
      if (c) out.set(it.idx, c);
    }
    return out;
  }

  const ranked = (rows: UseRow[]) =>
    rows.sort(
      (a, b) =>
        b.orgs - a.orgs ||
        b.requests - a.requests ||
        a.item.label.localeCompare(b.item.label),
    );

  /** Items used from outside or by our own people whose verdict in the use's env is not Verified, most organizations first, then most requests. */
  function usedNotVerified(snap: number, live: UsageLive | null): UseRow[] {
    const rows: UseRow[] = [];
    for (const it of real) {
      const use = useOf(it, live);
      if (!use.outside && !use.internal) continue;
      const v = verdict(it, USE_ENV, snap);
      if (v.state === "verified") continue;
      rows.push({
        item: it,
        use,
        verdict: v,
        orgs: (use.outside?.orgs ?? 0) + (use.internal?.orgs ?? 0),
        requests: (use.outside?.n ?? 0) + (use.internal?.n ?? 0),
      });
    }
    return ranked(rows);
  }

  /** Items our own scenario runs reached that no scenario verifies there, most requests first. */
  function reachedByOurRuns(snap: number, live: UsageLive | null): UseRow[] {
    const rows: UseRow[] = [];
    for (const it of real) {
      const use = useOf(it, live);
      const ours = use.runs;
      if (!ours || ours.n === 0) continue;
      const v = verdict(it, USE_ENV, snap);
      if (v.state === "verified") continue;
      rows.push({ item: it, use, verdict: v, orgs: 0, requests: ours.n });
    }
    return ranked(rows);
  }

  return {
    usage: file,
    useOf,
    lineOf,
    featureLine,
    pulses,
    usedNotVerified,
    reachedByOurRuns,
  };
}

export type UsageModel = ReturnType<typeof usageModel>;
