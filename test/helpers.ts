import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { stringify } from "yaml";
import type { Check } from "../src/check/types.ts";
import {
  AGENT_DOCKERFILE,
  GITHUB_HOSTS_FILE,
  KIT_ROOT,
  LINK_HOSTS_FILE,
  MCP_SERVERS_FILE,
} from "../src/lib/paths.ts";
import { setWorkspaceRoot, WORKSPACE_ENV, workspaceRoot } from "../src/lib/workspace.ts";

/** The fixture workspace the kit's own tests read their root YAMLs from; a workspace's tests set FLAX_WORKSPACE to their own root and keep it. */
export const FIXTURE_WORKSPACE = join(KIT_ROOT, "test/fixtures/workspace");
if (process.env[WORKSPACE_ENV] === undefined || process.env[WORKSPACE_ENV] === "")
  setWorkspaceRoot(FIXTURE_WORKSPACE);
import { formatProblem, type Problem } from "../src/lib/problem.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { TLS } from "./fake-gateway.ts";

export const MODEL = "acme/test-model";
export const TOOL = "web-fetch";
export const CHANNEL = "agents-shadow";
export const POST_CHANNEL = { id: "C0POST00001", name: CHANNEL };
export const READ_CHANNEL = { id: "C0123456789", name: "alerts-test" };
export const REPO = "notes-co/example";

/** The shipped agent image Dockerfile, which passes its check. */
export const AGENT_DOCKERFILE_TEXT = readFileSync(
  join(KIT_ROOT, AGENT_DOCKERFILE),
  "utf8",
);

/** The shipped mcp-servers.yml, which passes its check. */
export const MCP_SERVERS_TEXT = readFileSync(
  join(FIXTURE_WORKSPACE, MCP_SERVERS_FILE),
  "utf8",
);

/** The shipped github-log-hosts.yml, which passes its check. */
export const GITHUB_HOSTS_TEXT = readFileSync(
  join(FIXTURE_WORKSPACE, GITHUB_HOSTS_FILE),
  "utf8",
);

/** The shipped link-hosts.yml, which passes its check. */
export const LINK_HOSTS_TEXT = readFileSync(
  join(FIXTURE_WORKSPACE, LINK_HOSTS_FILE),
  "utf8",
);

/** The workspace's flax.yml (the fixture's in the kit's own run), which every throwaway repository gets too. */
export const FLAX_TEXT = readFileSync(join(workspaceRoot(), "flax.yml"), "utf8");

/** A pinned box with made-up but well-formed values. */
export const BOX = {
  pinned: true,
  box_release: "v1.2.3",
  box_commit: "0123456789abcdef0123456789abcdef01234567",
  lbx_sha256: "9f".repeat(32),
  image: `ghcr.io/notes-co/flax-agent@sha256:${"ab".repeat(32)}`,
};

/** The shipped gateway.yml settings, but for the test CA (TLS.ca), whose leaf is issued for localhost. */
export const GATEWAY = {
  url: "https://192.168.128.1:8443",
  server_name: "localhost",
  team: "agents",
  ca: "gateway-ca.pem",
  key_max_usd: 25,
  key_max_minutes: 120,
};

export function jobConfig(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    owner: "octocat",
    purpose: "Does one useful thing for the tests.",
    trigger: { manual: true },
    model: MODEL,
    thinking: "high",
    limits: { turns: 10, tokens_per_run: 1000, usd_per_month: 5 },
    tools: [],
    output: { kind: "file" },
    mode: "shadow",
    ...overrides,
  };
}

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string" } },
};

/** Files for a job that passes every check, keyed by path inside the job folder. */
export function jobFiles(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, string> {
  return {
    "job.yml": stringify(jobConfig(name, overrides)),
    "prompt.md": "Summarize the input.\n",
    "output.json": JSON.stringify(OUTPUT_SCHEMA),
    "fixtures/input.json": JSON.stringify({ text: "hello" }),
    "fixtures/output.json": JSON.stringify({ summary: "hi" }),
  };
}

/** A tool.yml that passes every check, for a tool served by the builtin echo operation. */
export function toolSpec(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    description: "Returns the text it is given, for the tests.",
    arguments: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", maxLength: 100 } },
    },
    upstream: { server: "builtin", operations: ["echo"] },
    source: "trusted",
    result_max_bytes: 1000,
    ...overrides,
  };
}

export const TOOL_MAP = `export default {
  map: (args) => ({ operation: "echo", arguments: { text: args.text } }),
};
`;

