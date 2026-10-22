import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  usageFileOf,
  usageLiveOf,
  usageWindowProblem,
  type UsageLive,
} from "@flax/contract";
import { usageFile } from "../scripts/usage.ts";
import { Hub } from "../server/hub.ts";
import { LiveRuns } from "../server/runs.ts";
import { explorerServer, type ServerDeps } from "../server/server.ts";
import { disjointWindows, UsageStore } from "../server/usage.ts";
import type { Item } from "../src/lib/data.ts";
import {
  featureUseLine,
  pulseClass,
  PULSE_MS,
  usedBy,
  useLine,
  usageModel,
  USE_WORDS,
} from "../src/lib/usage.ts";
import type { Verdict } from "../src/lib/verdict.ts";

const ENVS = ["prod", "staging", "dev"];
const SEARCH = "api:GET /api/v1/search";
const UPLOAD = "api:POST /api/v1/upload";
const T0 = Date.parse("2026-10-15T12:00:00Z");
const MIN = 60_000;
const h = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 12);

/** What a relay sends each minute: the five minutes ending at `to`, with one request in each of them. */
const window = (to: number, item = SEARCH, org: string | null = h("a")) => ({
  env: "prod",
  from: new Date(to - 5 * MIN).toISOString(),
  to: new Date(to).toISOString(),
  rows: [
    {
      item,
      cls: "outside" as const,
      org,
      n: 5,
      last: new Date(to - MIN).toISOString(),
    },
  ],
});

describe("the service's usage store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "explorer-usage-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("counts each request once across overlapping windows, and keeps the newest request", () => {
    const store = new UsageStore(dir, ENVS, T0);
    for (let i = 0; i < 12; i++)
      store.ingestWindow(window(T0 + i * MIN), T0 + i * MIN);
    expect(store.summary("prod", T0 + 11 * MIN).items[SEARCH]?.outside).toEqual(
      { orgs: 1, n24h: 15, last: new Date(T0 + 10 * MIN).toISOString() },
    );
    expect(
      disjointWindows([
        { from: 0, to: 5 },
        { from: 1, to: 6 },
        { from: 5, to: 10 },
        { from: 6, to: 11 },
      ]),
    ).toEqual(new Set([11, 6]));
  });

  it("replaces a window delivered twice, counts organizations once, and drops rows older than 24 hours", () => {
    const store = new UsageStore(dir, ENVS, T0);
    store.ingestWindow(window(T0), T0);
    store.ingestWindow(window(T0), T0);
    store.ingestWindow(window(T0 + 5 * MIN, SEARCH, h("b")), T0 + 5 * MIN);
    store.ingestWindow(window(T0 + 10 * MIN, SEARCH, h("a")), T0 + 10 * MIN);
    expect(
      store.summary("prod", T0 + 10 * MIN).items[SEARCH]?.outside,
    ).toMatchObject({ orgs: 2, n24h: 15 });
    const later = new UsageStore(dir, ENVS, T0 + 10 * MIN);
    expect(
      later.summary("prod", T0 + 10 * MIN).items[SEARCH]?.outside?.n24h,
    ).toBe(15);
    expect(
      later.summary("prod", T0 + 24 * 60 * MIN + 6 * MIN).items[SEARCH]?.outside
        ?.n24h,
    ).toBe(5);
    expect(later.summary("prod", T0 + 25 * 60 * MIN).items).toEqual({});
  });

  it("keeps the newest history per env for the data build", () => {
    const store = new UsageStore(dir, ENVS, T0);
    expect(store.history("prod")).toBeUndefined();
    const body = {
      env: "prod",
      generatedAt: "2026-10-15T18:07:00.000Z",
      days: [
        {
          day: "2026-10-15",
          item: SEARCH,
          cls: "outside" as const,
          org: h("a"),
          n: 3,
        },
      ],
    };
    store.ingestHistory(body);
    expect(new UsageStore(dir, ENVS, T0).history("prod")).toEqual(body);
  });

  it("refuses bodies with raw organization ids, unknown envs and classes, and other shapes", () => {
    const w = window(T0);
    expect(
      usageWindowProblem(
        { ...w, rows: [{ ...w.rows[0], org: "11111111-2222-4333-8444" }] },
        ENVS,
      ),
    ).toMatch(/rows 0/);
    expect(usageWindowProblem({ ...w, env: "qa" }, ENVS)).toMatch(/env/);
    expect(usageWindowProblem({ ...w, from: w.to }, ENVS)).toMatch(/before/);
    expect(
      usageWindowProblem(
        { ...w, rows: [{ ...w.rows[0], cls: "customers" }] },
        ENVS,
      ),
    ).toMatch(/rows 0/);
    expect(usageWindowProblem(w, ENVS)).toBeUndefined();
  });
});

