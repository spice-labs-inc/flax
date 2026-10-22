import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { generate } from "../src/generate/generate.ts";
import { PATCH_SET_SCHEMA } from "../src/lib/schemas.ts";
import { loadRepo } from "../src/lib/repo.ts";
import type {
  LaunchRequest,
  LaunchResult,
  Launcher,
} from "../src/run-job/launcher.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import {
  LIMIT_MARKER,
  MAX_ROUNDS,
  revisionMarker,
} from "../src/revise/requests.ts";
import type { PullThread } from "../src/revise/thread.ts";
import { TEST_ISSUER_KEY, testGateway } from "./fake-gateway.ts";
import { writeFakeLbx } from "./fake-lbx.ts";
import { FakeWriter } from "./fake-writer.ts";
import { jobFiles, makeRepo } from "./helpers.ts";

const WRITER_KEY = ["writer", "private", "key", "9a8b7c6d"].join("-");
const WHO = { uid: process.getuid!(), home: "/nonexistent-home" };
const ATLAS = "notes-co/atlas";
const BASE = "c".repeat(40);
const HEAD = "d".repeat(40);
const ENGINE = "f".repeat(40);
const NOW = new Date("2026-10-02T04:00:00Z");
const PATH = "repos/engine.md";
const BRANCH = "agent/demo/2026-10-01";

const PAGE = [
  "---",
  "name: engine",
  "---",
  "",
  "# engine",
  "",
  "Listens on port 8080.",
];
const HEAD_PAGE = PAGE.map((l) => l.replace("8080", "9090"));

/** The input of the run that opened the pull request. */
const ORIGINAL = {
  pages: [{ repo: ATLAS, path: PATH, commit: BASE, lines: PAGE }],
  sources: [
    {
      kind: "commit",
      repo: "notes-co/engine",
      commit: ENGINE,
      date: "2026-09-29T12:00:00Z",
      title: "Move to port 9090",
      files: [{ path: "src/main.rs", status: "modified" }],
      excerpt: [
        {
          path: "src/main.rs",
          removed: ["let port = 8080;"],
          added: ["let port = 9090;"],
        },
      ],
    },
  ],
};

const REVISED = {
  pages: [
    {
      repo: ATLAS,
      path: PATH,
      decision: "patch",
      reason: "The reviewer says the port is served over TLS.",
      patch: `--- a/${PATH}\n+++ b/${PATH}\n@@ -7 +7 @@\n-Listens on port 9090.\n+Listens on port 9090 over TLS.\n`,
      changes: [
        {
          removed: ["Listens on port 9090."],
          added: ["Listens on port 9090 over TLS."],
          evidence: [{ repo: ATLAS, path: "review/comment-1", line: 1 }],
        },
      ],
    },
  ],
  revision_replies: [
    {
      request: "comment-1",
      reply: "Added that the port is served over TLS.",
      changed: true,
    },
  ],
};

const APPROVE = {
  verdict: "approve",
  reasons: [{ text: "The request says so." }],
};

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-revise-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function repo(mode: "live" | "shadow" = "live"): Promise<string> {
  const root = makeRepo({
    jobs: {
      demo: {
        ...jobFiles("demo", {
          mode,
          output: {
            kind: "pr",
            repos: [ATLAS],
            paths: ["repos/*.md", "INDEX.md"],
            max_changed_lines: 40,
            untrusted_input: "report_only",
          },
        }),
        "prompt.md": "Correct facts on the atlas pages from the commits.\n",
        "output.json": JSON.stringify(PATCH_SET_SCHEMA),
        "fixtures/input.json": JSON.stringify(ORIGINAL),
        "fixtures/output.json": JSON.stringify({ pages: [] }),
        ...(mode === "live"
          ? {
              "SHADOW_RUNS.md": Array.from(
                { length: 4 },
                (_, i) =>
                  `- https://github.com/notes-co/agents/actions/runs/${i + 1}`,
              ).join("\n"),
            }
          : {}),
      },
    },
    repos: [ATLAS],
  });
  await generate(loadRepo(root));
  return root;
}

/** Plays Pi in the box: the revision's answer, then the second check's verdict. */
class ScriptedLauncher implements Launcher {
  readonly kind = "lbx";
  readonly seen: { runName: string; input: unknown; prompt: string }[] = [];
  private readonly main: unknown;
  private readonly review: unknown;

  constructor(main: unknown, review: unknown = APPROVE) {
    this.main = main;
    this.review = review;
  }

