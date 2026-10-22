import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type {
  OpenedPoster,
  PostedMessage,
} from "../src/deliver/slack-poster.ts";
import { generate } from "../src/generate/generate.ts";
import type { Output } from "../src/lib/job.ts";
import { PATCH_SET_SCHEMA } from "../src/lib/schemas.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { postAnalysis } from "../src/run-job/analysis-output.ts";
import type { PrNotify } from "../src/run-job/load.ts";
import { checkPublished } from "../src/run-job/publish-script.ts";
import { ReportWriter } from "../src/run-job/report.ts";
import { runJob } from "../src/run-job/run.ts";
import type { SlackMessage } from "../src/run-job/slack-render.ts";
import { jobFiles, makeRepo } from "./helpers.ts";

const JOB = "crash-check";
const RUN_URL = "https://github.com/notes-co/agents/actions/runs/123";
const CRASHES = { name: "crash-investigations", id: "C0CRASH001" };
const SHADOW = { name: "agents-shadow", id: "C0SHADOW01" };
const NOTIFY: PrNotify = {
  channel: CRASHES,
  shadow: SHADOW,
  links: ["https://logs.svc.notes-co.example/"],
};
const OUTPUT: Extract<Output, { kind: "pr" }> = {
  kind: "pr",
  repos: ["notes-co/engine"],
  paths: ["runtime/src/**/*.rs"],
  max_changed_lines: 120,
  untrusted_input: "open_pr",
  notify: CRASHES.name,
};
const PROJECT = "3f2a9c1e-1b2c-4d5e-8f90-0123456789ab";
// Built at runtime so no key-shaped literal sits in the source.
const SECRET = ["run", "secret", "value", "9a8b7c6d"].join("-");

const ANALYSIS: SlackMessage = {
  text: `engine OOMKilled for project ${PROJECT}; no pull request`,
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Infra, not code*: the pod hit its memory limit. <https://logs.svc.notes-co.example/web/logs|logs> <https://evil.example/x|more> @here token ${SECRET}`,
      },
    },
  ],
  unfurl_links: false,
  unfurl_media: false,
};

