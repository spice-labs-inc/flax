import { describe, expect, it } from "vitest";
import {
  isTransient,
  retryAfterMs,
  safeToRepeat,
} from "../src/deliver/github-retry.ts";
import { GithubWriter } from "../src/deliver/github-writer.ts";

const REPO = "notes-co/public-docs";
const BASE = `/repos/${REPO}`;

type Answer =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | "reset";

/** A GitHub that answers each "METHOD path" from its own queue; the last answer repeats. */
function scripted(routes: Record<string, Answer[]>) {
  const calls: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.test", "").split("?")[0]!;
    const key = `${init?.method ?? "GET"} ${path}`;
    calls.push(key);
    const queue = routes[key];
    if (queue === undefined) return new Response("{}", { status: 404 });
    const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (answer === "reset") throw new TypeError("fetch failed: ECONNRESET");
    return new Response(
      answer.body === undefined ? null : JSON.stringify(answer.body),
      { status: answer.status, headers: answer.headers ?? {} },
    );
  }) as typeof fetch;
  const slept: number[] = [];
  const writer = new GithubWriter({
    token: "t",
    apiUrl: "https://api.test",
    fetch: fetchFn,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { writer, calls, slept };
}

describe("the GitHub retry policy", () => {
  it("repeats reads, state-setting writes and content-addressed git objects only", () => {
    expect(safeToRepeat("GET", `${BASE}/pulls`)).toBe(true);
    expect(safeToRepeat("PATCH", `${BASE}/pulls/3`)).toBe(true);
    expect(safeToRepeat("PUT", `${BASE}/x`)).toBe(true);
    expect(safeToRepeat("DELETE", `${BASE}/git/refs/heads/agent/a/b`)).toBe(
      true,
    );
    for (const p of ["blobs", "trees", "commits"])
      expect(safeToRepeat("POST", `${BASE}/git/${p}`)).toBe(true);
    expect(safeToRepeat("POST", `${BASE}/pulls/3/requested_reviewers`)).toBe(
      true,
    );
    for (const p of [
      "/git/refs",
      "/pulls",
      "/issues/3/comments",
      "/check-runs",
      "/pulls/3/comments/9/replies",
    ])
      expect(safeToRepeat("POST", `${BASE}${p}`)).toBe(false);
    expect(safeToRepeat("POST", "/graphql")).toBe(false);
  });

  it("treats 5xx, no answer and short secondary rate limits as transient", () => {
    for (const s of [500, 502, 503, 504]) expect(isTransient(s)).toBe(true);
    expect(isTransient(undefined)).toBe(true);
    expect(isTransient(429, 3_000)).toBe(true);
    expect(isTransient(403, 3_000)).toBe(true);
    expect(isTransient(403)).toBe(false);
    expect(isTransient(429, 3_600_000)).toBe(false);
    for (const s of [400, 401, 404, 409, 422])
      expect(isTransient(s)).toBe(false);
  });

  it("reads Retry-After as seconds or a date", () => {
    expect(retryAfterMs("7")).toBe(7_000);
    expect(retryAfterMs(null)).toBeUndefined();
    const now = Date.parse("2026-10-07T02:00:00Z");
    expect(retryAfterMs("Wed, 07 Oct 2026 02:00:05 GMT", now)).toBe(5_000);
  });
});

describe("the GitHub writer's retries", () => {
  it("tries a read again after 5xx and no answer, on the backoff schedule", async () => {
    const gh = scripted({
      [`GET ${BASE}`]: [
        { status: 500 },
        "reset",
        { status: 200, body: { default_branch: "main" } },
      ],
    });
    expect(await gh.writer.defaultBranch(REPO)).toBe("main");
    expect(gh.calls).toHaveLength(3);
    expect(gh.slept).toEqual([2_000, 5_000]);
  });

  it("gives up after three retries", async () => {
    const gh = scripted({ [`GET ${BASE}`]: [{ status: 503 }] });
    await expect(gh.writer.defaultBranch(REPO)).rejects.toThrow(
      `GET ${BASE} returned 503`,
    );
    expect(gh.calls).toHaveLength(4);
    expect(gh.slept).toEqual([2_000, 5_000, 10_000]);
  });

  it("waits as long as Retry-After asks", async () => {
    const gh = scripted({
      [`GET ${BASE}`]: [
        { status: 429, headers: { "retry-after": "7" } },
        { status: 200, body: { default_branch: "main" } },
      ],
    });
    await gh.writer.defaultBranch(REPO);
    expect(gh.slept).toEqual([7_000]);
  });

  it("does not repeat a 403 without Retry-After, or a comment", async () => {
    const forbidden = scripted({ [`GET ${BASE}`]: [{ status: 403 }] });
    await expect(forbidden.writer.defaultBranch(REPO)).rejects.toThrow("403");
    expect(forbidden.calls).toHaveLength(1);
    const comment = scripted({
      [`POST ${BASE}/issues/3/comments`]: [{ status: 500 }],
    });
    await expect(comment.writer.comment(REPO, 3, "hi")).rejects.toThrow("500");
    expect(comment.calls).toHaveLength(1);
    expect(comment.slept).toEqual([]);
  });

  it("repeats a blob write, and does not create a ref twice when the first one went through", async () => {
    const base = "a".repeat(40);
    const commit = "c".repeat(40);
    const branch = "agent/demo-videos/2026-10-07";
    const gh = scripted({
      [`GET ${BASE}/git/commits/${base}`]: [
        { status: 200, body: { tree: { sha: "b".repeat(40) } } },
      ],
      [`POST ${BASE}/git/blobs`]: [
        { status: 500 },
        { status: 201, body: { sha: "d".repeat(40) } },
      ],
      [`POST ${BASE}/git/trees`]: [
        { status: 201, body: { sha: "e".repeat(40) } },
      ],
      [`POST ${BASE}/git/commits`]: [{ status: 201, body: { sha: commit } }],
      [`GET ${BASE}/git/ref/heads/${branch}`]: [
        { status: 404 },
        { status: 200, body: { object: { sha: commit } } },
      ],
      [`POST ${BASE}/git/refs`]: [{ status: 500 }],
    });
    const sha = await gh.writer.commitFiles(REPO, {
      branch,
      base,
      message: "m",
      author: { name: "a", email: "a@example.com" },
      date: new Date("2026-10-07T02:00:00Z"),
      files: [
        { path: "public/p.png", bytes: Buffer.from("x"), mode: "100644" },
      ],
    });
    expect(sha).toBe(commit);
    expect(gh.calls.filter((c) => c === `POST ${BASE}/git/blobs`)).toHaveLength(
      2,
    );
    expect(gh.calls.filter((c) => c === `POST ${BASE}/git/refs`)).toHaveLength(
      1,
    );
  });

  it("does not open a second pull request when the first one went through", async () => {
    const gh = scripted({
      [`POST ${BASE}/pulls`]: [{ status: 502 }],
      [`GET ${BASE}/pulls`]: [
        {
          status: 200,
          body: [
            {
              number: 62,
              html_url: "https://github.com/x/62",
              head: {
                ref: "agent/demo-videos/2026-10-07",
                repo: { full_name: REPO },
              },
              user: { type: "Bot" },
            },
          ],
        },
      ],
    });
    const pull = await gh.writer.openPull(REPO, {
      branch: "agent/demo-videos/2026-10-07",
      base: "main",
      title: "t",
      body: "b",
    });
    expect(pull).toEqual({ number: 62, url: "https://github.com/x/62" });
    expect(gh.calls.filter((c) => c === `POST ${BASE}/pulls`)).toHaveLength(1);
  });

  it("opens the pull request again when none is open after a transient failure", async () => {
    const gh = scripted({
      [`POST ${BASE}/pulls`]: [
        { status: 504 },
        { status: 201, body: { number: 63, html_url: "u" } },
      ],
      [`GET ${BASE}/pulls`]: [{ status: 200, body: [] }],
    });
    const pull = await gh.writer.openPull(REPO, {
      branch: "agent/demo-videos/2026-10-07",
      base: "main",
      title: "t",
      body: "b",
    });
    expect(pull.number).toBe(63);
    expect(gh.calls.filter((c) => c === `POST ${BASE}/pulls`)).toHaveLength(2);
  });
});
