import { describe, expect, it } from "vitest";
import { FakeWriter } from "./fake-writer.ts";
import {
  checkPatchSet,
  citationProblem,
  isDocCitation,
  type CheckContext,
} from "../src/output-check/pr.ts";
import {
  splitRevisionReplies,
  withRevisionReplies,
} from "../src/revise/answer.ts";
import {
  limitComment,
  postRevision,
  revisionComment,
} from "../src/revise/comment.ts";
import { buildRevisionInput, revisionPaths } from "../src/revise/input.ts";
import { originalRunId, readOriginalInput } from "../src/revise/original.ts";
import { parseRevisionTarget } from "../src/revise/prepare.ts";
import {
  commandText,
  decide,
  LIMIT_MARKER,
  MAX_ROUNDS,
  pendingRequests,
  revisionMarker,
  revisionState,
} from "../src/revise/requests.ts";
import type { PullThread } from "../src/revise/thread.ts";
import { zipFiles } from "./fake-upstreams.ts";

const ATLAS = "notes-co/atlas";
const HEAD = "d".repeat(40);
const BRANCH = "agent/atlas-doc-refresh/2026-10-01";

function thread(extra: Partial<PullThread> = {}): PullThread {
  return {
    pull: {
      repo: ATLAS,
      number: 7,
      url: `https://github.com/${ATLAS}/pull/7`,
      state: "open",
      merged: false,
      branch: BRANCH,
      headSha: HEAD,
      sameRepo: true,
      byBot: true,
      body: "| Run | [job-atlas-doc-refresh-1-1](https://github.com/notes-co/agents/actions/runs/123) |",
    },
    files: ["repos/engine.md"],
    reviews: [],
    reviewComments: [],
    comments: [],
    ...extra,
  };
}

const comment = (
  id: number,
  body: string,
  association = "MEMBER",
  at = "2026-10-01T10:00:00Z",
  byBot = false,
) => ({
  id,
  author: byBot ? "agents-writer[bot]" : "dani",
  association,
  byBot,
  body,
  url: `https://github.com/${ATLAS}/pull/7#issuecomment-${id}`,
  createdAt: at,
});

