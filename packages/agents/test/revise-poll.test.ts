import { describe, expect, it } from "vitest";
import type { JobConfig } from "../src/lib/job.ts";
import {
  namesTarget,
  pollRevisions,
  type QueuedRevision,
  type WorkflowRun,
} from "../src/revise/poll.ts";
import { LIMIT_MARKER, revisionMarker } from "../src/revise/requests.ts";
import { jobConfig } from "./helpers.ts";

const ATLAS = "notes-co/atlas";
const DOCS = "notes-co/internal-docs";
const BOT = { login: "agents-writer[bot]", type: "Bot" };
const person = (login: string) => ({ login, type: "User" });

function prJob(
  name: string,
  repos: string[] = [ATLAS],
  mode = "live",
): JobConfig {
  return jobConfig(name, {
    mode,
    output: {
      kind: "pr",
      repos,
      paths: ["repos/*.md"],
      max_changed_lines: 100,
      untrusted_input: "report_only",
    },
  }) as unknown as JobConfig;
}

interface Thread {
  pull: Record<string, unknown>;
  reviews?: Record<string, unknown>[];
  reviewComments?: Record<string, unknown>[];
  comments?: Record<string, unknown>[];
}

function pull(
  repo: string,
  number: number,
  branch: string,
  user: Record<string, unknown> = BOT,
): Record<string, unknown> {
  return {
    number,
    html_url: `https://github.com/${repo}/pull/${number}`,
    state: "open",
    user,
    body: "",
    head: { ref: branch, sha: "a".repeat(40), repo: { full_name: repo } },
  };
}

function comment(
  id: number,
  body: string,
  at: string,
  association = "MEMBER",
  user: Record<string, unknown> = person("dani"),
): Record<string, unknown> {
  return {
    id,
    user,
    author_association: association,
    body,
    html_url: `https://github.com/x/issues/1#issuecomment-${id}`,
    created_at: at,
  };
}

const botComment = (id: number, body: string, at: string) =>
  comment(id, body, at, "NONE", BOT);

function review(
  id: number,
  state: string,
  body: string,
  at: string,
  association = "MEMBER",
): Record<string, unknown> {
  return {
    id,
    user: person("dani"),
    author_association: association,
    state,
    body,
    html_url: `https://github.com/x/pull/1#pullrequestreview-${id}`,
    submitted_at: at,
  };
}

/** A fake GitHub REST API serving open pull requests and their threads; a path in failing throws. */
function fakeGithub(threads: Record<string, Thread[]>, failing: string[] = []) {
  const calls: string[] = [];
  const byNumber = new Map<string, Thread>();
  for (const [repo, list] of Object.entries(threads))
    for (const t of list) byNumber.set(`${repo}#${String(t.pull.number)}`, t);
  const get = async (path: string): Promise<unknown> => {
    calls.push(path);
    const [route, query = ""] = path.split("?");
    if (failing.some((f) => route === f))
      throw new Error(`GET ${route} returned 502`);
    const listed = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(route!);
    if (listed !== null) return (threads[listed[1]!] ?? []).map((t) => t.pull);
    if (/(^|&)page=([2-9]|\d\d)/.test(query)) return [];
    const m =
      /^\/repos\/([^/]+\/[^/]+)\/(pulls|issues)\/(\d+)(?:\/(files|reviews|comments))?$/.exec(
        route!,
      );
    if (m === null) throw new Error(`GET ${route} returned 404`);
    const t = byNumber.get(`${m[1]}#${m[3]}`);
    if (t === undefined) throw new Error(`GET ${route} returned 404`);
    if (m[4] === undefined) return t.pull;
    if (m[4] === "files") return [{ filename: "repos/engine.md" }];
    if (m[4] === "reviews") return t.reviews ?? [];
    if (m[2] === "pulls") return t.reviewComments ?? [];
    return t.comments ?? [];
  };
  return { get, calls };
}

async function poll(
  jobs: JobConfig[],
  threads: Record<string, Thread[]>,
  options: {
    runs?: Record<string, WorkflowRun[]>;
    failing?: string[];
    dispatchFails?: boolean;
    /** Queue checks too; a string makes the queueing fail with it. */
    queue?: true | string;
  } = {},
) {
  const github = fakeGithub(threads, options.failing);
  const dispatched: [string, string][] = [];
  const queued: QueuedRevision[] = [];
  const runsAsked: string[] = [];
  const outcome = await pollRevisions({
    jobs,
    get: github.get,
    runs: async (job) => {
      runsAsked.push(job);
      return options.runs?.[job] ?? [];
    },
    dispatch: async (job, target) => {
      if (options.dispatchFails === true)
        throw new Error("POST /dispatches returned 422");
      dispatched.push([job, target]);
    },
    ...(options.queue === undefined
      ? {}
      : {
          queueCheck: async (q: QueuedRevision) => {
            if (typeof options.queue === "string")
              throw new Error(options.queue);
            queued.push(q);
          },
        }),
  });
  return { ...outcome, dispatched, runsAsked, queued, calls: github.calls };
}

