import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { isRecord, isUsageHistory, isUseClass, ORG_HASH, } from "@flax/contract";
export const LIVE_KEEP_MS = 24 * 3_600_000;
function windowOf(v) {
    return isRecord(v) &&
        typeof v["from"] === "number" &&
        typeof v["to"] === "number" &&
        v["from"] < v["to"]
        ? { from: v["from"], to: v["to"] }
        : undefined;
}
function liveRowOf(v) {
    if (!isRecord(v) ||
        typeof v["item"] !== "string" ||
        !isUseClass(v["cls"]) ||
        !(v["org"] === null ||
            (typeof v["org"] === "string" && ORG_HASH.test(v["org"]))) ||
        typeof v["n"] !== "number" ||
        typeof v["last"] !== "string" ||
        typeof v["to"] !== "number")
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
function writeWhole(path, body) {
    const tmp = `${path}.${randomBytes(6).toString("hex")}`;
    writeFileSync(tmp, body);
    renameSync(tmp, path);
}
/** Windows that do not overlap, newest first: each next one ends where the one before it starts, or earlier. */
export function disjointWindows(windows) {
    const chosen = new Set();
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
    #dir;
    #envs;
    #live = new Map();
    constructor(dir, envs, now) {
        this.#dir = dir;
        this.#envs = envs;
        mkdirSync(dir, { recursive: true });
        for (const env of envs) {
            const p = this.#livePath(env);
            if (!existsSync(p))
                continue;
            try {
                const v = JSON.parse(readFileSync(p, "utf8"));
                if (!isRecord(v))
                    continue;
                const windows = Array.isArray(v["windows"])
                    ? v["windows"].flatMap((w) => windowOf(w) ?? [])
                    : [];
                const rows = Array.isArray(v["rows"])
                    ? v["rows"].flatMap((r) => liveRowOf(r) ?? [])
                    : [];
                this.#live.set(env, { windows, rows });
                this.#prune(env, now);
            }
            catch {
                continue;
            }
        }
    }
    get envs() {
        return this.#envs;
    }
    #livePath(env) {
        return join(this.#dir, `live-${env}.json`);
    }
    historyPath(env) {
        return join(this.#dir, `history-${env}.json`);
    }
    #prune(env, now) {
        const l = this.#live.get(env);
        if (!l)
            return;
        const floor = now - LIVE_KEEP_MS;
        l.windows = l.windows.filter((w) => w.to > floor);
        l.rows = l.rows.filter((r) => r.to > floor);
    }
    /** One window's rows replace whatever an earlier delivery of the same window gave. */
    ingestWindow(body, now) {
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
    ingestHistory(body) {
        writeWhole(this.historyPath(body.env), JSON.stringify(body));
    }
    /** The newest history an env has, or undefined before the first delivery. */
    history(env) {
        const p = this.historyPath(env);
        if (!existsSync(p))
            return undefined;
        try {
            const v = JSON.parse(readFileSync(p, "utf8"));
            return isUsageHistory(v, this.#envs) ? v : undefined;
        }
        catch {
            return undefined;
        }
    }
    /** Per item and class over the last 24 hours: distinct organizations, requests counted once each, and the newest request. */
    summary(env, now) {
        this.#prune(env, now);
        const l = this.#live.get(env) ?? { windows: [], rows: [] };
        const counted = disjointWindows(l.windows);
        const items = {};
        const orgs = new Map();
        for (const r of l.rows) {
            const use = ((items[r.item] ??= {})[r.cls] ??= {
                orgs: 0,
                n24h: 0,
                last: r.last,
            });
            const set = orgs.get(use) ?? new Set();
            orgs.set(use, set);
            if (r.org)
                set.add(r.org);
            use.orgs = set.size;
            if (counted.has(r.to))
                use.n24h += r.n;
            if (r.last > use.last)
                use.last = r.last;
        }
        return { env, at: new Date(now).toISOString(), items };
    }
}
//# sourceMappingURL=usage.js.map