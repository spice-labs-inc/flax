import { join } from "node:path";
import { loadAllowlists } from "../lib/allowlists.ts";
import { loadGithubHosts } from "../lib/github-hosts.ts";
import { allJobTools, type JobConfig, type ToolLimits } from "../lib/job.ts";
import {
  loadTool,
  toolOperations,
  toolUpstreams,
  upstreamSecrets,
} from "../lib/tools.ts";
import type {
  RunningUpstreams,
  StartUpstreamsOptions,
} from "../tools-server/start-upstreams.ts";
import { githubOrg } from "../tools-server/github.ts";
import { startToolsServer, type RunningTools } from "../tools-server/start.ts";

/** Stand-ins for the parts of a tools run that reach the network; tests set them. */
export interface RunToolsHooks {
  /** Downloads the pinned MCP server binaries into dir. */
  fetchServers?: (root: string, dir: string) => Promise<unknown>;
  startUpstreams?: (
    options: StartUpstreamsOptions,
  ) => Promise<RunningUpstreams>;
  /** How often the tools server looks for requests when no change is signalled. */
  pollMs?: number;
}

/** The upstreams of one run, shared by the tools server of collect.ts and the one of the model. */
export interface RunUpstreams {
  /** The upstreams started; none in stub runs. */
  servers: string[];
  running?: RunningUpstreams;
  /** Every credential value the upstreams hold, the installation token included. */
  secrets: readonly string[];
  /** Stops the upstreams. Safe to call more than once. */
  close(): Promise<void>;
}

/** The upstreams run from a binary pinned in mcp-servers.yml. */
const NEEDS_BINARIES = new Set(["kubernetes", "github"]);

/** The upstreams a job's tools read from, for the model and for collect.ts. */
export function jobUpstreams(root: string, job: JobConfig): string[] {
  const names = allJobTools(job);
  return toolUpstreams(
    names.map((name) => loadTool(root, name)),
    names,
  );
}

/** The operations a job's tools, for the model and for collect.ts, call on one upstream. */
export function jobOperations(
  root: string,
  job: JobConfig,
  server: string,
): string[] {
  const names = allJobTools(job);
  return toolOperations(
    names.map((name) => loadTool(root, name)),
    names,
    server,
  );
}

/** The secrets those upstreams need that the environment does not hold. */
export function missingToolSecrets(
  env: NodeJS.ProcessEnv,
  servers: readonly string[],
): string[] {
  return upstreamSecrets(servers).filter((name) => !env[name]?.trim());
}

export interface StartRunUpstreamsOptions {
  root: string;
  job: JobConfig;
  /** The run directory; the binaries and the upstreams' work directory go here, outside the data directory. */
  runRoot: string;
  env: NodeJS.ProcessEnv;
  /** Start nothing: nothing is fetched and no credential is needed. */
  stub: boolean;
  hooks?: RunToolsHooks;
  now?: () => Date;
}

/**
 * Starts the upstreams the job's tools read from, before collect.ts and
 * the box: the pinned MCP server binaries, then each upstream with only
 * its own credential, in a work directory outside the data directory. A
 * stub run starts none.
 */
export async function startRunUpstreams(
  options: StartRunUpstreamsOptions,
): Promise<RunUpstreams> {
  const { root, job, hooks = {} } = options;
  if (options.stub)
    return { servers: [], secrets: [], close: () => Promise.resolve() };

  const servers = jobUpstreams(root, job);
  const binDir = join(options.runRoot, "mcp-servers");
  if (servers.some((s) => NEEDS_BINARIES.has(s))) {
    const fetch =
      hooks.fetchServers ??
      (async (r: string, dir: string) => {
        const { fetchServers } =
          await import("../tools-server/fetch-servers.ts");
        return fetchServers({ root: r, dir });
      });
    await fetch(root, binDir);
  }
  const start =
    hooks.startUpstreams ??
    (async (o: StartUpstreamsOptions) => {
      const { startUpstreams } =
        await import("../tools-server/start-upstreams.ts");
      return startUpstreams(o);
    });
  const running = await start({
    servers,
    env: options.env,
    workDir: join(options.runRoot, "tools"),
    binDir,
    readChannels: loadAllowlists(root).allowlists.readChannels,
    githubOperations: jobOperations(root, job, "github"),
    githubDownloadHosts: loadGithubHosts(root).hosts?.hosts ?? [],
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    servers,
    running,
    secrets: running.secrets,
    close: once(() => running.close()),
  };
}

export interface ServeToolsOptions {
  root: string;
  job: JobConfig;
  /** The run's data directory for the model's tools; for collect.ts, a directory outside it that holds its mailbox. */
  dir: string;
  /** The model's tools socket; collect.ts has none and gets a mailbox in dir. */
  socketPath?: string;
  names: readonly string[];
  limits: ToolLimits;
  upstreams: RunUpstreams;
  /** The commit gh-file reads each repository at, by name, for a job with pin_files. */
  commits?: ReadonlyMap<string, string>;
  hooks?: RunToolsHooks;
  now?: () => Date;
}

/**
 * Starts a tools server on socketPath, or for collect.ts on a mailbox in
 * dir, serving the named tools under the given limits and cleaning results
 * with the upstreams' scrubber. With no upstreams running (a stub run) it
 * still loads the tools and answers, reaching nothing.
 */
export function serveTools(options: ServeToolsOptions): Promise<RunningTools> {
  const { upstreams, hooks = {} } = options;
  return startToolsServer({
    root: options.root,
    dataDir: options.dir,
    ...(options.socketPath === undefined
      ? {}
      : { socketPath: options.socketPath }),
    job: options.job,
    tools: options.names,
    limits: options.limits,
    upstreams: upstreams.running?.upstreams ?? {},
    ...(upstreams.running === undefined
      ? {}
      : { scrub: upstreams.running.scrub }),
    ...(options.commits === undefined ? {} : { commits: options.commits }),
    ...(hooks.pollMs === undefined ? {} : { pollMs: hooks.pollMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/**
 * The commits the input's `repos` object pins organization repositories
 * to (`owner/name` to a full sha), by repository name: where gh-file reads
 * them for a job with pin_files. Anything else in it is ignored.
 */
export function inputCommits(input: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const repos =
    typeof input === "object" && input !== null
      ? (input as { repos?: unknown }).repos
      : undefined;
  if (typeof repos !== "object" || repos === null || Array.isArray(repos))
    return out;
  for (const [full, sha] of Object.entries(repos)) {
    const [owner, name, ...rest] = full.split("/");
    if (
      owner === githubOrg() &&
      name !== undefined &&
      /^[A-Za-z0-9._-]+$/.test(name) &&
      rest.length === 0 &&
      typeof sha === "string" &&
      /^[0-9a-f]{40}$/.test(sha)
    )
      out.set(name, sha);
  }
  return out;
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () => (done ??= fn());
}