describe("revision requests", () => {
  it("reads /agent comments from members and collaborators only, never from bots or anyone else", () => {
    const t = thread({
      comments: [
        comment(1, "/agent say 9090, not 8080"),
        comment(2, "/agent from a stranger", "CONTRIBUTOR"),
        comment(3, "looks fine to me"),
        comment(4, "/agentic is not the command"),
        comment(5, "/agent", "COLLABORATOR"),
        comment(6, "/agent from the bot itself", "NONE", undefined, true),
        comment(7, "  /AGENT\nmove the line\nunder Details", "OWNER"),
      ],
    });
    expect(pendingRequests(t).map((r) => [r.id, r.kind, r.text])).toEqual([
      ["comment-1", "comment", "say 9090, not 8080"],
      ["comment-7", "comment", "move the line\nunder Details"],
    ]);
  });

  it("takes a Request changes review's text and its line comments, and /agent line comments of any review", () => {
    const t = thread({
      reviews: [
        {
          id: 10,
          author: "dani",
          association: "MEMBER",
          state: "CHANGES_REQUESTED",
          body: "Two fixes, see the lines.",
          url: "u10",
          submittedAt: "2026-10-01T10:00:00Z",
        },
        {
          id: 11,
          author: "aria",
          association: "MEMBER",
          state: "COMMENTED",
          body: "",
          url: "u11",
          submittedAt: "2026-10-01T10:05:00Z",
        },
      ],
      reviewComments: [
        {
          id: 20,
          reviewId: 10,
          author: "dani",
          association: "MEMBER",
          path: "repos/engine.md",
          line: 8,
          body: "```suggestion\nListens on port 9090.\n```",
          url: "u20",
          createdAt: "2026-10-01T10:00:00Z",
        },
        {
          id: 21,
          reviewId: 11,
          author: "aria",
          association: "MEMBER",
          path: "repos/engine.md",
          line: 3,
          body: "a thought, no command",
          url: "u21",
          createdAt: "2026-10-01T10:05:00Z",
        },
        {
          id: 22,
          reviewId: 11,
          author: "aria",
          association: "MEMBER",
          path: "INDEX.md",
          line: 40,
          body: "/agent add engine's new port here too",
          url: "u22",
          createdAt: "2026-10-01T10:06:00Z",
        },
      ],
    });
    expect(
      pendingRequests(t).map((r) => [r.id, r.path, r.line, r.text]),
    ).toEqual([
      ["review-10", undefined, undefined, "Two fixes, see the lines."],
      [
        "line-20",
        "repos/engine.md",
        8,
        "```suggestion\nListens on port 9090.\n```",
      ],
      ["line-22", "INDEX.md", 40, "add engine's new port here too"],
    ]);
  });

  it("leaves out answered requests and those older than the latest approval", () => {
    const t = thread({
      reviews: [
        {
          id: 30,
          author: "dani",
          association: "MEMBER",
          state: "APPROVED",
          body: "",
          url: "",
          submittedAt: "2026-10-01T11:00:00Z",
        },
      ],
      comments: [
        comment(1, "/agent first", "MEMBER", "2026-10-01T09:00:00Z"),
        comment(2, "/agent second", "MEMBER", "2026-10-01T10:00:00Z"),
        comment(
          3,
          `Done.\n${revisionMarker(1, ["comment-2"])}`,
          "NONE",
          "2026-10-01T10:30:00Z",
          true,
        ),
        comment(4, "/agent after approval", "MEMBER", "2026-10-01T12:00:00Z"),
      ],
    });
    expect(pendingRequests(t).map((r) => r.id)).toEqual(["comment-4"]);
    expect(revisionState(t)).toEqual({
      rounds: 1,
      answered: new Set(["comment-2"]),
      limitNoticed: false,
    });
  });

  it("decides nothing, a round, or the round limit", () => {
    expect(decide(thread(), "atlas-doc-refresh")).toMatchObject({
      action: "none",
      reason: "no request is waiting for an answer",
    });
    const asked = thread({ comments: [comment(1, "/agent fix it")] });
    expect(decide(asked, "atlas-doc-refresh")).toMatchObject({
      action: "revise",
      round: 1,
    });
    expect(decide(asked, "other-job").action).toBe("none");
    const human = thread({ comments: [comment(1, "/agent fix it")] });
    human.pull.byBot = false;
    expect(decide(human, "atlas-doc-refresh").action).toBe("none");
    const closed = thread({ comments: [comment(1, "/agent fix it")] });
    closed.pull.state = "closed";
    expect(decide(closed, "atlas-doc-refresh").action).toBe("none");

    const done = (extra: ReturnType<typeof comment>[]) =>
      thread({
        comments: [
          ...Array.from({ length: MAX_ROUNDS }, (_, i) =>
            comment(
              100 + i,
              revisionMarker(i + 1, [`comment-${i}`]),
              "NONE",
              "2026-10-01T09:00:00Z",
              true,
            ),
          ),
          comment(50, "/agent once more", "MEMBER", "2026-10-01T12:00:00Z"),
          ...extra,
        ],
      });
    expect(decide(done([]), "atlas-doc-refresh").action).toBe("limit");
    expect(
      decide(
        done([comment(60, LIMIT_MARKER, "NONE", undefined, true)]),
        "atlas-doc-refresh",
      ).action,
    ).toBe("none");
  });

  it("reads the command only at the start of the first line", () => {
    expect(commandText("/agent  do it ")).toBe("do it");
    expect(commandText("please /agent do it")).toBeUndefined();
    expect(commandText("/agents do it")).toBeUndefined();
  });

  it("parses a revision target and the run a pull request body names", () => {
    expect(parseRevisionTarget(`${ATLAS}#7`)).toEqual({
      repo: ATLAS,
      number: 7,
    });
    expect(parseRevisionTarget("atlas#7")).toBeUndefined();
    expect(parseRevisionTarget(`${ATLAS}#0`)).toBeUndefined();
    expect(parseRevisionTarget(`${ATLAS}#7; rm -rf /`)).toBeUndefined();
    expect(originalRunId(thread().pull.body)).toBe(123);
    expect(originalRunId("no run here")).toBeUndefined();
  });
});