const BRANCH = "agent/atlas/2026-09-30";
const asks = (n: number, at: string, association = "MEMBER"): Thread => ({
  pull: pull(ATLAS, n, BRANCH),
  comments: [
    comment(n * 10, "/agent please shorten the intro", at, association),
  ],
});

describe("the revision poller", () => {
  it("leaves shadow jobs and jobs of other outputs alone", async () => {
    const got = await poll(
      [
        prJob("atlas", [ATLAS], "shadow"),
        jobConfig("other", { mode: "live" }) as unknown as JobConfig,
      ],
      { [ATLAS]: [asks(3, "2026-10-01T10:00:00Z")] },
    );
    expect(got.calls).toEqual([]);
    expect(got.dispatched).toEqual([]);
    expect(got.lines).toEqual([]);
  });

  it("ignores a pull request the job's writer did not open", async () => {
    const got = await poll([prJob("atlas")], {
      [ATLAS]: [
        {
          pull: pull(ATLAS, 7, "feature/better-docs", person("dani")),
          comments: [comment(70, "/agent fix this", "2026-10-01T10:00:00Z")],
        },
        {
          pull: pull(ATLAS, 8, "agent/other-job/2026-09-30"),
          comments: [comment(80, "/agent fix this", "2026-10-01T10:00:00Z")],
        },
      ],
    });
    expect(got.calls).toEqual([
      `/repos/${ATLAS}/pulls?state=open&per_page=100`,
    ]);
    expect(got.dispatched).toEqual([]);
    expect(got.runsAsked).toEqual([]);
    expect(got.lines).toEqual([
      `atlas: ${ATLAS} has 0 open pull requests of the job`,
    ]);
  });

  it("dispatches for an /agent comment from a member, and not from a contributor", async () => {
    const member = await poll([prJob("atlas")], {
      [ATLAS]: [asks(3, "2026-10-01T10:00:00Z")],
    });
    expect(member.dispatched).toEqual([["atlas", `${ATLAS}#3`]]);
    expect(member.lines).toEqual([
      `atlas: ${ATLAS} has 1 open pull request of the job`,
      `${ATLAS}#3: 1 request waiting, round 1 would answer it`,
      `atlas: dispatched revise ${ATLAS}#3`,
    ]);
    expect(member.readFailures).toBe(0);
    expect(member.dispatchFailures).toBe(0);

    const contributor = await poll([prJob("atlas")], {
      [ATLAS]: [asks(3, "2026-10-01T10:00:00Z", "CONTRIBUTOR")],
    });
    expect(contributor.dispatched).toEqual([]);
    expect(contributor.runsAsked).toEqual([]);
    expect(contributor.lines.at(-1)).toBe(
      `${ATLAS}#3: nothing to do, no request is waiting for an answer`,
    );
  });

  it("dispatches for a Request changes review", async () => {
    const got = await poll([prJob("atlas")], {
      [ATLAS]: [
        {
          pull: pull(ATLAS, 4, BRANCH),
          reviews: [
            review(
              41,
              "CHANGES_REQUESTED",
              "The dates are wrong.",
              "2026-10-01T09:00:00Z",
            ),
          ],
        },
      ],
    });
    expect(got.dispatched).toEqual([["atlas", `${ATLAS}#4`]]);
  });

  it("does not dispatch for a request an agent comment answered", async () => {
    const thread = asks(3, "2026-10-01T10:00:00Z");
    thread.comments!.push(
      botComment(
        31,
        `Done.\n\n${revisionMarker(1, ["comment-30"])}`,
        "2026-10-01T10:20:00Z",
      ),
    );
    const got = await poll([prJob("atlas")], { [ATLAS]: [thread] });
    expect(got.dispatched).toEqual([]);
    expect(got.lines.at(-1)).toBe(
      `${ATLAS}#3: nothing to do, no request is waiting for an answer`,
    );
  });

  it("skips the whole job while a run of it waits to start", async () => {
    for (const status of ["queued", "waiting", "pending", "requested"]) {
      const got = await poll(
        [prJob("atlas")],
        { [ATLAS]: [asks(3, "2026-10-01T10:00:00Z")] },
        {
          runs: {
            atlas: [
              {
                status,
                conclusion: null,
                title: "job-atlas",
                createdAt: "2026-10-01T10:05:00Z",
              },
            ],
          },
        },
      );
      expect(got.dispatched).toEqual([]);
      expect(got.lines.at(-1)).toBe(
        `atlas: dispatched nothing, a run of the job is ${status} ("job-atlas"); the next poll tries again`,
      );
    }
  });

  it("dispatches one pull request per job per poll, the one with the oldest request", async () => {
    const got = await poll([prJob("atlas"), prJob("docs", [DOCS])], {
      [ATLAS]: [
        asks(3, "2026-10-01T11:00:00Z"),
        {
          pull: pull(ATLAS, 4, "agent/atlas/2026-09-29"),
          comments: [
            comment(40, "/agent one", "2026-10-01T12:00:00Z"),
            comment(41, "/agent two", "2026-10-01T08:00:00Z"),
          ],
        },
        asks(5, "2026-10-01T09:00:00Z"),
      ],
      [DOCS]: [
        {
          pull: pull(DOCS, 1, "agent/docs/2026-09-30"),
          comments: [comment(1, "/agent tighten", "2026-10-01T13:00:00Z")],
        },
      ],
    });
    expect(got.dispatched).toEqual([
      ["atlas", `${ATLAS}#4`],
      ["docs", `${DOCS}#1`],
    ]);
    expect(got.lines).toContain(
      `atlas: dispatched revise ${ATLAS}#4; 2 more wait for later polls`,
    );
  });

  it("skips a pull request with a revision run in progress, telling #1 from #12", async () => {
    const running: WorkflowRun = {
      status: "in_progress",
      conclusion: null,
      title: `job-atlas revise ${ATLAS}#12`,
      createdAt: "2026-10-01T10:30:00Z",
    };
    const got = await poll(
      [prJob("atlas")],
      {
        [ATLAS]: [
          asks(12, "2026-10-01T09:00:00Z"),
          asks(1, "2026-10-01T10:00:00Z"),
        ],
      },
      { runs: { atlas: [running] } },
    );
    expect(got.lines).toContain(
      `${ATLAS}#12: skipped, a revision run of it is in progress`,
    );
    expect(got.dispatched).toEqual([["atlas", `${ATLAS}#1`]]);
  });

  it("does not retry a revision run that ended without answering, until someone asks again; a canceled one is retried", async () => {
    const ended = (conclusion: string): WorkflowRun => ({
      status: "completed",
      conclusion,
      title: `job-atlas revise ${ATLAS}#3`,
      createdAt: "2026-10-01T10:10:00Z",
    });
    const threads = { [ATLAS]: [asks(3, "2026-10-01T10:00:00Z")] };
    const failed = await poll([prJob("atlas")], threads, {
      runs: { atlas: [ended("failure")] },
    });
    expect(failed.dispatched).toEqual([]);
    expect(failed.lines.at(-1)).toBe(
      `${ATLAS}#3: skipped, a revision run started after its newest request ended failure without answering; a new request starts another`,
    );
    const canceled = await poll([prJob("atlas")], threads, {
      runs: { atlas: [ended("cancelled")] },
    });
    expect(canceled.dispatched).toEqual([["atlas", `${ATLAS}#3`]]);
    const askedAgain = asks(3, "2026-10-01T10:00:00Z");
    askedAgain.comments!.push(
      comment(99, "/agent try again", "2026-10-01T10:40:00Z"),
    );
    const again = await poll(
      [prJob("atlas")],
      { [ATLAS]: [askedAgain] },
      {
        runs: { atlas: [ended("failure")] },
      },
    );
    expect(again.dispatched).toEqual([["atlas", `${ATLAS}#3`]]);
  });

  it("dispatches once more after the last round, so the run says a person takes over, and not after that notice", async () => {
    const done = (extra: Record<string, unknown>[] = []): Thread => ({
      pull: pull(ATLAS, 3, BRANCH),
      comments: [
        comment(30, "/agent first", "2026-10-01T08:00:00Z"),
        botComment(
          31,
          revisionMarker(5, ["comment-30"]),
          "2026-10-01T08:30:00Z",
        ),
        comment(32, "/agent one more", "2026-10-01T09:00:00Z"),
        ...extra,
      ],
    });
    const limit = await poll([prJob("atlas")], { [ATLAS]: [done()] });
    expect(limit.dispatched).toEqual([["atlas", `${ATLAS}#3`]]);
    expect(limit.lines).toContain(
      `${ATLAS}#3: 1 request waiting, but its revision rounds are used up; a run will say a person needs to take it from here`,
    );
    const noticed = await poll([prJob("atlas")], {
      [ATLAS]: [
        done([
          botComment(
            33,
            `A person needs to take it from here.\n\n${LIMIT_MARKER}`,
            "2026-10-01T09:20:00Z",
          ),
        ]),
      ],
    });
    expect(noticed.dispatched).toEqual([]);
  });

  it("reports a pull request it cannot read and goes on with the others", async () => {
    const got = await poll(
      [prJob("atlas")],
      {
        [ATLAS]: [
          asks(3, "2026-10-01T09:00:00Z"),
          asks(4, "2026-10-01T10:00:00Z"),
        ],
      },
      { failing: [`/repos/${ATLAS}/pulls/3/reviews`] },
    );
    expect(got.lines).toContain(
      `${ATLAS}#3: could not be read: GET /repos/${ATLAS}/pulls/3/reviews returned 502`,
    );
    expect(got.dispatched).toEqual([["atlas", `${ATLAS}#4`]]);
    expect(got.readFailures).toBe(1);
    expect(got.reads).toBe(2);
  });

  it("reports a repository it cannot list and goes on with the others", async () => {
    const got = await poll(
      [prJob("atlas", [DOCS, ATLAS])],
      { [ATLAS]: [asks(3, "2026-10-01T09:00:00Z")] },
      { failing: [`/repos/${DOCS}/pulls`] },
    );
    expect(got.lines[0]).toBe(
      `atlas: could not list the pull requests of ${DOCS}: GET /repos/${DOCS}/pulls returned 502`,
    );
    expect(got.dispatched).toEqual([["atlas", `${ATLAS}#3`]]);
    expect(got.readFailures).toBe(1);
  });

  it("counts a refused dispatch", async () => {
    const got = await poll(
      [prJob("atlas")],
      { [ATLAS]: [asks(3, "2026-10-01T09:00:00Z")] },
      { dispatchFails: true },
    );
    expect(got.dispatchFailures).toBe(1);
    expect(got.lines.at(-1)).toBe(
      `atlas: could not dispatch revise ${ATLAS}#3: POST /dispatches returned 422`,
    );
  });
});