function poster(fail = false) {
  const posts: { channel: string; message: SlackMessage }[] = [];
  const open = (): Promise<OpenedPoster> =>
    Promise.resolve({
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
  return { posts, open };
}

function report() {
  const dir = mkdtempSync(join(tmpdir(), "pr-analysis-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, report: new ReportWriter(dir, [SECRET]) };
}

function options(
  r: ReturnType<typeof report>,
  extra: Partial<Parameters<typeof postAnalysis>[0]> = {},
): Parameters<typeof postAnalysis>[0] {
  return {
    job: JOB,
    output: OUTPUT,
    mode: "live",
    stub: false,
    message: ANALYSIS,
    notify: NOTIFY,
    runUrl: RUN_URL,
    untrusted: { seen: false, model: [], collect: [] },
    report: r.report,
    ...extra,
  };
}

describe("the analysis a pull request job posts when it publishes nothing", () => {
  it("live, goes to output.notify, scrubbed and with links and mentions cleaned", async () => {
    const r = report();
    const p = poster();
    const { record, failure } = await postAnalysis(
      options(r, { openPoster: p.open }),
    );
    expect(failure).toBeUndefined();
    expect(record.outcome).toBe("delivered");
    expect(record.channel).toEqual(CRASHES);
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0]!.channel).toBe(CRASHES.id);
    const sent = JSON.stringify(p.posts[0]!.message);
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain(PROJECT);
    expect(sent).toContain("project :id");
    expect(sent).toContain("<https://logs.svc.notes-co.example/web/logs|logs>");
    expect(sent).not.toContain("evil.example/x|");
    expect(sent).not.toContain(" @here");
    expect(record.changes.length).toBeGreaterThan(0);
    const kept = JSON.parse(
      readFileSync(join(r.dir, "delivery", "analysis.json"), "utf8"),
    );
    expect(kept.channel).toBe(CRASHES.id);
    expect(kept.text).toBe(p.posts[0]!.message.text);
  });

  it("in shadow, goes to the shadow channel under the shadow line; a stub run posts nothing", async () => {
    const r = report();
    const p = poster();
    const { record } = await postAnalysis(
      options(r, { mode: "shadow", openPoster: p.open }),
    );
    expect(record).toMatchObject({ outcome: "delivered", shadow: true });
    expect(p.posts[0]!.channel).toBe(SHADOW.id);
    expect(p.posts[0]!.message.text).toMatch(
      /^Shadow run of crash-check, not a live post\./,
    );
    const s = report();
    const q = poster();
    const stub = await postAnalysis(
      options(s, { stub: true, openPoster: q.open }),
    );
    expect(stub.record).toMatchObject({
      outcome: "shadow",
      reason: "a stub run posts nothing",
    });
    expect(q.posts).toEqual([]);
    expect(existsSync(join(s.dir, "delivery", "analysis.json"))).toBe(true);
  });

  it("stays in the report without output.notify, or when the job reports untrusted runs only", async () => {
    const r = report();
    const p = poster();
    const { notify: _unused, ...withoutNotify } = options(r, {
      openPoster: p.open,
    });
    const none = await postAnalysis(withoutNotify);
    expect(none.record).toEqual({
      outcome: "report_only",
      reason:
        "the job has no output.notify, so the analysis stays in the report",
      changes: expect.any(Array),
    });
    const gated = await postAnalysis(
      options(r, {
        output: { ...OUTPUT, untrusted_input: "report_only" },
        untrusted: { seen: true, model: ["slack-history"], collect: [] },
        openPoster: p.open,
      }),
    );
    expect(gated.record.outcome).toBe("report_only");
    expect(gated.record.reason).toContain("untrusted_input: report_only");
    expect(p.posts).toEqual([]);
  });

  it("fails the run when it cannot be posted", async () => {
    const r = report();
    const { record, failure } = await postAnalysis(
      options(r, { openPoster: poster(true).open }),
    );
    expect(record.outcome).toBe("report_only");
    expect(failure).toBe(
      "posting the analysis to #crash-investigations failed: channel_not_found",
    );
  });

  it("is a message as render.ts prints one, or render, and only when publish.ts publishes nothing", () => {
    expect(
      checkPublished({
        publish: false,
        reason: "infra",
        message: { text: "t", blocks: ANALYSIS.blocks },
      }),
    ).toEqual({
      publish: false,
      reason: "infra",
      message: { text: "t", blocks: ANALYSIS.blocks },
    });
    expect(
      checkPublished({ publish: false, reason: "infra", message: "render" }),
    ).toEqual({ publish: false, reason: "infra", message: "render" });
    expect(
      checkPublished({
        publish: false,
        reason: "infra",
        message: { text: "t", blocks: [{ type: "image" }] },
      }),
    ).toEqual({
      error:
        "message: block 1 has type image; a report uses only header, section, divider, context",
    });
    expect(
      checkPublished({
        publish: true,
        answer: { pages: [] },
        message: "render",
      }),
    ).toHaveProperty("error");
    expect(checkPublished({ publish: false, reason: "infra" })).toEqual({
      publish: false,
      reason: "infra",
    });
  });

  it("is kept by a stub run of a job whose publish.ts publishes nothing, with its full text in analysis.md and the summary", async () => {
    const PUBLISH = `const chunks = [];
for await (const c of process.stdin) chunks.push(c);
console.log(JSON.stringify({ publish: false, reason: "an infra problem, not code", message: { text: "engine was OOMKilled", blocks: [{ type: "section", text: { type: "mrkdwn", text: "*engine* was OOMKilled; no pull request." } }] }, sections: [{ title: "What happened", paragraphs: ["The pod hit its memory limit."], items: ["First item", "Second item"] }, { title: "Prompt", code: "Dig in.\\n\\nThen fix." }] }));
`;
    const root = makeRepo({
      jobs: {
        demo: {
          ...jobFiles("demo", {
            output: {
              kind: "pr",
              repos: ["notes-co/engine"],
              paths: ["runtime/src/**/*.rs"],
              max_changed_lines: 10,
              untrusted_input: "open_pr",
              notify: "agents-shadow",
            },
          }),
          "output.json": JSON.stringify(PATCH_SET_SCHEMA),
          "fixtures/input.json": JSON.stringify({ pages: [] }),
          "fixtures/output.json": JSON.stringify({ pages: [] }),
          "publish.ts": PUBLISH,
        },
      },
      repos: ["notes-co/engine"],
      files: { "package.json": JSON.stringify({ type: "module" }) },
    });
    await generate(loadRepo(root));
    const dir = mkdtempSync(join(tmpdir(), "pr-analysis-run-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const result = await runJob({
      root,
      name: "demo",
      stub: true,
      scratch: dir,
      out: join(dir, "report"),
      identity: { uid: process.getuid!(), home: "/nonexistent-home" },
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.report?.publish).toEqual({
      publish: false,
      reason: "an infra problem, not code",
    });
    expect(result.report?.analysis).toMatchObject({
      outcome: "shadow",
      reason: "a stub run posts nothing",
    });
    const kept = JSON.parse(
      readFileSync(join(dir, "report", "delivery", "analysis.json"), "utf8"),
    ) as SlackMessage;
    expect(kept.text).toBe(
      "Shadow run of demo, not a live post. engine was OOMKilled",
    );
    expect(kept.blocks.at(-1)!.type).toBe("context");
    const analysis = readFileSync(join(dir, "report", "analysis.md"), "utf8");
    expect(analysis).toContain("**What happened**");
    expect(analysis).toContain("- First item\n- Second item");
    expect(analysis).toContain("```text\nDig in.\n\nThen fix.\n```");
    expect(readFileSync(join(dir, "report", "summary.md"), "utf8")).toContain(
      `#### Analysis\n\n${analysis}`,
    );
  });
});