describe("the revision input", () => {
  const policy = {
    repos: [ATLAS],
    paths: ["repos/*.md", "INDEX.md"],
    maxChangedLines: 40,
  };
  const original = {
    pages: [
      {
        repo: ATLAS,
        path: "repos/engine.md",
        commit: "c".repeat(40),
        lines: ["old"],
      },
    ],
    sources: [
      {
        kind: "code",
        repo: "notes-co/engine",
        commit: "f".repeat(40),
        path: "a.rs",
        start_line: 1,
        lines: ["x"],
      },
    ],
    stamps: [
      {
        repo: ATLAS,
        path: "repos/engine.md",
        commit: "c".repeat(40),
        key: "analyzed_commit",
        value: "abc",
      },
    ],
    rules: { repos: [ATLAS] },
  };

  it("takes the pages at the head, adds the requests as review sources, and drops the stamps", async () => {
    const t = thread({ files: ["repos/engine.md", "README.md"] });
    const requests = [
      {
        id: "line-22",
        kind: "line" as const,
        author: "aria",
        path: "INDEX.md",
        line: 40,
        text: "add the port\nhere too",
        url: "u22",
        at: "2026-10-01T10:00:00Z",
      },
    ];
    expect(revisionPaths(t, requests, policy)).toEqual([
      "INDEX.md",
      "repos/engine.md",
    ]);
    const built = await buildRevisionInput({
      original,
      thread: t,
      requests,
      round: 2,
      policy,
      readFile: (path, commit) =>
        Promise.resolve(
          commit === HEAD
            ? { text: `${path} at head\n`, mode: "100644" }
            : undefined,
        ),
    });
    if ("error" in built) throw new Error(built.error);
    const input = built.input;
    expect(input.stamps).toBeUndefined();
    expect(input.rules).toEqual(original.rules);
    expect(input.pages).toEqual([
      {
        repo: ATLAS,
        commit: HEAD,
        path: "INDEX.md",
        lines: ["INDEX.md at head"],
      },
      {
        repo: ATLAS,
        commit: HEAD,
        path: "repos/engine.md",
        lines: ["repos/engine.md at head"],
      },
    ]);
    expect((input.sources as unknown[]).at(-1)).toEqual({
      kind: "review",
      repo: ATLAS,
      commit: HEAD,
      id: "line-22",
      author: "aria",
      url: "u22",
      lines: ["add the port", "here too"],
    });
    expect(input.revision).toMatchObject({
      repo: ATLAS,
      pull: 7,
      head: HEAD,
      branch: BRANCH,
      round: 2,
      max_rounds: MAX_ROUNDS,
    });
  });

  it("refuses an original input with no pages, and a pull request with no page the job may change", async () => {
    const t = thread({ files: ["README.md"] });
    const read = () => Promise.resolve({ text: "x\n", mode: "100644" });
    expect(
      await buildRevisionInput({
        original: {},
        thread: t,
        requests: [],
        round: 1,
        policy,
        readFile: read,
      }),
    ).toEqual({
      error: expect.stringContaining("the original run's input is unusable"),
    });
    expect(
      await buildRevisionInput({
        original,
        thread: t,
        requests: [],
        round: 1,
        policy,
        readFile: read,
      }),
    ).toEqual({
      error: "the pull request has no page this job may change at its head",
    });
  });
});

