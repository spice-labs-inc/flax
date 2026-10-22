import { isAbsolute } from "node:path";
import { WRITER_SECRET_ENV } from "../deliver/github-writer.ts";
import { SLACK_POST_TOKEN_ENV } from "../deliver/slack-poster.ts";
import { YOUTUBE_SECRET_ENV } from "../deliver/youtube.ts";
import { MODEL_KEY_ENVS, providerEnvPrefix } from "../lib/gateway.ts";
import { workspace } from "../lib/workspace.ts";
import {
  MEDIA_DISPATCH_TOKEN_ENV,
  MEDIA_ORG_READ_ENV,
  MEDIA_READ_TOKEN_ENV,
} from "../lib/media.ts";
import { isThinkingLevel } from "../lib/job.ts";
import { MODEL_SHIM_URL } from "../../images/agent/pi-mcp-mailbox/src/sockets.ts";

/** Where lbx mounts the data directory inside the run box. */
export const DATA_MOUNT = "/data";

/** Files in the data directory, by name. */
export const DATA_FILES = {
  prompt: "prompt.md",
  input: "input.json",
  schema: "output.schema.json",
  answer: "answer.txt",
  sessions: "session",
  repair: "repair.md",
} as const;

/** A Pi session file name in the sessions directory, as the runner passes it to --session. */
export const SESSION_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.jsonl$/;

/**
 * Pi still needs a value for the provider's key, but the forwarder
 * drops whatever the box sends and adds the run's gateway key outside it,
 * so the box gets this placeholder, which is no credential.
 */
export const BOX_MODEL_KEY_PLACEHOLDER = "held-by-the-runner";

/** Secrets only the runner process holds: removed from the environment of lbx, the box and job code. */
export const RUNNER_SECRET_ENV = [
  ...MODEL_KEY_ENVS,
  ...WRITER_SECRET_ENV,
  SLACK_POST_TOKEN_ENV,
  ...YOUTUBE_SECRET_ENV,
  MEDIA_READ_TOKEN_ENV,
  MEDIA_DISPATCH_TOKEN_ENV,
  MEDIA_ORG_READ_ENV,
] as const;

/**
 * Where the agent image installs Pi's extensions, root-owned so the box user
 * cannot change them (images/agent/Dockerfile): the provider plugin, when there is one, and the
 * pi-mcp-mailbox plugin (the model shim and the tools client), which every
 * run loads.
 */
export const PI_EXTENSIONS_PREFIX = "/opt/pi-extensions";
/** The provider plugin's install directory, when flax.yml agents.provider.plugin names one; Pi's own provider otherwise. */
export function piProviderExtension(plugin: string | undefined = workspace().provider.plugin): string | undefined {
  return plugin === undefined ? undefined : `${PI_EXTENSIONS_PREFIX}/node_modules/${plugin}`;
}
export const PI_MAILBOX_EXTENSION = `${PI_EXTENSIONS_PREFIX}/pi-mcp-mailbox.mjs`;

/** Pi's own tools every run gets; a job's tools are added to these. */
export const PI_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;
/** Pi's shell tool, added for a job with `shell: true`. */
export const PI_SHELL_TOOL = "bash";
const TOOL_NAME = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * Pi has no flag that limits turns, so the turn limit is enforced as time:
 * each turn gets a minute. The cap leaves room inside the workflow timeout
 * for pulling images and cleanup.
 */
export const SECONDS_PER_TURN = 60;
export const MAX_RUN_SECONDS = 3 * 60 * 60;

// lbx refuses timeouts above seven days and run names longer than 128.
const LBX_TIMEOUT_MAX = 604800;
const LBX_NAME_MAX = 128;
const LBX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function runTimeoutSeconds(turns: number): number {
  return Math.min(MAX_RUN_SECONDS, SECONDS_PER_TURN * turns);
}

/** A run name that is new for every run: the Actions run id and attempt, or the time. */
export function runName(
  job: string,
  env: {
    GITHUB_RUN_ID?: string | undefined;
    GITHUB_RUN_ATTEMPT?: string | undefined;
  },
  now: Date,
): string {
  const id = env.GITHUB_RUN_ID;
  if (id !== undefined && /^\d+$/.test(id)) {
    const attempt = /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? "")
      ? env.GITHUB_RUN_ATTEMPT
      : "1";
    return `job-${job}-${id}-${attempt}`;
  }
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `job-${job}-${stamp}`;
}