describe("the service's usage routes", () => {
  let dir: string;
  let server: Server;
  let base: string;
  const sent: { event: string; data: unknown }[] = [];
  const histories: string[] = [];

  const start = async (usage: ServerDeps["usage"]) => {
    const hub = new Hub(() => ({}));
    hub.send = (event, data) => void sent.push({ event, data });
    server = explorerServer({
      token: "ingest-token",
      runs: new LiveRuns(join(dir, "live"), T0),
      hub,
      log: () => {},
      onFinish: () => {},
      snapshotExtra: () => ({}),
      usage,
      now: () => T0,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const post = (path: string, body: unknown, token = "usage-token") =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "explorer-usage-routes-"));
    sent.length = 0;
    histories.length = 0;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes a window and a history with the usage token, streams the window's use and rebuilds on a history", async () => {
    const store = new UsageStore(join(dir, "usage"), ENVS, T0);
    await start({
      token: "usage-token",
      store,
      onHistory: (e) => histories.push(e),
    });
    expect((await post("/ingest/usage/live", window(T0))).status).toBe(204);
    expect(sent).toEqual([{ event: "usage", data: store.summary("prod", T0) }]);
    const history = {
      env: "prod",
      generatedAt: new Date(T0).toISOString(),
      days: [{ day: "2026-10-15", item: SEARCH, cls: "runs", org: null, n: 2 }],
    };
    expect((await post("/ingest/usage/history", history)).status).toBe(204);
    expect(histories).toEqual(["prod"]);
    expect(store.history("prod")).toEqual(history);

    expect((await post("/ingest/usage/live", window(T0), "wrong")).status).toBe(
      401,
    );
    expect(
      (await post("/ingest/usage/live", window(T0), "ingest-token")).status,
    ).toBe(401);
    const bad = await post("/ingest/usage/live", { ...window(T0), env: "qa" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: "env is not one of prod, staging, dev",
    });
    expect((await post("/ingest/usage/other", {})).status).toBe(404);
  });

  it("refuses every usage call without a token, and answers that usage is off without the plug-in", async () => {
    await start({
      token: undefined,
      store: new UsageStore(join(dir, "usage"), ENVS, T0),
    });
    expect((await post("/ingest/usage/live", window(T0))).status).toBe(401);
    await new Promise((r) => server.close(r));
    await start(undefined);
    const off = await post("/ingest/usage/live", window(T0));
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({
      error: "usage is off: flax.yml has no explorer.usage",
    });
  });
});