describe("review requests as evidence", () => {
  const context: CheckContext = {
    policy: { repos: [ATLAS], paths: ["repos/*.md"], maxChangedLines: 40 },
    pinned: [
      {
        repo: ATLAS,
        commit: HEAD,
        path: "repos/engine.md",
        lines: ["# engine", "", "Listens on port 8080."],
      },
    ],
    sources: [
      {
        kind: "review",
        repo: ATLAS,
        commit: HEAD,
        id: "comment-1",
        author: "dani",
        url: "",
        lines: ["say 9090", "not 8080"],
      },
    ],
  };

  it("accepts a line of a given request, though it is in the atlas, and nothing else under review/", () => {
    expect(
      citationProblem(
        { repo: ATLAS, path: "review/comment-1", line: 2 },
        context,
      ),
    ).toBeUndefined();
    expect(
      citationProblem(
        { repo: ATLAS, path: "review/comment-1", line: 3 },
        context,
      ),
    ).toContain("not a line of a review request");
    expect(
      citationProblem(
        { repo: ATLAS, path: "review/comment-9", line: 1 },
        context,
      ),
    ).toContain("not a line of a review request");
    expect(
      citationProblem(
        { repo: ATLAS, path: "repos/engine.md", line: 1 },
        context,
      ),
    ).toContain("the atlas, which is never evidence");
  });

  it("lets a patch that cites the request pass the PR checker", () => {
    const result = checkPatchSet(
      {
        pages: [
          {
            repo: ATLAS,
            path: "repos/engine.md",
            decision: "patch",
            reason: "The reviewer gave the port.",
            patch:
              "--- a/repos/engine.md\n+++ b/repos/engine.md\n@@ -3 +3 @@\n-Listens on port 8080.\n+Listens on port 9090.\n",
            changes: [
              {
                removed: ["Listens on port 8080."],
                added: ["Listens on port 9090."],
                evidence: [{ repo: ATLAS, path: "review/comment-1", line: 1 }],
              },
            ],
          },
        ],
      },
      context,
    );
    expect(result.problems).toEqual([]);
    expect(result.pages.flatMap((p) => p.problems)).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("the revision answer and comment", () => {
  it("adds the replies to the schema as required and takes them off the answer", () => {
    const schema = withRevisionReplies({
      type: "object",
      required: ["pages"],
      properties: { pages: {} },
    }) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["pages", "revision_replies"]);
    expect(Object.keys(schema.properties)).toEqual([
      "pages",
      "revision_replies",
    ]);
    const split = splitRevisionReplies({
      pages: [],
      revision_replies: [
        { request: "comment-1", reply: "Done.", changed: true },
        { bad: 1 },
      ],
    });
    expect(split.answer).toEqual({ pages: [] });
    expect(split.replies).toEqual([
      { request: "comment-1", reply: "Done.", changed: true },
    ]);
  });

  const requests = [
    {
      id: "comment-1",
      kind: "comment" as const,
      author: "dani",
      text: "fix",
      url: "https://github.com/x/pull/7#issuecomment-1",
      at: "",
    },
    {
      id: "line-2",
      kind: "line" as const,
      author: "aria",
      path: "INDEX.md",
      line: 4,
      text: "and here",
      url: "",
      at: "",
    },
  ];

  it("says in one line what was pushed, answers requests without a thread as plain text, and marks every request answered", () => {
    const body = revisionComment({
      job: "atlas-doc-refresh",
      round: 2,
      runName: "job-atlas-doc-refresh-9-1",
      runUrl: "https://github.com/notes-co/agents/actions/runs/9",
      requests,
      replies: [
        {
          request: "comment-1",
          reply: "Changed 8080 to 9090. @everyone <b>",
          changed: true,
        },
      ],
      commit: "e".repeat(40),
      pages: [{ path: "repos/engine.md", changedLines: 2 }],
      threaded: new Set(["line-2"]),
    });
    expect(body.split("\n")[0]).toBe(
      "Revision 2 of 5 by the Notes Agent `atlas-doc-refresh`: pushed `eeeeeee`, changed 1 page; replied in each thread. ([job-atlas-doc-refresh-9-1](https://github.com/notes-co/agents/actions/runs/9))",
    );
    expect(body).toContain(
      '- `dani`\'s [comment](https://github.com/x/pull/7#issuecomment-1): "fix"',
    );
    expect(body).toContain("  Changed 8080 to 9090. @\u2060everyone &lt;b&gt;");
    expect(body).not.toContain("```");
    expect(body).not.toContain("and here");
    expect(
      body.trimEnd().endsWith(revisionMarker(2, ["comment-1", "line-2"])),
    ).toBe(true);
  });

  it("says why nothing was pushed, and still answers the requests", () => {
    const body = revisionComment({
      job: "j",
      round: 1,
      runName: "r",
      requests,
      replies: [],
      problem: "the second check rejected the proposal",
    });
    expect(body).toContain(
      "nothing was pushed: the second check rejected the proposal. Reply with `/agent`",
    );
    expect(body).toContain("Not answered in this round.");
    expect(body).toContain(revisionMarker(1, ["comment-1", "line-2"]));
    expect(limitComment("j")).toContain(LIMIT_MARKER);
  });

  it("replies to a line comment in its own thread, and answers in the summary when GitHub refuses the reply", async () => {
    const outcome = {
      job: "j",
      round: 1,
      runName: "r",
      requests: [
        ...requests,
        {
          id: "line-3",
          kind: "line" as const,
          author: "aria",
          path: "INDEX.md",
          text: "and there",
          url: "",
          at: "",
        },
      ],
      replies: [
        { request: "comment-1", reply: "Done.", changed: true },
        {
          request: "line-2",
          reply: "Fixed the port. See [x](y)",
          changed: true,
        },
        {
          request: "line-3",
          reply: "Left as is: it is right.",
          changed: false,
        },
      ],
      commit: "a".repeat(40),
      pages: [{ path: "INDEX.md", changedLines: 1 }],
    };
    const w = new FakeWriter();
    w.refuseThreads.add(3);
    const posted = await postRevision(
      w,
      "notes-co/atlas",
      7,
      outcome,
    );
    expect(w.threadReplies).toEqual([
      {
        repo: "notes-co/atlas",
        number: 7,
        commentId: 2,
        body: "Fixed the port. See \\[x\\]\\(y\\)",
      },
    ]);
    expect(posted.threaded).toEqual(["line-2"]);
    expect(posted.refused).toEqual([
      {
        request: "line-3",
        why: "POST /repos/notes-co/atlas/pulls/7/comments/3/replies returned 404",
      },
    ]);
    expect(posted.summary).toContain("Done.");
    expect(posted.summary).toContain("Left as is: it is right.");
    expect(posted.summary).not.toContain("Fixed the port.");
    expect(posted.summary).toContain(
      revisionMarker(1, ["comment-1", "line-2", "line-3"]),
    );
    expect(w.calls.filter((c) => c.startsWith("comment "))).toHaveLength(1);
  });
});

describe("the original run's input", () => {
  const job = "atlas-doc-refresh";
  const input = { pages: [], sources: [] };

  function fakeGithub(
    artifact: Record<string, unknown>,
    location = "https://results.example.net/zip",
  ) {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn = (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      seen.push({
        url: u,
        auth: new Headers(init?.headers).get("authorization"),
      });
      if (u.includes("/actions/runs/123/artifacts"))
        return Promise.resolve(Response.json({ artifacts: [artifact] }));
      if (u.endsWith("/actions/artifacts/55/zip"))
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location } }),
        );
      if (u === location)
        return Promise.resolve(
          new Response(
            zipFiles({
              "input.json": JSON.stringify(input),
              "status.json": "{}",
            }),
          ),
        );
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    return { seen, fetchFn: fetchFn as typeof fetch };
  }

  it("reads input.json from the run's report artifact, downloading without the token", async () => {
    const gh = fakeGithub({
      id: 55,
      name: `job-${job}-report`,
      expired: false,
      size_in_bytes: 100,
    });
    const got = await readOriginalInput({
      token: "t",
      job,
      runId: 123,
      downloadHosts: ["results.example.net"],
      fetch: gh.fetchFn,
    });
    expect(got).toEqual(input);
    expect(gh.seen.at(-1)).toEqual({
      url: "https://results.example.net/zip",
      auth: null,
    });
  });

  it("refuses an expired artifact and a download host not in the list", async () => {
    await expect(
      readOriginalInput({
        token: "t",
        job,
        runId: 123,
        downloadHosts: ["results.example.net"],
        fetch: fakeGithub({ id: 55, name: `job-${job}-report`, expired: true })
          .fetchFn,
      }),
    ).rejects.toThrow("has expired");
    await expect(
      readOriginalInput({
        token: "t",
        job,
        runId: 123,
        downloadHosts: ["results.example.net"],
        fetch: fakeGithub(
          { id: 55, name: `job-${job}-report` },
          "https://evil.example.com/zip",
        ).fetchFn,
      }),
    ).rejects.toThrow("not a host in github-log-hosts.yml");
  });
});