/**
 * The command lbx runs inside the box: Pi in print mode, which prints only
 * the final answer. The answer goes to a file in the data directory through
 * a fixed shell line; the job's values are passed as arguments, never
 * spliced into the script. Pi loads nothing it finds on its own (extensions,
 * skills, prompt templates, themes, AGENTS.md or CLAUDE.md, project-local
 * settings); the extensions are named by path. The plugin comes first, so
 * its model shim listens before the provider first calls out, and a
 * job's tools, which it registers, are added to the --tools allowlist by
 * name. The command starts with env, pointing the provider at the
 * shim and giving it the placeholder key. The thinking level is always
 * passed, so no run falls back to Pi's default. With `session`, Pi
 * continues that session of an earlier run in the same data directory and
 * gets only the repair request, not the prompt, schema and input again.
 */
export function piCommand(
  model: string,
  thinking: string,
  tools: readonly string[] = [],
  options: { shell?: boolean; session?: string } = {},
): string[] {
  const inData = (file: string) => `${DATA_MOUNT}/${file}`;
  if (!isThinkingLevel(thinking))
    throw new Error(`"${thinking}" is not a thinking level Pi takes`);
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool)) throw new Error(`"${tool}" is not a tool name`);
    if (
      (PI_BUILTIN_TOOLS as readonly string[]).includes(tool) ||
      tool === PI_SHELL_TOOL
    )
      throw new Error(`"${tool}" is one of Pi's own tools`);
  }
  if (new Set(tools).size !== tools.length)
    throw new Error("a tool is named twice");
  if (options.session !== undefined && !SESSION_FILE.test(options.session))
    throw new Error(`"${options.session}" is not a Pi session file name`);
  return [
    "env",
    // The provider reads its base URL under its own name; the kit's Pi plugin reads the same under FLAX_AGENTS_MODEL_BASE_URL.
    `FLAX_AGENTS_MODEL_BASE_URL=${MODEL_SHIM_URL}`,
    `${providerEnvPrefix()}_BASE_URL=${MODEL_SHIM_URL}`,
    `${providerEnvPrefix()}_API_KEY=${BOX_MODEL_KEY_PLACEHOLDER}`,
    "sh",
    "-c",
    `exec pi "$@" > ${inData(DATA_FILES.answer)}`,
    "pi",
    "--print",
    "--mode",
    "text",
    "--offline",
    "--no-extensions",
    "--extension",
    PI_MAILBOX_EXTENSION,
    ...(piProviderExtension() === undefined ? [] : ["--extension", piProviderExtension()!]),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--session-dir",
    inData(DATA_FILES.sessions),
    "--model",
    model,
    "--thinking",
    thinking,
    "--tools",
    [
      ...PI_BUILTIN_TOOLS,
      ...(options.shell === true ? [PI_SHELL_TOOL] : []),
      ...tools,
    ].join(","),
    ...(options.session === undefined
      ? [
          `@${inData(DATA_FILES.prompt)}`,
          `@${inData(DATA_FILES.schema)}`,
          `@${inData(DATA_FILES.input)}`,
        ]
      : [
          "--session",
          inData(`${DATA_FILES.sessions}/${options.session}`),
          `@${inData(DATA_FILES.repair)}`,
        ]),
  ];
}

export interface LbxArgs {
  /** The lbx executable, a name on PATH or an absolute path. */
  lbx: string;
  /**
   * The box never has a network: a job run gets the runner's socket
   * directory, the network refusal check nothing at all.
   */
  network: { socketDir: string } | { noNetwork: true };
  dataDir: string;
  timeoutSeconds: number;
  runName: string;
  command: readonly string[];
}

function absolutePath(label: string, path: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  return path;
}

/** The exact lbx --run argument vector, refusing anything lbx itself would refuse. */
export function buildLbxArgv(args: LbxArgs): string[] {
  const t = args.timeoutSeconds;
  if (!Number.isInteger(t) || t < 1 || t > LBX_TIMEOUT_MAX)
    throw new Error(
      `timeout must be a whole number of seconds from 1 to ${LBX_TIMEOUT_MAX}`,
    );
  if (!LBX_NAME.test(args.runName) || args.runName.length > LBX_NAME_MAX)
    throw new Error(`run name "${args.runName}" is not a valid lbx name`);
  if (args.command.length === 0) throw new Error("the command is empty");
  const network = args.network;
  return [
    args.lbx,
    "--run",
    "--runtime",
    "docker",
    "--no-network",
    "--data",
    absolutePath("the data directory", args.dataDir),
    "--timeout",
    String(t),
    ...("socketDir" in network
      ? [
          "--socket-dir",
          absolutePath("the socket directory", network.socketDir),
        ]
      : []),
    args.runName,
    "--",
    ...args.command,
  ];
}
