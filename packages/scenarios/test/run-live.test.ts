import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "@cucumber/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  githubRun,
  LivePush,
  livePushFromEnv,
  type LiveLimits,
} from "../src/run/live.ts";
import type { RunResult } from "../src/run/results.ts";

interface Call {
  url: string;
  body: string;
  auth: string | null;
  at: number;
}

/** A fetch whose answers the test decides: a status, a thrown error, or never (until aborted). */
function fakeFetch(answer: (call: Call) => number | Error | "hang") {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      body: String(init?.body ?? ""),
      auth: new Headers(init?.headers).get("authorization"),
      at: Date.now(),
    };
    calls.push(call);
    const a = answer(call);
    if (a === "hang")
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        }),
      );
    if (a instanceof Error) throw a;
    return new Response(null, { status: a });
  }) as typeof fetch;
  return { fn, calls };
}

const run: RunResult = {
  env: "staging",
  runId: "staging-2026-10-13T18-00-00-000Z",
  startedAt: "2026-10-13T18:00:00.000Z",
  finishedAt: "2026-10-13T18:20:00.000Z",
  versions: {},
  scenarios: [],
};

const envelope = (n: number): Envelope => ({
  testRunStarted: { timestamp: { seconds: n, nanos: 0 } },
});

function push(
  answer: Parameters<typeof fakeFetch>[0],
  limits: Partial<LiveLimits> = {},
) {
  const f = fakeFetch(answer);
  const warnings: string[] = [];
  const p = new LivePush({
    url: new URL("http://explorer.test"),
    token: "secret-token",
    runId: run.runId,
    fetch: f.fn,
    warn: (l) => warnings.push(l),
    limits,
  });
  p.start({
    env: "staging",
    runId: run.runId,
    startedAt: run.startedAt,
    workers: 3,
    planned: [],
  });
  return { p, calls: f.calls, warnings };
}

describe("LivePush", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the start, then the messages in order with the sequence number of the first, then the finish", async () => {
    const { p, calls, warnings } = push(() => 200);
    for (let i = 0; i < 3; i++) p.message(envelope(i));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    p.message(envelope(3));
    await vi.advanceTimersByTimeAsync(1_000);
    await p.finish(run, []);
    expect(
      calls.map((c) => new URL(c.url).pathname + new URL(c.url).search),
    ).toEqual([
      `/ingest/runs/${run.runId}/start`,
      `/ingest/runs/${run.runId}/messages?first=0`,
      `/ingest/runs/${run.runId}/messages?first=3`,
      `/ingest/runs/${run.runId}/finish`,
    ]);
    expect(calls[1]!.body.trim().split("\n")).toHaveLength(3);
    expect(calls.every((c) => c.auth === "Bearer secret-token")).toBe(true);
    expect(JSON.parse(calls[3]!.body)).toMatchObject({ run, dropped: 0 });
    expect(warnings).toEqual([]);
  });

  it("gives each request 3 seconds, then backs off from 5 to 60 seconds and warns once", async () => {
    const { p, calls, warnings } = push(() => "hang");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no answer within 3 s");
    const starts: number[] = [];
    for (let t = 0; t < 4 * 60_000; t += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      if (calls.length > starts.length + 1) starts.push(calls.at(-1)!.at);
    }
    const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
    // Each gap is the request's own 3 s plus a backoff that doubles up to 60 s.
    expect(
      gaps.slice(0, 4).map((g) => Math.round((g - 3_000) / 1_000)),
    ).toEqual([10, 20, 40, 60]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(64_000);
    expect(warnings).toHaveLength(1);
    expect(warnings.join("\n")).not.toContain("secret-token");
    p.message(envelope(0));
  });

  it("stops for the rest of the run after 5 minutes of failures", async () => {
    const { p, calls, warnings } = push(() => new TypeError("fetch failed"));
    p.message(envelope(0));
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(p.stopped).toBe(true);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("gave up after 5 minutes");
    const sent = calls.length;
    p.message(envelope(1));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await p.finish(run, []);
    expect(calls).toHaveLength(sent);
  });

  it("recovers when the explorer answers again", async () => {
    let down = true;
    const { p, calls } = push(() => (down ? 503 : 200));
    p.message(envelope(0));
    await vi.advanceTimersByTimeAsync(1_000);
    down = false;
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.map((c) => new URL(c.url).pathname.split("/").at(-1))).toEqual(
      ["start", "start", "messages"],
    );
    expect(p.stopped).toBe(false);
  });

  it("stops at once when the explorer refuses the token", async () => {
    const { p, calls, warnings } = push(() => 401);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(p.stopped).toBe(true);
    expect(calls).toHaveLength(1);
    expect(warnings).toEqual([
      "live updates: the explorer answered 401, so not pushing for the rest of this run; the run itself is unaffected",
    ]);
  });

  it("bounds the queue and flags the gap on the next batch", async () => {
    const { p, calls } = push(() => 200, { maxEnvelopes: 2 });
    for (let i = 0; i < 5; i++) p.message(envelope(i));
    expect(p.dropped).toBe(3);
    await vi.advanceTimersByTimeAsync(2_000);
    p.message(envelope(9));
    await vi.advanceTimersByTimeAsync(1_000);
    const batches = calls.filter((c) => c.url.includes("/messages"));
    expect(batches.map((c) => new URL(c.url).search)).toEqual([
      "?first=0&gap=1",
      "?first=2",
    ]);
  });

  it("bounds the queue by bytes too", () => {
    const { p } = push(() => 200, { maxBytes: 100 });
    for (let i = 0; i < 10; i++) p.message(envelope(i));
    expect(p.dropped).toBeGreaterThan(5);
  });

  it("leaves large attachments out of the live stream", async () => {
    const { p, calls } = push(() => 200, { attachmentBytes: 10 });
    p.message({
      attachment: {
        body: "x".repeat(11),
        mediaType: "image/png",
        contentEncoding: "BASE64" as never,
      },
    });
    p.message(envelope(1));
    await vi.advanceTimersByTimeAsync(2_000);
    const batch = calls.find((c) => c.url.includes("/messages"))!;
    expect(batch.body.trim().split("\n")).toHaveLength(1);
    expect(p.dropped).toBe(0);
  });

  it("splits a long queue into batches under the byte limit", async () => {
    const { p, calls } = push(() => 200, { batchBytes: 120 });
    for (let i = 0; i < 6; i++) p.message(envelope(i));
    await p.finish(run, []);
    const batches = calls.filter((c) => c.url.includes("/messages"));
    expect(batches.length).toBeGreaterThan(1);
    expect(
      batches.reduce((n, b) => n + b.body.trim().split("\n").length, 0),
    ).toBe(6);
    expect(batches.every((b) => Buffer.byteLength(b.body) <= 120)).toBe(true);
  });

  it("gives the final flush and the finish at most 10 seconds, and never throws", async () => {
    const { p } = push(() => "hang");
    for (let i = 0; i < 3; i++) p.message(envelope(i));
    const t0 = Date.now();
    let done = false;
    const finishing = p.finish(run, []).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await finishing;
    expect(done).toBe(true);
    expect(Date.now() - t0).toBeLessThanOrEqual(10_000);
  });
});