describe("documentation as evidence", () => {
  it("tells documentation from code, commits and review requests", () => {
    const at = (path?: string) => ({
      repo: "notes-co/widget",
      commit: "a".repeat(40),
      ...(path === undefined ? {} : { path }),
    });
    for (const p of [
      "README.md",
      "docs/adr/028-host-typed-credentials.md",
      "src/README",
      "plans/x.txt",
      "CHANGELOG.md",
    ])
      expect(isDocCitation(at(p)), p).toBe(true);
    for (const p of [
      "src/main/scala/Repo.scala",
      "editions.json",
      "build-survey",
      undefined,
    ])
      expect(isDocCitation(at(p)), String(p)).toBe(false);
    expect(
      isDocCitation({ repo: ATLAS, path: "review/comment-1", line: 1 }),
    ).toBe(false);
  });

  const context: CheckContext = {
    policy: { repos: [ATLAS], paths: ["repos/*.md"], maxChangedLines: 40 },
    pinned: [
      {
        repo: ATLAS,
        commit: HEAD,
        path: "repos/widget.md",
        lines: ["# widget", "", "Supports 13 registries."],
      },
    ],
    sources: [
      {
        kind: "code",
        repo: "notes-co/widget",
        commit: "a".repeat(40),
        path: "README.md",
        start_line: 1,
        lines: ["Supports 15 hosts."],
      },
      {
        kind: "code",
        repo: "notes-co/widget",
        commit: "a".repeat(40),
        path: "src/Hosts.scala",
        start_line: 1,
        lines: ["val hosts = 15"],
      },
    ],
  };
  const answer = (evidence: unknown[]) => ({
    pages: [
      {
        repo: ATLAS,
        path: "repos/widget.md",
        decision: "patch",
        reason: "Host count.",
        patch:
          "--- a/repos/widget.md\n+++ b/repos/widget.md\n@@ -3 +3 @@\n-Supports 13 registries.\n+Supports 15 hosts.\n",
        changes: [
          {
            removed: ["Supports 13 registries."],
            added: ["Supports 15 hosts."],
            evidence,
          },
        ],
      },
    ],
  });
  const readme = {
    repo: "notes-co/widget",
    path: "README.md",
    line: 1,
  };
  const code = {
    repo: "notes-co/widget",
    path: "src/Hosts.scala",
    line: 1,
  };

  it("refuses a change whose only evidence is a README, and accepts it with code that confirms it", () => {
    expect(checkPatchSet(answer([readme]), context).pages[0]!.problems).toEqual(
      [
        "change 1 cites only documentation (a README, ADR or docs file); cite the code or a commit that confirms it too",
      ],
    );
    expect(checkPatchSet(answer([readme, code]), context).ok).toBe(true);
    expect(checkPatchSet(answer([code]), context).ok).toBe(true);
  });
});
