import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { allowlistsCheck } from "../src/check/allowlists.ts";
import { jobSchemaCheck } from "../src/check/job-schema.ts";
import type {
  OpenedPoster,
  PostedMessage,
} from "../src/deliver/slack-poster.ts";
import { deliverySecrets } from "../src/generate/render.ts";
import type { JobConfig } from "../src/lib/job.ts";
import type { PrNotify } from "../src/run-job/load.ts";
import { runPrStage, type PrStageOptions } from "../src/run-job/pr-output.ts";
import { ReportWriter } from "../src/run-job/report.ts";
import type { SlackMessage } from "../src/run-job/slack-render.ts";
import { FakeWriter } from "./fake-writer.ts";
import { jobConfig, jobFiles, makeRepo, READ_CHANNEL, run } from "./helpers.ts";

const JOB = "release-notes";
const DOCS = "notes-co/public-docs";
const BASE = "c".repeat(40);
const NOW = new Date("2026-10-12T17:00:00Z");
const PAGE_PATH = "src/content/docs/whats-new/index.mdx";
const RUN_URL =
  "https://github.com/notes-co/agents/actions/runs/123";
const PRODUCT = { name: "product", id: "C0PRODUCT1" };
const SHADOW = { name: "agents-shadow", id: "C0SHADOW01" };
const NOTIFY: PrNotify = {
  channel: PRODUCT,
  shadow: SHADOW,
  links: ["https://github.com/notes-co/"],
};

const OUTPUT = {
  kind: "pr" as const,
  repos: [DOCS],
  paths: [PAGE_PATH],
  max_changed_lines: 50,
  untrusted_input: "open_pr" as const,
  notify: "product",
};

const PATCH = {
  repo: DOCS,
  path: PAGE_PATH,
  decision: "patch",
  reason: "Adds the week's digest.",
  patch: `--- a/${PAGE_PATH}\n+++ b/${PAGE_PATH}\n@@ -1 +1,2 @@\n # What's new\n+## October 12, 2026\n`,
};

function poster(fail = false) {
  const posts: { channel: string; message: SlackMessage }[] = [];
  let opened = 0;
  const open = (): Promise<OpenedPoster> => {
    opened++;
    return Promise.resolve({
      poster: {
        post(channel: string, message: SlackMessage): Promise<PostedMessage> {
          if (fail) return Promise.reject(new Error("channel_not_found"));
          posts.push({ channel, message });
          return Promise.resolve({
            channel,
            ts: "1700000000.000100",
            permalink: `https://notes-co.slack.com/archives/${channel}/p1700000000000100`,
          });
        },
      },
      secrets: [],
    });
  };
  return { posts, open, opened: () => opened };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pr-notice-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const w = new FakeWriter();
  w.put(DOCS, BASE, PAGE_PATH, "# What's new\n");
  return { dir, report: new ReportWriter(dir, []), w };
}

function options(
  s: ReturnType<typeof setup>,
  extra: Partial<PrStageOptions> = {},
): PrStageOptions {
  return {
    job: JOB,
    output: OUTPUT,
    mode: "live",
    stub: false,
    answer: { pages: [PATCH] },
    input: {
      pages: [
        { repo: DOCS, path: PAGE_PATH, commit: BASE, lines: ["# What's new"] },
      ],
    },
    jobPrompt: "",
    untrusted: { seen: false, model: [], collect: [] },
    model: "none",
    runName: "job-release-notes-1-1",
    runUrl: RUN_URL,
    report: s.report,
    now: NOW,
    review: () => Promise.reject(new Error("no second check for code")),
    openWriter: () =>
      Promise.resolve({
        writer: s.w,
        secrets: [],
        close: () => Promise.resolve(),
      }),
    builtByCode: true,
    notify: NOTIFY,
    ...extra,
  };
}