describe("usage.json from the history", () => {
  it("counts organizations, requests, today and the last day per item and class in the workspace's timezone, and names keys the map lacks", () => {
    const f = usageFile(
      {
        env: "prod",
        generatedAt: "2026-10-15T18:07:00.000Z",
        days: [
          {
            day: "2026-10-14",
            item: SEARCH,
            cls: "outside",
            org: "aaaaaaaaaaaa",
            n: 114,
          },
          {
            day: "2026-10-15",
            item: SEARCH,
            cls: "outside",
            org: "aaaaaaaaaaaa",
            n: 30,
          },
          {
            day: "2026-10-13",
            item: SEARCH,
            cls: "outside",
            org: "bbbbbbbbbbbb",
            n: 1,
          },
          { day: "2026-10-15", item: SEARCH, cls: "runs", org: null, n: 9 },
          {
            day: "2026-10-12",
            item: "api:GET /gone",
            cls: "internal",
            org: null,
            n: 4,
          },
        ],
      },
      [SEARCH],
      ENVS,
      "America/Los_Angeles",
    );
    expect(f).toEqual({
      env: "prod",
      generatedAt: "2026-10-15T18:07:00.000Z",
      firstDay: "2026-09-16",
      lastDay: "2026-10-15",
      items: {
        [SEARCH]: {
          outside: { orgs: 2, n: 145, today: 30, lastDay: "2026-10-15" },
          runs: { orgs: 0, n: 9, today: 9, lastDay: "2026-10-15" },
        },
        "api:GET /gone": {
          internal: { orgs: 0, n: 4, today: 0, lastDay: "2026-10-12" },
        },
      },
      unmapped: ["api:GET /gone"],
    });
    expect(usageFileOf(JSON.parse(JSON.stringify(f)))).toEqual(f);
    expect(
      usageFile(
        { env: "prod", generatedAt: "2026-10-16T02:00:00.000Z", days: [] },
        [],
        ENVS,
        "UTC",
      ).lastDay,
    ).toBe("2026-10-16");
    expect(() => usageFile({ env: "prod" }, [], ENVS, "UTC")).toThrow(
      /not the shape/,
    );
  });
});