describe("livePushFromEnv", () => {
  it("is off unless both the URL and the token are set", () => {
    const warn = vi.fn();
    expect(livePushFromEnv({}, "r", warn)).toBeUndefined();
    expect(
      livePushFromEnv({ EXPLORER_INGEST_TOKEN: "t" }, "r", warn),
    ).toBeUndefined();
    expect(
      livePushFromEnv({ EXPLORER_URL: "https://x.test" }, "r", warn),
    ).toBeUndefined();
    expect(
      livePushFromEnv(
        { EXPLORER_URL: "not a url", EXPLORER_INGEST_TOKEN: "t" },
        "r",
        warn,
      ),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const p = livePushFromEnv(
      { EXPLORER_URL: "https://x.test", EXPLORER_INGEST_TOKEN: "t" },
      "r",
      warn,
    );
    expect(p).toBeInstanceOf(LivePush);
    void p?.finish(run, []);
  });

  it("reads the workflow run from the GitHub Actions variables", () => {
    expect(
      githubRun({
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_REPOSITORY: "acme/acme-agents",
      }),
    ).toEqual({
      runId: "123",
      attempt: "2",
      repository: "acme/acme-agents",
    });
    expect(githubRun({ GITHUB_RUN_ID: "x" })).toBeUndefined();
  });
});

describe("a run with live updates pointed at a broken explorer", () => {
  let dir: string;
  let server: Server | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "run-live-"));
  });
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r) ?? r(undefined));
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const runCli = (
    feature: string,
    env: Record<string, string>,
  ): Promise<{ code: number | null; ms: number; stderr: string }> =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
          "run",
          "--env",
          "dev",
          "--out",
          join(dir, "out", String(t0)),
          feature,
        ],
        {
          env: {
            ...process.env,
            EXPLORER_URL: "",
            EXPLORER_INGEST_TOKEN: "",
            ...env,
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
      child.on("close", (code) =>
        resolve({ code, ms: Date.now() - t0, stderr }),
      );
    });

  it("exits as it would without them, and in at most 10 more seconds", async () => {
    const feature = join(dir, "undefined.feature");
    await writeFile(
      feature,
      "Feature: Live push\n  Scenario: A step nobody defined\n    Given a step that no step definition matches\n",
    );
    server = createServer(() => undefined);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    const plain = await runCli(feature, {});
    const hanging = await runCli(feature, {
      EXPLORER_URL: `http://127.0.0.1:${port}`,
      EXPLORER_INGEST_TOKEN: "secret-token",
    });
    const refused = await runCli(feature, {
      EXPLORER_URL: "http://127.0.0.1:9",
      EXPLORER_INGEST_TOKEN: "secret-token",
    });
    expect(plain.code).toBe(1);
    expect(hanging.code).toBe(1);
    expect(refused.code).toBe(1);
    expect(hanging.ms - plain.ms).toBeLessThan(13_000);
    expect(hanging.stderr).toContain(
      "live updates: pushing to the explorer failed",
    );
    expect(hanging.stderr + refused.stderr).not.toContain("secret-token");

    const out = join(dir, "out");
    const statuses = await Promise.all(
      readdirSync(out).map(async (t) => {
        const envDir = join(out, t, "dev");
        const id = readdirSync(envDir)[0]!;
        const r = JSON.parse(
          await readFile(join(envDir, id, "run.json"), "utf8"),
        ) as RunResult;
        return r.scenarios.map((s) => [s.id.split("/").at(-1), s.status]);
      }),
    );
    expect(statuses).toHaveLength(3);
    for (const s of statuses) expect(s).toEqual(statuses[0]);
  }, 120_000);
});
