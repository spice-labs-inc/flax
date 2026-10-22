import { fileURLToPath } from "node:url";
import { BUNDLE_ROOT } from "./bundled.ts";

const ROOT_URL = new URL(BUNDLE_ROOT ?? "../../", import.meta.url);

export const KIT_ROOT = fileURLToPath(ROOT_URL);
export const JOB_SCHEMA_PATH = fileURLToPath(
  new URL("schema/job.schema.json", ROOT_URL),
);
export const BOX_SCHEMA_PATH = fileURLToPath(
  new URL("schema/box.schema.json", ROOT_URL),
);
export const TOOL_SCHEMA_PATH = fileURLToPath(
  new URL("schema/tool.schema.json", ROOT_URL),
);
export const MCP_SERVERS_SCHEMA_PATH = fileURLToPath(
  new URL("schema/mcp-servers.schema.json", ROOT_URL),
);
export const GATEWAY_SCHEMA_PATH = fileURLToPath(
  new URL("schema/gateway.schema.json", ROOT_URL),
);
export const GITHUB_HOSTS_SCHEMA_PATH = fileURLToPath(
  new URL("schema/github-log-hosts.schema.json", ROOT_URL),
);
export const PATCH_SET_SCHEMA_PATH = fileURLToPath(
  new URL("schema/patch-set.schema.json", ROOT_URL),
);
/** The patch set of a job with output.tool_citations: a change may also cite { tool, quote }. */
export const PATCH_SET_TOOL_QUOTES_SCHEMA_PATH = fileURLToPath(
  new URL("schema/patch-set-tool-quotes.schema.json", ROOT_URL),
);
export const LINK_HOSTS_SCHEMA_PATH = fileURLToPath(
  new URL("schema/link-hosts.schema.json", ROOT_URL),
);
export const MEDIA_SCHEMA_PATH = fileURLToPath(
  new URL("schema/media.schema.json", ROOT_URL),
);
export const SCENARIO_SCHEMA_PATH = fileURLToPath(
  new URL("schema/scenario.schema.json", ROOT_URL),
);

export const JOBS_DIR = "jobs";
export const TOOLS_DIR = "tools";
export const WORKFLOWS_DIR = ".github/workflows";
export const JOBS_INDEX = "JOBS.md";
export const BOX_FILE = "box.yml";
export const MCP_SERVERS_FILE = "mcp-servers.yml";
export const GATEWAY_FILE = "gateway.yml";
export const GITHUB_HOSTS_FILE = "github-log-hosts.yml";
export const LINK_HOSTS_FILE = "link-hosts.yml";
export const AGENT_DOCKERFILE = "images/agent/Dockerfile";

export function jobDir(name: string): string {
  return `${JOBS_DIR}/${name}`;
}

export function jobFile(name: string, file: string): string {
  return `${JOBS_DIR}/${name}/${file}`;
}

export function toolDir(name: string): string {
  return `${TOOLS_DIR}/${name}`;
}

export function toolFile(name: string, file: string): string {
  return `${TOOLS_DIR}/${name}/${file}`;
}

/** The committed runner bundles (src/bundle/build.ts): what job workflows run, with no install. */
export const BUNDLE_DIR = "dist";
export const RUNNER_BUNDLE = `${BUNDLE_DIR}/run-job.mjs`;
/** The revision poller (src/revise/poll-cli.ts) that revise-poll.yml runs. */
export const REVISE_POLL_BUNDLE = `${BUNDLE_DIR}/revise-poll.mjs`;
export const BUNDLE_MANIFEST = `${BUNDLE_DIR}/manifest.json`;
/** What to do about stale or missing bundles: pull requests never carry dist/, main gets it rebuilt (rebuild-dist.yml). */
export const REBUILD_DIST =
  "dist/ is rebuilt on main after each merge (Rebuild dist workflow); a branch run needs flax agents generate --dist committed";

/** The scripts in a job folder that run outside the box; the bundled runner runs their bundles. */
export const JOB_SCRIPTS = [
  "media.ts",
  "collect.ts",
  "render.ts",
  "publish.ts",
] as const;

export function bundledJobScript(name: string, file: string): string {
  return `${BUNDLE_DIR}/jobs/${name}/${file.replace(/\.ts$/, ".mjs")}`;
}
