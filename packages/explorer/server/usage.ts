import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isRecord,
  isUsageHistory,
  isUseClass,
  ORG_HASH,
  type ItemUsageLive,
  type UsageHistory,
  type UsageLive,
  type UsageLiveClass,
  type UsageWindow,
  type UsageWindowRow,
} from "@flax/contract";

export const LIVE_KEEP_MS = 24 * 3_600_000;

interface Window {
  from: number;
  to: number;
}

interface LiveRow extends UsageWindowRow {
  /** The end of the window that counted it, in epoch milliseconds. */
  to: number;
}

interface EnvLive {
  windows: Window[];
  rows: LiveRow[];
}

function windowOf(v: unknown): Window | undefined {
  return isRecord(v) &&
    typeof v["from"] === "number" &&
    typeof v["to"] === "number" &&
    v["from"] < v["to"]
    ? { from: v["from"], to: v["to"] }
    : undefined;
}

function liveRowOf(v: unknown): LiveRow | undefined {
  if (
    !isRecord(v) ||
    typeof v["item"] !== "string" ||
    !isUseClass(v["cls"]) ||
    !(
      v["org"] === null ||
      (typeof v["org"] === "string" && ORG_HASH.test(v["org"]))
    ) ||
    typeof v["n"] !== "number" ||
    typeof v["last"] !== "string" ||
    typeof v["to"] !== "number"
  )
    return undefined;
  return {
    item: v["item"],
    cls: v["cls"],
    org: v["org"],
    n: v["n"],
    last: v["last"],
    to: v["to"],
  };
}

/** Writes a file whole: beside it first, then renamed over it. */
function writeWhole(path: string, body: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

/** Windows that do not overlap, newest first: each next one ends where the one before it starts, or earlier. */
export function disjointWindows(windows: Window[]): Set<number> {
  const chosen = new Set<number>();
  let edge = Infinity;
  for (const w of [...windows].sort((a, b) => b.to - a.to))
    if (w.to <= edge) {
      chosen.add(w.to);
      edge = w.from;
    }
  return chosen;
}

/**
 * Use from a workspace's usage relay, in memory and under `<state>/usage/`: each live window's rows for
 * 24 hours, and the newest history per env, which the data build reads.
 */
export class UsageStore {
  readonly #dir: string;
  readonly #envs: readonly string[];
  readonly #live = new Map<string, EnvLive>();

  constructor(dir: string, envs: readonly string[], now: number) {
    this.#dir = dir;
    this.#envs = envs;
    mkdirSync(dir, { recursive: true });
    for (const env of envs) {
      const p = this.#livePath(env);
      if (!existsSync(p)) continue;
      try {
        const v: unknown = JSON.parse(readFileSync(p, "utf8"));
        if (!isRecord(v)) continue;
        const windows = Array.isArray(v["windows"])
          ? v["windows"].flatMap((w) => windowOf(w) ?? [])
          : [];
        const rows = Array.isArray(v["rows"])
          ? v["rows"].flatMap((r) => liveRowOf(r) ?? [])
          : [];
        this.#live.set(env, { windows, rows });
        this.#prune(env, now);
      } catch {
        continue;
      }
    }
  }

  get envs(): readonly string[] {
    return this.#envs;
  }

  #livePath(env: string): string {
    return join(this.#dir, `live-${env}.json`);
  }

  historyPath(env: string): string {
    return join(this.#dir, `history-${env}.json`);
  }

  #prune(env: string, now: number): void {
    const l = this.#live.get(env);
    if (!l) return;
    const floor = now - LIVE_KEEP_MS;
    l.windows = l.windows.filter((w) => w.to > floor);
    l.rows = l.rows.filter((r) => r.to > floor);
  }

  /** One window's rows replace whatever an earlier delivery of the same window gave. */
  ingestWindow(body: UsageWindow, now: number): UsageLive {
    const to = Date.parse(body.to);
    const from = Date.parse(body.from);
    const l = this.#live.get(body.env) ?? { windows: [], rows: [] };
    l.windows = [...l.windows.filter((w) => w.to !== to), { from, to }];
    l.rows = [
      ...l.rows.filter((r) => r.to !== to),
      ...body.rows.map((r) => ({
        ...r,
        last: new Date(Date.parse(r.last)).toISOString(),
        to,
      })),
    ];
    this.#live.set(body.env, l);
    this.#prune(body.env, now);
    writeWhole(this.#livePath(body.env), JSON.stringify(l));
    return this.summary(body.env, now);
  }

  ingestHistory(body: UsageHistory): void {
    writeWhole(this.historyPath(body.env), JSON.stringify(body));
  }

  /** The newest history an env has, or undefined before the first delivery. */
  history(env: string): UsageHistory | undefined {
    const p = this.historyPath(env);
    if (!existsSync(p)) return undefined;
    try {
      const v: unknown = JSON.parse(readFileSync(p, "utf8"));
      return isUsageHistory(v, this.#envs) ? v : undefined;
    } catch {
      return undefined;
    }
  }

  /** Per item and class over the last 24 hours: distinct organizations, requests counted once each, and the newest request. */
  summary(env: string, now: number): UsageLive {
    this.#prune(env, now);
    const l = this.#live.get(env) ?? { windows: [], rows: [] };
    const counted = disjointWindows(l.windows);
    const items: Record<string, ItemUsageLive> = {};
    const orgs = new Map<UsageLiveClass, Set<string>>();
    for (const r of l.rows) {
      const use = ((items[r.item] ??= {})[r.cls] ??= {
        orgs: 0,
        n24h: 0,
        last: r.last,
      });
      const set = orgs.get(use) ?? new Set<string>();
      orgs.set(use, set);
      if (r.org) set.add(r.org);
      use.orgs = set.size;
      if (counted.has(r.to)) use.n24h += r.n;
      if (r.last > use.last) use.last = r.last;
    }
    return { env, at: new Date(now).toISOString(), items };
  }
}