/** Files for a tool that passes every check, keyed by path inside the tool folder. */
export function toolFiles(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, string> {
  return {
    "tool.yml": stringify(toolSpec(name, overrides)),
    "map.ts": TOOL_MAP,
  };
}

export interface RepoSpec {
  /** Job name to files; a value of null leaves that file out. */
  jobs?: Record<string, Record<string, string | null>>;
  models?: unknown;
  channels?: unknown;
  repos?: unknown;
  tools?: string[];
  /** box.yml contents; null leaves the file out. Defaults to BOX. */
  box?: unknown;
  /** images/agent/Dockerfile contents; null leaves the file out. Defaults to this repository's. */
  dockerfile?: string | null;
  /** mcp-servers.yml contents; null leaves the file out. Defaults to this repository's. */
  mcpServers?: string | null;
  /** github-log-hosts.yml contents; null leaves the file out. Defaults to this repository's. */
  githubHosts?: string | null;
  /** link-hosts.yml contents; null leaves the file out. Defaults to this repository's. */
  linkHosts?: string | null;
  /** gateway.yml contents; null leaves the file out. Defaults to GATEWAY, with the test CA as gateway-ca.pem. */
  gateway?: unknown;
  /** flax.yml text; null leaves the file out. Defaults to the fixture workspace's. */
  flax?: string | null;
  /** Any other files, keyed by path from the root. */
  files?: Record<string, string>;
}

/** Builds a throwaway repository under the system temp directory, removed when the test ends. */
export function makeRepo(spec: RepoSpec = {}): string {
  const root = mkdtempSync(join(tmpdir(), "flax-agents-test-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  if (spec.flax !== null) write("flax.yml", spec.flax ?? FLAX_TEXT);
  write(
    "models.yml",
    stringify(
      spec.models ?? [
        {
          id: MODEL,
          provider: "acme",
          usd_per_million_input: 1,
          usd_per_million_output: 2,
        },
      ],
    ),
  );
  write(
    "channels.yml",
    stringify(spec.channels ?? { post: [POST_CHANNEL], read: [READ_CHANNEL] }),
  );
  write("repos.yml", stringify(spec.repos ?? [REPO]));
  if (spec.box !== null) write("box.yml", stringify(spec.box ?? BOX));
  if (spec.dockerfile !== null)
    write(AGENT_DOCKERFILE, spec.dockerfile ?? AGENT_DOCKERFILE_TEXT);
  if (spec.gateway !== null) {
    write("gateway.yml", stringify(spec.gateway ?? GATEWAY));
    write(GATEWAY.ca, TLS.ca);
  }
  if (spec.mcpServers !== null)
    write(MCP_SERVERS_FILE, spec.mcpServers ?? MCP_SERVERS_TEXT);
  if (spec.githubHosts !== null)
    write(GITHUB_HOSTS_FILE, spec.githubHosts ?? GITHUB_HOSTS_TEXT);
  if (spec.linkHosts !== null)
    write(LINK_HOSTS_FILE, spec.linkHosts ?? LINK_HOSTS_TEXT);
  for (const tool of spec.tools ?? [TOOL])
    for (const [file, content] of Object.entries(toolFiles(tool)))
      write(`tools/${tool}/${file}`, content);
  mkdirSync(join(root, "jobs"), { recursive: true });
  for (const [name, files] of Object.entries(spec.jobs ?? {})) {
    mkdirSync(join(root, "jobs", name), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      if (content !== null) write(`jobs/${name}/${file}`, content);
    }
  }
  for (const [file, content] of Object.entries(spec.files ?? {}))
    write(file, content);
  return root;
}

/**
 * Runs one check. Outside the schema tests every job.yml must be valid, so a
 * typo in a fixture cannot make another check pass by skipping the job.
 */
export async function run(check: Check, root: string): Promise<string[]> {
  const repo = loadRepo(root);
  if (check.id !== "job-schema") {
    expect(repo.jobs.flatMap((j) => j.problems).map(formatProblem)).toEqual([]);
  }
  return (await check.run(repo)).map(formatProblem);
}

export function formatted(problems: readonly Problem[]): string[] {
  return problems.map(formatProblem);
}

/**
 * Gives a copied workspace the node_modules pnpm would install with the kit
 * linked: the kit itself as @flax/agents, and the kit's own dependencies
 * beside it, all as symlinks.
 */
export function linkKitNodeModules(root: string): void {
  const dir = join(root, "node_modules");
  mkdirSync(join(dir, "@flax"), { recursive: true });
  symlinkSync(KIT_ROOT, join(dir, "@flax/agents"));
  const kitModules = join(KIT_ROOT, "node_modules");
  for (const entry of readdirSync(kitModules)) {
    if (entry === "@flax") {
      for (const scoped of readdirSync(join(kitModules, entry)))
        symlinkSync(join(kitModules, entry, scoped), join(dir, entry, scoped));
      continue;
    }
    symlinkSync(join(kitModules, entry), join(dir, entry));
  }
}