  launch(request: LaunchRequest): Promise<LaunchResult> {
    const dir = dirname(request.answerPath);
    this.seen.push({
      runName: request.runName,
      input: JSON.parse(readFileSync(join(dir, "input.json"), "utf8")),
      prompt: readFileSync(join(dir, "prompt.md"), "utf8"),
    });
    const isReview = request.runName.endsWith("-review");
    writeFileSync(
      request.answerPath,
      JSON.stringify(isReview ? this.review : this.main),
    );
    return Promise.resolve({
      exitCode: 0,
      status: { status: "exited", code: 0 },
      statusSource: "file",
    });
  }
}

const request = (id: number, body: string, at = "2026-10-01T20:00:00Z") => ({
  id,
  author: "dani",
  association: "MEMBER",
  byBot: false,
  body,
  url: `https://github.com/${ATLAS}/pull/100#issuecomment-${id}`,
  createdAt: at,
});

/** A writer holding an open agent pull request at HEAD, with these comments. */
function writerWith(comments: PullThread["comments"]) {
  const w = new FakeWriter();
  const pull = w.open({ repo: ATLAS, branch: BRANCH, draft: true });
  w.put(ATLAS, HEAD, PATH, `${HEAD_PAGE.join("\n")}\n`);
  w.branches.set(`${ATLAS}:${BRANCH}`, HEAD);
  w.threads.set(`${ATLAS}#${pull.number}`, {
    pull: {
      repo: ATLAS,
      number: pull.number,
      url: pull.url,
      state: "open",
      merged: false,
      branch: BRANCH,
      headSha: HEAD,
      sameRepo: true,
      byBot: true,
      body: "| Run | [job-demo-55-1](https://github.com/notes-co/agents/actions/runs/55) |",
    },
    files: [PATH],
    reviews: [],
    reviewComments: [],
    comments,
  });
  const hook = () =>
    Promise.resolve({
      writer: w,
      secrets: [] as string[],
      close: () => Promise.resolve(),
    });
  return { w, pull, hook };
}

async function options(
  root: string,
  number: number,
  extra: Partial<RunOptions> = {},
): Promise<RunOptions> {
  const dir = scratch();
  const gw = await testGateway({
    catalog: { "test-model": { display_name: "Test" } },
  });
  return {
    root,
    name: "demo",
    scratch: dir,
    out: join(dir, "report"),
    env: {
      LLM_GATEWAY_ISSUER_KEY: TEST_ISSUER_KEY,
      PATH: process.env.PATH ?? "",
      AGENTS_WRITER_APP_ID: "12",
      AGENTS_WRITER_PRIVATE_KEY: WRITER_KEY,
    },
    identity: WHO,
    log: () => {},
    now: () => NOW,
    lbx: writeFakeLbx(scratch()),
    gateway: gw.gateway,
    socketBases: [scratch()],
    revise: { repo: ATLAS, number },
    readOriginal: (job, runId) =>
      job === "demo" && runId === 55
        ? Promise.resolve(ORIGINAL)
        : Promise.reject(new Error(`no run ${runId}`)),
    ...extra,
  };
}

function lastComment(w: FakeWriter, number: number): string {
  return w.threads.get(`${ATLAS}#${number}`)!.comments.at(-1)!.body;
}