function noticeFile(dir: string): unknown {
  const path = join(dir, "delivery", "pr-notice.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

describe("the notice a pull request job posts", () => {
  it("live, tells the notify channel about the pull request it opened, once", async () => {
    const s = setup();
    const p = poster();
    const { record, failure } = await runPrStage(
      options(s, { openPoster: p.open }),
    );
    expect(failure).toBeUndefined();
    expect(record.outcome).toBe("delivered");
    const pull = s.w.pulls[0]!;
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0]!.channel).toBe(PRODUCT.id);
    const message = p.posts[0]!.message;
    expect(message.text).toBe(
      `${JOB} opened ${DOCS}#${pull.number} for review: ${pull.url}`,
    );
    expect(message.blocks[0]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${JOB}* opened <${pull.url}|${DOCS}#${pull.number}> for review: ${JOB}: 1 page (2026-10-12)`,
        verbatim: true,
      },
    });
    expect(JSON.stringify(message.blocks[1])).toContain(RUN_URL);
    expect(record.notice).toEqual({
      channel: PRODUCT.id,
      ts: "1700000000.000100",
      permalink: `https://notes-co.slack.com/archives/${PRODUCT.id}/p1700000000000100`,
    });
    expect(record.problems).toBeUndefined();
    expect(noticeFile(s.dir)).toMatchObject({
      channel: PRODUCT.id,
      text: message.text,
      link_names: false,
    });
  });

  it("says a pull request auto_merge merged was opened and merged", async () => {
    const s = setup();
    const p = poster();
    const { record } = await runPrStage(
      options(s, {
        output: { ...OUTPUT, auto_merge: { paths: ["src/content/**"] } },
        openPoster: p.open,
      }),
    );
    expect(record.pulls?.[0]?.autoMerge).toMatchObject({ merged: true });
    const pull = s.w.pulls[0]!;
    expect(p.posts[0]!.message.text).toBe(
      `${JOB} opened and merged ${DOCS}#${pull.number}: ${pull.url}`,
    );
  });

  it("posts nothing when the run only updated the pull request already open on the day's branch", async () => {
    const s = setup();
    s.w.open({ repo: DOCS, branch: `agent/${JOB}/2026-10-12` });
    const p = poster();
    const { record, failure } = await runPrStage(
      options(s, { openPoster: p.open }),
    );
    expect(failure).toBeUndefined();
    expect(record.pulls?.[0]?.updated).toBe(true);
    expect(p.opened()).toBe(0);
    expect(record.notice).toBeUndefined();
    expect(noticeFile(s.dir)).toBeUndefined();
  });

  it("records a failed post as a problem, and neither fails the run nor undoes the pull request", async () => {
    const s = setup();
    const p = poster(true);
    const { record, failure } = await runPrStage(
      options(s, { openPoster: p.open }),
    );
    expect(failure).toBeUndefined();
    expect(record.outcome).toBe("delivered");
    expect(s.w.pulls[0]!.state).toBe("open");
    expect(record.notice).toBeUndefined();
    expect(record.problems).toEqual([
      "the notice to #product failed: channel_not_found",
    ]);
  });

  it("records a poster that cannot start as a problem too", async () => {
    const s = setup();
    const { record, failure } = await runPrStage(
      options(s, {
        openPoster: () =>
          Promise.reject(new Error("SLACK_AGENTS_POST_TOKEN must be set")),
      }),
    );
    expect(failure).toBeUndefined();
    expect(record.outcome).toBe("delivered");
    expect(record.problems).toEqual([
      "the notice to #product failed: SLACK_AGENTS_POST_TOKEN must be set",
    ]);
  });

  it("in shadow, posts what it would post to the shadow channel under the shadow line, opening nothing", async () => {
    const s = setup();
    const p = poster();
    const { record, failure } = await runPrStage(
      options(s, {
        mode: "shadow",
        openPoster: p.open,
        openWriter: () => Promise.reject(new Error("shadow opens nothing")),
      }),
    );
    expect(failure).toBeUndefined();
    expect(record.outcome).toBe("shadow");
    expect(s.w.pulls).toEqual([]);
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0]!.channel).toBe(SHADOW.id);
    const message = p.posts[0]!.message;
    expect(message.text).toBe(
      `Shadow run of ${JOB}, not a live post. ${JOB} opened a pull request on ${DOCS} for review: ${JOB}: 1 page (2026-10-12)`,
    );
    expect(JSON.stringify(message.blocks[0])).toContain(
      `Shadow run of ${JOB}, not a live post. Live, it posts to #product.`,
    );
    expect(record.notice?.channel).toBe(SHADOW.id);
  });

  it("in shadow, posts nothing when the shadow channel has no id, and keeps what it would post", async () => {
    const s = setup();
    const p = poster();
    const { record } = await runPrStage(
      options(s, {
        mode: "shadow",
        notify: { channel: PRODUCT, links: NOTIFY.links },
        openPoster: p.open,
      }),
    );
    expect(record.outcome).toBe("shadow");
    expect(p.opened()).toBe(0);
    expect(record.problems).toBeUndefined();
    expect(noticeFile(s.dir)).toMatchObject({ channel: null });
  });

  it("posts nothing in a stub run", async () => {
    const s = setup();
    const p = poster();
    const { record } = await runPrStage(
      options(s, { stub: true, openPoster: p.open }),
    );
    expect(record.outcome).toBe("shadow");
    expect(p.opened()).toBe(0);
    expect(record.notice).toBeUndefined();
  });

  it("posts nothing without notify", async () => {
    const s = setup();
    const p = poster();
    const { notify: _, ...rest } = options(s, { openPoster: p.open });
    const { record } = await runPrStage(rest);
    expect(record.outcome).toBe("delivered");
    expect(p.opened()).toBe(0);
    expect(noticeFile(s.dir)).toBeUndefined();
  });
});

