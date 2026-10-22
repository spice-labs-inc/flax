import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadWorkspace } from "../lib/workspace.ts";
import { loadTemplate, renderTemplate, templateValues } from "./template.ts";
import { loadAllowlists } from "../lib/allowlists.ts";
import { THINKING_LEVELS } from "../lib/job.ts";
import { jobDir, jobFile } from "../lib/paths.ts";

export const JOB_NAME = /^[a-z][a-z0-9-]{1,40}$/;
export const OWNER = /^[A-Za-z0-9-]{1,39}$/;
export const OWNER_PLACEHOLDER = "CHANGE-ME";

function jobYml(
  name: string,
  owner: string,
  model: string,
  thinking: string,
): string {
  return `# Job definition. Schema: schema/job.schema.json. Rules: docs/guardrails.md.
# After editing, run flax agents generate and flax agents check.

name: ${name} # must equal the folder name

# GitHub handle that gets failure alerts.
owner: ${owner}

# One sentence on what this job does.
purpose: Describe what this job does in one sentence.

# Exactly one of:
#   schedule: "0 13 * * *"   five-field cron, UTC
#   after: other-job         runs when that job succeeds
#   manual: true             runs only when started by hand
trigger:
  manual: true

# Must be listed in models.yml.
model: ${model}

# Pi thinking level for every run: off, minimal, low, medium, high, xhigh or
# max, limited to the thinking list of the model in models.yml.
thinking: ${thinking}

limits:
  turns: 30 # at most 200
  tokens_per_run: 400000 # at most 2000000
  usd_per_month: 5 # all jobs together share $175 a month
  tool_calls: 200 # tool calls per run, at most 1000
  tool_seconds: 60 # seconds per tool call, at most 300
  collect_tool_calls: 200 # tool calls collect.ts may make per run, at most 1000

# Names of directories under tools/ the model may call. Tools are read-only.
tools: []

# Names of directories under tools/ that collect.ts may call; needs collect.ts.
collect_tools: []

# Optional: media.ts makes media (video, screenshots) on the runner before
# collect.ts, with the network and only these secrets, from flax.yml
# agents.mediaSecrets. Any other network name is a network join from flax.yml.
# media:
#   network: public # or a name from flax.yml agents.networkJoins
#   secrets: []
#   timeout_minutes: 20

# kind is one of:
#   file    the run's result is kept as a file; nothing else to set
#   slack   also set channel: <a channel from post in channels.yml>;
#           untrusted_input: post (the default) or report_only (no post
#           when the model saw text anyone can write)
#   pr      also set repos: [owner/name, ...] from repos.yml,
#           paths: [globs the job may change], max_changed_lines: <number>,
#           untrusted_input: report_only (no pull request when the model
#           saw text anyone can write) or open_pr; optionally
#           frontmatter_keys: [keys the model may change] and
#           stamp_keys: [keys only collect.ts sets, through stamps]
output:
  kind: file

# shadow runs deliver nowhere public. live needs SHADOW_RUNS.md with 4 run
# links and code owner approval.
mode: shadow
`;
}

const PROMPT = `Describe the task for the model here.

The input is the JSON in fixtures/input.json (or whatever collect.ts gathers).
Return JSON that matches output.json.
`;

const OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: { type: "string", minLength: 1 },
  },
};

export interface ScaffoldOptions {
  owner?: string;
  /** A kit template to copy (jobs/<name>/ in the package) with its placeholders filled from the workspace and `set`. */
  template?: string;
  set?: Record<string, string>;
}

/** Creates jobs/<name>/ and returns the files written, relative to root. */
export function scaffoldJob(
  root: string,
  name: string,
  options: ScaffoldOptions = {},
): string[] {
  if (!JOB_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a valid job name: use 2 to 41 lowercase letters, digits and dashes, starting with a letter`,
    );
  }
  const owner = options.owner ?? OWNER_PLACEHOLDER;
  if (!OWNER.test(owner))
    throw new Error(`"${owner}" is not a valid GitHub handle`);
  if (existsSync(join(root, jobDir(name))))
    throw new Error(`${jobDir(name)} already exists`);
  if (options.template !== undefined) {
    const template = loadTemplate(options.template);
    const values = templateValues(template, name, owner, options.set ?? {}, loadWorkspace(root).workspace);
    const rendered = renderTemplate(template, values);
    const written: string[] = [];
    for (const [file, content] of Object.entries(rendered)) {
      mkdirSync(dirname(join(root, jobFile(name, file))), { recursive: true });
      writeFileSync(join(root, jobFile(name, file)), content);
      written.push(jobFile(name, file));
    }
    return written;
  }
  const model = loadAllowlists(root).allowlists.models[0];
  if (model === undefined) throw new Error("models.yml lists no models");
  const levels = model.thinking ?? THINKING_LEVELS;
  const thinking = levels.includes("high") ? "high" : levels[0]!;

  const files: Record<string, string> = {
    "job.yml": jobYml(name, owner, model.id, thinking),
    "prompt.md": PROMPT,
    "output.json": `${JSON.stringify(OUTPUT_SCHEMA, null, 2)}\n`,
    "fixtures/input.json": `${JSON.stringify({ text: "Sample input for the job." }, null, 2)}\n`,
    "fixtures/output.json": `${JSON.stringify({ summary: "A sample summary." }, null, 2)}\n`,
  };
  mkdirSync(join(root, jobDir(name), "fixtures"), { recursive: true });
  const written: string[] = [];
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(root, jobFile(name, file)), content);
    written.push(jobFile(name, file));
  }
  return written;
}