describe("a revision run", () => {
  it("answers a /agent request: pushes onto the pull request's branch, forward only, and replies", async () => {
    const { w, pull, hook } = writerWith([
      request(1, "/agent it is served over TLS, say so"),
    ]);
    const launcher = new ScriptedLauncher(REVISED);
    const opts = await options(await repo(), pull.number, {
      launcher,
      writer: hook,
    });
    const result = await runJob(opts);
    expect(result.messages[0]).toBe("demo: answer accepted.");
    expect(result.ok).toBe(true);

    const [main] = launcher.seen;
    const input = main!.input as Record<string, unknown>;
    expect(input.pages).toEqual([
      { repo: ATLAS, commit: HEAD, path: PATH, lines: HEAD_PAGE },
    ]);
    expect((input.sources as unknown[]).at(-1)).toMatchObject({
      kind: "review",
      id: "comment-1",
      lines: ["it is served over TLS, say so"],
    });
    expect(input.revision).toMatchObject({
      pull: pull.number,
      round: 1,
      branch: BRANCH,
      head: HEAD,
    });
    expect(main!.prompt).toContain("## This run revises a pull request");

    expect(w.commits).toHaveLength(1);
    expect(w.commits[0]!.request).toMatchObject({
      base: HEAD,
      branch: BRANCH,
      fastForwardFrom: HEAD,
    });
    expect(w.commits[0]!.request.files[0]).toMatchObject({
      text: expect.stringContaining("Listens on port 9090 over TLS."),
    });
    expect(
      w.calls.filter((c) =>
        /openPull|updatePull|closePull|deleteBranch/.test(c),
      ),
    ).toEqual([]);

    const reply = lastComment(w, pull.number);
    expect(reply).toContain("Revision 1 of 5");
    expect(reply).toContain("pushed `eeeeeee`, changed 1 page");
    expect(reply).toContain("Added that the port is served over TLS.");
    expect(reply).toContain(revisionMarker(1, ["comment-1"]));

    const status = JSON.parse(
      readFileSync(join(opts.out!, "status.json"), "utf8"),
    );
    expect(status.inputSource).toBe("revision");
    expect(status.revision).toMatchObject({
      repo: ATLAS,
      pull: pull.number,
      decision: "revise",
      round: 1,
      requests: ["comment-1"],
      originalRun: 55,
      commented: true,
      problems: [],
    });
    expect(status.delivery).toMatchObject({
      outcome: "delivered",
      revision: { branch: BRANCH },
    });
    const summary = readFileSync(join(opts.out!, "summary.md"), "utf8");
    expect(summary).toContain(
      `| Revision | ${ATLAS}#${pull.number}: round 1, 1 request (comment-1), from run 55, reply posted |`,
    );
    // The round's Notes Agent check went in progress on the old head and completed; the new head got its own.
    const pushed = w.commits[0]!.sha;
    expect(
      w.checks.map((c) => [c.headSha, c.status, c.conclusion, c.title]),
    ).toEqual([
      [HEAD, "completed", "success", "Revised in eeeeeee, round 1 of 5"],
      [pushed, "completed", "success", "1 page changed, second check approved"],
    ]);
    expect(w.checks[0]!.updates).toBe(1);
    expect(status.revision.check).toMatchObject({
      name: "Notes Agent / demo",
      head: HEAD,
      conclusion: "success",
    });
    expect(status.delivery.revision.check).toMatchObject({
      head: pushed,
      conclusion: "success",
    });
    for (const f of readdirSync(opts.out!, { recursive: true }) as string[])
      if (!f.endsWith("/") && !f.includes("transcript"))
        try {
          expect(
            readFileSync(join(opts.out!, f), "utf8").includes(WRITER_KEY),
            f,
          ).toBe(false);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EISDIR") throw err;
        }
  });

  it("moves the poller's queued check to in progress, then completes it, instead of making another", async () => {
    const { w, pull, hook } = writerWith([
      request(1, "/agent it is served over TLS, say so"),
    ]);
    const queued = await w.createCheck(ATLAS, {
      name: "Notes Agent / demo",
      branch: BRANCH,
      headSha: HEAD,
      status: "queued",
      title: "Revision requested by @dani",
      summary: "s",
    });
    const statuses: string[] = [];
    const update = w.updateCheck.bind(w);
    w.updateCheck = (repo, id, fields) => {
      statuses.push(`${id} ${fields.status}`);
      return update(repo, id, fields);
    };
    const result = await runJob(
      await options(await repo(), pull.number, {
        launcher: new ScriptedLauncher(REVISED),
        writer: hook,
      }),
    );
    expect(result.ok).toBe(true);
    expect(statuses).toEqual([`${queued} in_progress`, `${queued} completed`]);
    expect(w.checks.filter((c) => c.headSha === HEAD)).toHaveLength(1);
  });

  it("does nothing, and starts no model, when no request is waiting", async () => {
    const { w, pull, hook } = writerWith([
      request(1, "/agent fix it"),
      {
        ...request(2, `Done.\n${revisionMarker(1, ["comment-1"])}`),
        byBot: true,
        association: "NONE",
      },
    ]);
    const launcher = new ScriptedLauncher(REVISED);
    const result = await runJob(
      await options(await repo(), pull.number, { launcher, writer: hook }),
    );
    expect(result.ok).toBe(true);
    expect(result.messages[0]).toBe(
      "demo: nothing to revise: no request is waiting for an answer.",
    );
    expect(launcher.seen).toEqual([]);
    expect(
      w.calls.filter(
        (c) => c.startsWith("comment") || c.startsWith("commitFiles"),
      ),
    ).toEqual([]);
    // Nothing to answer makes no check; one the poller queued would be closed.
    expect(w.checks).toEqual([]);
  });

  it("says once that the round limit is reached, without starting a model", async () => {
    const answered = Array.from({ length: MAX_ROUNDS }, (_, i) => ({
      ...request(
        200 + i,
        revisionMarker(i + 1, [`comment-${i + 10}`]),
        "2026-10-01T19:00:00Z",
      ),
      byBot: true,
      association: "NONE",
    }));
    const { w, pull, hook } = writerWith([
      ...answered,
      request(1, "/agent once more"),
    ]);
    const launcher = new ScriptedLauncher(REVISED);
    const result = await runJob(
      await options(await repo(), pull.number, { launcher, writer: hook }),
    );
    expect(result.ok).toBe(true);
    expect(launcher.seen).toEqual([]);
    expect(lastComment(w, pull.number)).toContain(LIMIT_MARKER);
    expect(w.checks).toEqual([
      expect.objectContaining({
        headSha: HEAD,
        status: "completed",
        conclusion: "neutral",
        title: `Revision limit reached: ${MAX_ROUNDS} rounds used`,
      }),
    ]);
  });

  it("writes nothing when someone pushed to the branch meanwhile, and says so on the pull request", async () => {
    const { w, pull, hook } = writerWith([
      request(1, "/agent it is served over TLS, say so"),
    ]);
    w.branches.set(`${ATLAS}:${BRANCH}`, "a".repeat(40));
    const result = await runJob(
      await options(await repo(), pull.number, {
        launcher: new ScriptedLauncher(REVISED),
        writer: hook,
      }),
    );
    expect(result.ok).toBe(false);
    expect(w.commits).toEqual([]);
    const reply = lastComment(w, pull.number);
    expect(reply).toContain(
      "nothing was pushed: delivering the pull request failed:",
    );
    expect(reply).toContain(revisionMarker(1, ["comment-1"]));
    expect(w.checks).toHaveLength(1);
    expect(w.checks[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
    expect(w.checks[0]!.title).toMatch(
      /^Revision failed: delivering the pull request failed:/,
    );
  });

  it("revises anyway when GitHub refuses every check call, and records it", async () => {
    const { w, pull, hook } = writerWith([
      request(1, "/agent it is served over TLS, say so"),
    ]);
    w.refuseChecks =
      "the writer app has no Checks permission on this installation yet";
    const opts = await options(await repo(), pull.number, {
      launcher: new ScriptedLauncher(REVISED),
      writer: hook,
    });
    const result = await runJob(opts);
    expect(result.ok).toBe(true);
    expect(w.commits).toHaveLength(1);
    const status = JSON.parse(
      readFileSync(join(opts.out!, "status.json"), "utf8"),
    );
    expect(status.revision.check.refused).toBe(
      "the writer app has no Checks permission on this installation yet",
    );
  });

  it("answers the requests with the reason when the original run's input cannot be read", async () => {
    const { w, pull, hook } = writerWith([request(1, "/agent fix it")]);
    const launcher = new ScriptedLauncher(REVISED);
    const result = await runJob(
      await options(await repo(), pull.number, {
        launcher,
        writer: hook,
        readOriginal: () =>
          Promise.reject(new Error("the artifact has expired")),
      }),
    );
    expect(result.ok).toBe(false);
    expect(launcher.seen).toEqual([]);
    expect(lastComment(w, pull.number)).toContain(
      "nothing was pushed: the input of run 55, which opened this pull request, could not be read: the artifact has expired.",
    );
  });

  it("keeps a revision the second check rejects as a report, and tells the reviewer", async () => {
    const { w, pull, hook } = writerWith([
      request(1, "/agent it is served over TLS, say so"),
    ]);
    const result = await runJob(
      await options(await repo(), pull.number, {
        launcher: new ScriptedLauncher(REVISED, {
          verdict: "reject",
          reasons: [{ text: "No." }],
        }),
        writer: hook,
      }),
    );
    expect(result.ok).toBe(true);
    expect(w.commits).toEqual([]);
    expect(lastComment(w, pull.number)).toContain(
      "nothing was pushed: the second check rejected the proposal",
    );
  });

  it("refuses a shadow job, which opens no pull requests to revise", async () => {
    const { hook } = writerWith([]);
    const result = await runJob(
      await options(await repo("shadow"), 100, { writer: hook }),
    );
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      "demo is in shadow mode and opens no pull requests, so it has none to revise",
    );
  });
});