describe("namesTarget", () => {
  it("matches the run name's target exactly", () => {
    expect(namesTarget(`job-atlas revise ${ATLAS}#1`, `${ATLAS}#1`)).toBe(true);
    expect(namesTarget(`job-atlas revise ${ATLAS}#12`, `${ATLAS}#1`)).toBe(
      false,
    );
    expect(namesTarget("job-atlas", `${ATLAS}#1`)).toBe(false);
  });
});

describe("the poller's token", () => {
  it("reads organization members, so a member with a private membership counts as trusted", async () => {
    const { POLL_PERMISSIONS } = await import("../src/revise/poll.ts");
    expect(POLL_PERMISSIONS).toEqual({
      actions: "read",
      contents: "read",
      members: "read",
      metadata: "read",
      pull_requests: "read",
    });
  });
});

describe("the queued Notes Agent check", () => {
  it("is queued on the head commit for whoever asked, once the revision run is started", async () => {
    const got = await poll(
      [prJob("atlas")],
      { [ATLAS]: [asks(3, "2026-10-01T10:00:00Z")] },
      { queue: true },
    );
    expect(got.queued).toEqual([
      {
        job: "atlas",
        repo: ATLAS,
        number: 3,
        branch: BRANCH,
        headSha: "a".repeat(40),
        login: "dani",
        requests: 1,
      },
    ]);
    expect(got.lines.at(-1)).toBe(`${ATLAS}#3: queued its Notes Agent check`);
  });

  it("is not queued when the dispatch failed, and a refused check never fails the poll", async () => {
    const failed = await poll(
      [prJob("atlas")],
      { [ATLAS]: [asks(3, "2026-10-01T10:00:00Z")] },
      { queue: true, dispatchFails: true },
    );
    expect(failed.queued).toEqual([]);
    const refused = await poll(
      [prJob("atlas")],
      { [ATLAS]: [asks(3, "2026-10-01T10:00:00Z")] },
      {
        queue:
          "Notes Agent / atlas: the writer app has no Checks permission on this installation yet",
      },
    );
    expect(refused.dispatched).toEqual([["atlas", `${ATLAS}#3`]]);
    expect(refused.dispatchFailures).toBe(0);
    expect(refused.lines.at(-1)).toBe(
      `${ATLAS}#3: its Notes Agent check was not queued: Notes Agent / atlas: the writer app has no Checks permission on this installation yet`,
    );
  });
});
