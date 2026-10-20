import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { generate } from "../src/generate/generate.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import {
  checkRendered,
  footerBlock,
  mrkdwnToMarkdown,
  slackMarkdown,
  workflowRunUrl,
} from "../src/run-job/slack-render.ts";
import { jobFiles, makeRepo, MODEL } from "./helpers.ts";

const KEY = ["render", "test", "key", "5e4d3c2b1a"].join("-");
const WHO = { uid: process.getuid!(), home: "/nonexistent-home" };
const RUN_ENV = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "notes-co/agents",
  GITHUB_RUN_ID: "36606095916",
};

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-render-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const section = (text: string) => ({
  type: "section",
  text: { type: "mrkdwn", text },
});

describe("the Slack message of a job", () => {
  it("accepts the blocks a report uses and refuses what Slack or a report would not take", () => {
    const blocks = [
      { type: "header", text: { type: "plain_text", text: "Report" } },
      section("*Needs attention*"),
      { type: "divider" },
      { type: "context", elements: [{ type: "mrkdwn", text: "window" }] },
    ];
    expect(checkRendered({ text: "Report", blocks })).toEqual({
      text: "Report",
      blocks,
    });
    const problem = (value: unknown) =>
      (checkRendered(value) as { error: string }).error;
    expect(problem([])).toBe("it is not a JSON object");
    expect(problem({ text: "", blocks })).toBe(
      "text is not a non-empty string",
    );
    expect(problem({ text: "x", blocks: [] })).toBe(
      "blocks is not a non-empty array",
    );
    expect(
      problem({
        text: "x",
        blocks: Array.from({ length: 49 }, () => ({ type: "divider" })),
      }),
    ).toBe(
      "it has 49 blocks; at most 48 leave room for the footer and the shadow-run line",
    );
    expect(problem({ text: "x".repeat(2901), blocks })).toBe(
      "text is over 2900 characters; the rest is kept for marking a shadow run's post",
    );
    expect(checkRendered({ text: "x".repeat(2900), blocks })).toEqual({
      text: "x".repeat(2900),
      blocks,
    });
    expect(problem({ text: "x", blocks: [section("a".repeat(3001))] })).toBe(
      "block 1 (section) is over 3000 characters",
    );
    expect(
      problem({ text: "x", blocks: [{ type: "actions", elements: [] }] }),
    ).toBe(
      "block 1 has type actions; a report uses only header, section, divider, context",
    );
    expect(
      problem({ text: "x", blocks: [{ type: "context", elements: [] }] }),
    ).toBe("block 1 (context) has no elements");
  });

  it("links the workflow run in the footer, and says so when there is none", () => {
    expect(workflowRunUrl(RUN_ENV)).toBe(
      "https://github.com/notes-co/agents/actions/runs/36606095916",
    );
    expect(workflowRunUrl({ ...RUN_ENV, GITHUB_RUN_ID: "1; rm" })).toBe(
      undefined,
    );
    expect(workflowRunUrl({})).toBe(undefined);
    expect(
      footerBlock({
        runUrl: workflowRunUrl(RUN_ENV),
        job: "demo",
        model: MODEL,
      }),
    ).toEqual({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<https://github.com/notes-co/agents/actions/runs/36606095916|Workflow run 36606095916> · job demo · model ${MODEL}`,
        },
      ],
    });
    expect(
      footerBlock({ runUrl: undefined, job: "demo", model: MODEL }).elements,
    ).toEqual([
      {
        type: "mrkdwn",
        text: `Local run, no workflow run to link · job demo · model ${MODEL}`,
      },
    ]);
  });

  it("keeps a readable Markdown copy", () => {
    expect(
      mrkdwnToMarkdown(
        "*1. Rerun it*\nEvidence: <https://x.test/a|Run 1> · <https://x.test/b>\n• a &lt;b&gt; &amp; c",
      ),
    ).toBe(
      "**1. Rerun it**\nEvidence: [Run 1](https://x.test/a) · https://x.test/b\n- a <b> & c",
    );
    expect(
      slackMarkdown({
        text: "t",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Report" } },
          section("line one\nline two"),
          { type: "divider" },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: "*Next:* go" }],
          },
        ],
        unfurl_links: false,
        unfurl_media: false,
      }),
    ).toBe(
      "## Report\n\nline one  \nline two\n\n---\n\n<sub>**Next:** go</sub>\n",
    );
  });
});

const RENDER = `const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const answer = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const leaked = ["LLM_GATEWAY_ISSUER_KEY", "SLACK_AGENTS_BOT_TOKEN"].filter((n) => process.env[n] !== undefined);
console.log(JSON.stringify({
  text: "Summary: " + answer.summary,
  blocks: [{ type: "section", text: { type: "mrkdwn", text: "*" + answer.summary + "* " + leaked.join(",") } }],
}));
`;

async function renderRepo(render: string): Promise<string> {
  const root = makeRepo({
    jobs: { demo: { ...jobFiles("demo"), "render.ts": render } },
    files: { "package.json": JSON.stringify({ type: "module" }) },
  });
  await generate(loadRepo(root));
  return root;
}

function options(root: string, extra: Partial<RunOptions> = {}): RunOptions {
  const dir = scratch();
  return {
    root,
    name: "demo",
    stub: true,
    scratch: dir,
    out: join(dir, "report"),
    env: {
      LLM_GATEWAY_ISSUER_KEY: KEY,
      SLACK_AGENTS_BOT_TOKEN: KEY,
      ...RUN_ENV,
    },
    identity: WHO,
    log: () => {},
    ...extra,
  };
}

describe("a job with render.ts", () => {
  it("keeps the message in the report with the run link at the end, posts nothing, and gives render.ts no credential", async () => {
    const root = await renderRepo(RENDER);
    const opts = options(root);
    const result = await runJob(opts);
    expect(result.messages[0]).toBe("demo: answer accepted.");
    const message = JSON.parse(
      readFileSync(join(opts.out!, "slack.json"), "utf8"),
    );
    expect(message.text).toBe("Summary: hi");
    expect(message.unfurl_links).toBe(false);
    expect(message.blocks[0]).toEqual(section("*hi* "));
    expect(message.blocks.at(-1).elements[0].text).toContain(
      "<https://github.com/notes-co/agents/actions/runs/36606095916|Workflow run 36606095916>",
    );
    expect(readFileSync(join(opts.out!, "slack.md"), "utf8")).toContain(
      "**hi**",
    );
    expect(result.report?.slack).toEqual({ blocks: 2, posted: false });
    expect(readdirSync(opts.out!)).toContain("answer.json");
  });

  it("fails the run when render.ts prints a message Slack would not take, keeping the answer", async () => {
    const root = await renderRepo(
      `console.log(JSON.stringify({ text: "x", blocks: [{ type: "image" }] }));\n`,
    );
    const opts = options(root);
    const result = await runJob(opts);
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      "demo: jobs/demo/render.ts printed a message Slack would not take: block 1 has type image; a report uses only header, section, divider, context",
    );
    expect(readdirSync(opts.out!)).toContain("answer.json");
    expect(readdirSync(opts.out!)).not.toContain("slack.json");
  });
});