describe("use on the page, in the workspace's words", () => {
  it("names who used an item in a list row, without counts", () => {
    const month = { span: "month" as const, n: 3, orgs: 0 };
    expect(
      usedBy({ outside: { ...month, orgs: 1 }, internal: month, runs: month }),
    ).toBe("Used by 1 organization not marked as our own, staff and our runs.");
    expect(usedBy({ internal: month })).toBe("Used by staff.");
    expect(usedBy({ outside: month })).toBe(
      "Used by requests with no organization.",
    );
    expect(usedBy({})).toBe("");
  });

  const NOW = Date.parse("2026-10-15T18:10:00Z");
  const item = (
    idx: number,
    id: string,
    label = id,
    surface = "api",
  ): Item => ({
    idx,
    id,
    label,
    surface,
    island: surface,
    area: "Search",
    envs: ENVS,
    status: {},
    kind: "API operation",
  });
  const verdictOf = (state: Verdict["state"], label: string): Verdict => ({
    state,
    label,
    laterFailed: [],
    stale: false,
  });
  const live: UsageLive = {
    env: "prod",
    at: new Date(NOW).toISOString(),
    items: {
      [SEARCH]: {
        outside: {
          orgs: 2,
          n24h: 114,
          last: new Date(NOW - 3 * MIN).toISOString(),
        },
        internal: {
          orgs: 1,
          n24h: 14,
          last: new Date(NOW - 20 * MIN).toISOString(),
        },
        runs: { orgs: 0, n24h: 40, last: new Date(NOW - MIN).toISOString() },
      },
      [UPLOAD]: {
        internal: {
          orgs: 1,
          n24h: 1,
          last: new Date(NOW - 2 * MIN).toISOString(),
        },
      },
      "api:GET /api/v1/version": {
        runs: {
          orgs: 0,
          n24h: 3,
          last: new Date(NOW - 3 * 3_600_000).toISOString(),
        },
      },
    },
  };

  it("says one line per item, with the env's label and the workspace's timezone", () => {
    expect(useLine({}, NOW)).toBeUndefined();
    const m = usageModel([item(0, SEARCH)], null, () =>
      verdictOf("none", "No scenario yet"),
    );
    expect(m.lineOf(item(0, SEARCH), live, NOW)).toBe(
      "Use on Prod: 2 organizations not marked as our own, last 3 minutes ago; staff 14 times in the last 24 hours; our runs 40 times in the last 24 hours.",
    );
    expect(
      useLine(
        {
          outside: { orgs: 1, n: 145, span: "month", lastDay: "2026-10-09" },
          internal: { orgs: 1, n: 1, span: "month" },
        },
        NOW,
      ),
    ).toBe(
      "Use on Prod: 1 organization not marked as our own in 30 days, last on Oct 9; staff once in 30 days.",
    );
    expect(
      useLine(
        {
          outside: {
            orgs: 0,
            n: 11,
            span: "day",
            last: "2026-10-15T15:00:00Z",
          },
        },
        NOW,
      ),
    ).toBe(
      "Use on Prod: 11 requests with no organization, not marked as our own, last at Oct 15, 8:00 AM PDT.",
    );
    expect(
      m.lineOf(
        item(1, "cli:search", "search", "cli"),
        {
          ...live,
          items: {
            "cli:search": {
              internal: {
                orgs: 1,
                n24h: 4673,
                last: new Date(NOW).toISOString(),
              },
            },
          },
        },
        NOW,
      ),
    ).toBe("Use on Prod: staff 4,673 requests in the last 24 hours.");
    expect(
      useLine(
        { outside: { orgs: 1, n: 3, span: "month", lastDay: "2026-10-15" } },
        NOW,
      ),
    ).toBe(
      "Use on Prod: 1 organization not marked as our own in 30 days, last today.",
    );
    expect(usageLiveOf(JSON.parse(JSON.stringify(live)))).toEqual(live);
    expect(
      usageLiveOf({ ...live, items: { x: { customers: {} } } }),
    ).toBeUndefined();
  });

  it("says one line per feature, over its items", () => {
    const m = usageModel([], null, () => verdictOf("none", "No scenario yet"));
    expect(
      featureUseLine(
        [m.useOf(item(0, SEARCH), live), m.useOf(item(1, UPLOAD), live)],
        NOW,
      ),
    ).toBe(
      "Use on Prod: 2 organizations not marked as our own used 1 of its items in the last 24 hours, last 3 minutes ago; staff used 2 of its items in the last 24 hours; our runs used 1 of its items in the last 24 hours.",
    );
  });

  it("pulses a hex by the first class used in the last few minutes", () => {
    expect(pulseClass(live, SEARCH, NOW)).toBe("outside");
    expect(pulseClass(live, UPLOAD, NOW)).toBe("internal");
    expect(pulseClass(live, UPLOAD, NOW + PULSE_MS)).toBeUndefined();
    expect(pulseClass(live, "api:GET /api/v1/version", NOW)).toBeUndefined();
    expect(pulseClass(null, SEARCH, NOW)).toBeUndefined();
  });

  it("lists what is used but not verified in the use's env, by organizations then requests, and our runs' reach apart", () => {
    const its = [
      item(0, SEARCH, "Search notes"),
      item(1, UPLOAD, "Upload a file"),
      item(2, "api:GET /api/v1/version", "Version"),
      item(3, "api:GET /api/v1/user", "Who am I"),
    ];
    const verified = new Set(["api:GET /api/v1/user"]);
    const envs: string[] = [];
    const m = usageModel(
      its,
      {
        env: "prod",
        generatedAt: "2026-10-15T18:07:00.000Z",
        firstDay: "2026-09-16",
        lastDay: "2026-10-15",
        items: {
          "api:GET /api/v1/user": {
            outside: { orgs: 3, n: 30, today: 1, lastDay: "2026-10-15" },
          },
        },
        unmapped: [],
      },
      (it, env) => {
        envs.push(env);
        return verified.has(it.id)
          ? verdictOf("verified", "Verified")
          : verdictOf("never", "Never run here");
      },
    );
    expect(
      m.usedNotVerified(0, live).map((r) => [r.item.label, r.orgs, r.requests]),
    ).toEqual([
      ["Search notes", 3, 128],
      ["Upload a file", 1, 1],
    ]);
    expect(m.reachedByOurRuns(0, live).map((r) => r.item.label)).toEqual([
      "Search notes",
      "Version",
    ]);
    expect(new Set(envs)).toEqual(new Set(["prod"]));
    expect([...m.pulses(live, NOW)]).toEqual([
      [0, "outside"],
      [1, "internal"],
    ]);
    expect(USE_WORDS.usedHeading).toBe("Used on Prod, not verified on Prod");
    expect(USE_WORDS.usedLead("2 items", false)).toBe(
      "Staff or organizations not marked as our own used 2 items on Prod that are not verified there.",
    );
    expect(USE_WORDS.reachedHeading).toBe("Reached by our runs on Prod");
  });
});