describe("notify on a pull request output in flax agents check", () => {
  const prOutput = {
    kind: "pr",
    repos: ["notes-co/example"],
    paths: ["docs/**"],
    max_changed_lines: 10,
    untrusted_input: "report_only",
  };

  it("takes a channel name without the #", async () => {
    const root = makeRepo({
      jobs: {
        good: jobFiles("good", { output: { ...prOutput, notify: "product" } }),
        bad: jobFiles("bad", { output: { ...prOutput, notify: "#product" } }),
      },
    });
    const problems = await run(jobSchemaCheck, root);
    expect(problems.filter((p) => p.startsWith("jobs/good/"))).toEqual([]);
    expect(problems.filter((p) => p.startsWith("jobs/bad/"))).toEqual([
      'jobs/bad/job.yml: output.notify: "#product" must match ^[a-z0-9][a-z0-9_-]{0,79}$',
    ]);
  });

  it("needs a channel from the post list, with an id when live", async () => {
    const root = makeRepo({
      jobs: {
        listed: jobFiles("listed", {
          mode: "live",
          output: { ...prOutput, notify: "product" },
        }),
        unlisted: jobFiles("unlisted", {
          output: { ...prOutput, notify: "nowhere" },
        }),
        "no-id": jobFiles("no-id", {
          mode: "live",
          output: { ...prOutput, notify: "later" },
        }),
        "no-id-shadow": jobFiles("no-id-shadow", {
          output: { ...prOutput, notify: "later" },
        }),
      },
      channels: {
        post: [PRODUCT, { name: "later" }],
        read: [READ_CHANNEL],
      },
    });
    expect(await run(allowlistsCheck, root)).toEqual([
      'jobs/no-id/job.yml: output.notify: "later" has no id in channels.yml; a live job posts by channel id',
      'jobs/unlisted/job.yml: output.notify: "nowhere" is not listed in channels.yml',
    ]);
  });
});

describe("the secrets a pull request job with notify gets", () => {
  const job = (mode: string, notify?: string) =>
    jobConfig(JOB, {
      mode,
      output: {
        ...OUTPUT,
        ...(notify === undefined ? { notify: undefined } : { notify }),
      },
    }) as unknown as JobConfig;

  it("passes the posting token in shadow and live, and the writer's only live", () => {
    expect(deliverySecrets(job("shadow", "product"))).toEqual([
      "SLACK_AGENTS_POST_TOKEN",
    ]);
    expect(deliverySecrets(job("live", "product"))).toEqual([
      "AGENTS_WRITER_APP_ID",
      "AGENTS_WRITER_PRIVATE_KEY",
      "SLACK_AGENTS_POST_TOKEN",
    ]);
    expect(deliverySecrets(job("live"))).toEqual([
      "AGENTS_WRITER_APP_ID",
      "AGENTS_WRITER_PRIVATE_KEY",
    ]);
    expect(deliverySecrets(job("shadow"))).toEqual([]);
  });
});
