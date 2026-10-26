import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse } from "yaml";
import type { ReadChannel } from "../lib/allowlists.ts";
import type { ServerName } from "../lib/mcp-servers.ts";
import { NOT_SECRET_ENV, upstreamSecretsByServer } from "../lib/tools.ts";
import {
  createInstallationToken,
  GITHUB_MCP_OPERATIONS,
  githubArgs,
  githubGuard,
  readPermissions,
} from "./github.ts";
import {
  clusters as kubernetesClusters,
  KUBERNETES_OPERATIONS,
  KubernetesUpstream,
  kubeNamespaceLister,
  kubernetesArgs,
  kubernetesConfig,
  type Cluster,
  type NamespaceLister,
} from "./kubernetes.ts";
import {
  GithubUpstream,
  MaintainerNotesReader,
  RunReportReader,
} from "./artifacts.ts";
import { CodeReader } from "./code-reader.ts";
import { CompareReader } from "./compare.ts";
import { errorChain } from "./errors.ts";
import {
  connectMcp,
  STDIO_MAX_MESSAGE_BYTES,
  stderrTail,
  type McpProcess,
} from "./mcp-upstream.ts";
import {
  kubePodForwarder,
  openobservePod,
  OpenObserveUpstream,
  PortForward,
  type PodForwarder,
} from "./openobserve.ts";
import { scrubber } from "./scrub.ts";
import { SlackUpstream } from "./slack.ts";
import { builtinUpstream, type Upstream, type Upstreams } from "./upstreams.ts";

/** How to start one MCP server binary; tests put a fake in its place. */
export interface ServerCommand {
  command: string;
  args?: string[];
}

export interface StartUpstreamsOptions {
  /** The upstreams the job's tools use; only these are started. */
  servers: readonly string[];
  env: NodeJS.ProcessEnv;
  /**
   * A directory for kubeconfigs and server configuration, readable by the
   * runner only and outside the data directory. close() removes it.
   */
  workDir: string;
  /** Where flax agents fetch-servers put the binaries. */
  binDir: string;
  readChannels: readonly ReadChannel[];
  /**
   * The GitHub operations the job's tools call. The run's installation
   * token gets the read permissions these need and no others.
   */
  githubOperations?: readonly string[];
  commands?: Partial<Record<ServerName, ServerCommand>>;
  githubApiUrl?: string;
  /** The exact hosts GitHub may send an artifact download to (github-log-hosts.yml); none when not given. */
  githubDownloadHosts?: readonly string[];
  /** Takes plain http artifact downloads; only tests set it. */
  githubDownloadHttp?: boolean;
  /** The hosts a commit tarball may be downloaded from; codeload.github.com when not given. Only tests set it. */
  githubTarballHosts?: readonly string[];
  fetch?: typeof fetch;
  slackApiUrl?: string;
  podForwarder?: (kubeconfig: string) => Promise<PodForwarder>;
  namespaceLister?: (kubeconfig: string) => NamespaceLister;
  now?: () => Date;
}

export interface RunningUpstreams {
  upstreams: Upstreams;
  /** Every credential value of the run, the installation token included. */
  secrets: string[];
  /** Scrubs text of UUIDs, secret shapes and the run's credential values. */
  scrub: (text: string) => string;
  close(): Promise<void>;
}

/** The token and key values inside a kubeconfig, which must never reach the model. */
export function kubeconfigSecrets(kubeconfig: string): string[] {
  let doc: unknown;
  try {
    doc = parse(kubeconfig);
  } catch {
    return [];
  }
  const users = (doc as { users?: { user?: Record<string, unknown> }[] })
    ?.users;
  const out: string[] = [];
  for (const u of Array.isArray(users) ? users : [])
    for (const key of ["token", "client-key-data", "password"])
      if (typeof u.user?.[key] === "string") out.push(u.user[key] as string);
  return out;
}

/** The pieces of an HTTP Basic value: the value itself and, decoded, its password. */
export function basicAuthSecrets(value: string): string[] {
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon > 0 ? [value, decoded.slice(colon + 1)] : [value];
}

/** The credential values the given upstreams use, and the secrets inside them, for scrubbing. */
export function credentialValues(
  env: NodeJS.ProcessEnv,
  servers: readonly string[],
): string[] {
  const out: string[] = [];
  for (const server of servers)
    for (const name of upstreamSecretsByServer()[server] ?? []) {
      if (NOT_SECRET_ENV.has(name)) continue;
      const value = env[name]?.trim();
      if (!value) continue;
      out.push(value);
      if (name.startsWith("KUBECONFIG_")) out.push(...kubeconfigSecrets(value));
      if (name === "OPENOBSERVE_CI_AUTH") out.push(...basicAuthSecrets(value));
    }
  return out;
}

/** Starts one stdio MCP server, keeping the tail of its standard error. */
function stdioProcess(params: {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}): McpProcess {
  const transport = new StdioClientTransport({
    ...params,
    stderr: "pipe",
    maxBufferSize: STDIO_MAX_MESSAGE_BYTES,
  });
  return { transport, stderr: stderrTail(transport.stderr) };
}

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Starts the upstreams a job's tools need, each with only its own
 * credential: one kubernetes-mcp-server per cluster with that cluster's
 * kubeconfig, github-mcp-server with a read-only installation token made
 * for this run, OpenObserve's REST API through a port-forward over the
 * shared-services Kubernetes API, and the Slack adapter with the bot
 * token. Children get a minimal environment plus their own credential and
 * nothing else of the runner's. If any upstream fails to start, the ones
 * already started are stopped.
 */
export async function startUpstreams(
  options: StartUpstreamsOptions,
): Promise<RunningUpstreams> {
  const { env } = options;
  const wanted = new Set(options.servers);
  const missing = [...wanted].flatMap((server) => {
    const names = upstreamSecretsByServer()[server];
    if (names === undefined) return [`${server} (not an upstream)`];
    return names.filter((n) => !env[n]?.trim());
  });
  if (missing.length > 0)
    throw new Error(`missing secrets for the tools: ${missing.join(", ")}`);

  const secrets = credentialValues(env, [...wanted]);
  const command = (name: ServerName): ServerCommand =>
    options.commands?.[name] ?? { command: join(options.binDir, name) };

  mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
  chmodSync(options.workDir, 0o700);
  const started: Upstream[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  const upstreams: Record<string, Upstream> = {};
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(started.map((u) => u.close?.()));
    await Promise.allSettled(cleanups.map((c) => c()));
    rmSync(options.workDir, { recursive: true, force: true });
  };

  try {
    if (wanted.has("builtin")) upstreams.builtin = builtinUpstream;

    if (wanted.has("kubernetes")) {
      const configPath = join(options.workDir, "kubernetes-mcp-server.toml");
      writePrivate(configPath, kubernetesConfig());
      const clusters = new Map<Cluster, Upstream>();
      const namespaces = new Map<Cluster, NamespaceLister>();
      const k8s = new KubernetesUpstream(clusters, namespaces);
      started.push(k8s);
      for (const [cluster, secret] of Object.entries(kubernetesClusters()) as [
        Cluster,
        string,
      ][]) {
        namespaces.set(
          cluster,
          (options.namespaceLister ?? kubeNamespaceLister)(env[secret]!),
        );
        const kubeconfig = join(options.workDir, `kubeconfig-${cluster}.yaml`);
        writePrivate(kubeconfig, env[secret]!);
        const { command: cmd, args = [] } = command("kubernetes-mcp-server");
        clusters.set(
          cluster,
          await connectMcp(
            `kubernetes-mcp-server for ${cluster}`,
            () =>
              stdioProcess({
                command: cmd,
                args: [...args, ...kubernetesArgs(configPath, kubeconfig)],
                env: {},
                cwd: options.workDir,
              }),
            KUBERNETES_OPERATIONS,
          ),
        );
      }
      upstreams.kubernetes = k8s;
    }

    if (wanted.has("github")) {
      const token = await createInstallationToken({
        appId: env.AGENTS_READER_APP_ID!.trim(),
        privateKey: env.AGENTS_READER_PRIVATE_KEY!,
        permissions: readPermissions(options.githubOperations ?? []),
        ...(options.githubApiUrl === undefined
          ? {}
          : { apiUrl: options.githubApiUrl }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.now === undefined ? {} : { now: options.now() }),
      });
      secrets.push(token.token);
      cleanups.push(() => token.revoke());
      const { command: cmd, args = [] } = command("github-mcp-server");
      const github = await connectMcp(
        "github-mcp-server",
        () =>
          stdioProcess({
            command: cmd,
            args: [...args, ...githubArgs()],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: token.token },
            cwd: options.workDir,
          }),
        GITHUB_MCP_OPERATIONS,
        githubGuard,
      );
      started.push(github);
      const artifactOptions = {
        token: token.token,
        downloadHosts: options.githubDownloadHosts ?? [],
        ...(options.githubApiUrl === undefined
          ? {}
          : { apiUrl: options.githubApiUrl }),
        ...(options.githubDownloadHttp === true ? { allowHttp: true } : {}),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.now === undefined ? {} : { now: options.now }),
      };
      upstreams.github = new GithubUpstream(
        github,
        new MaintainerNotesReader(artifactOptions),
        new CompareReader({
          token: token.token,
          ...(options.githubApiUrl === undefined
            ? {}
            : { apiUrl: options.githubApiUrl }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
        new RunReportReader(artifactOptions),
        new CodeReader({
          token: token.token,
          cacheDir: join(options.workDir, "tarballs"),
          ...(options.githubApiUrl === undefined
            ? {}
            : { apiUrl: options.githubApiUrl }),
          ...(options.githubDownloadHttp === true ? { allowHttp: true } : {}),
          ...(options.githubTarballHosts === undefined
            ? {}
            : { tarballHosts: options.githubTarballHosts }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      );
    }

    if (wanted.has("openobserve")) {
      const forwarder = await (options.podForwarder ?? kubePodForwarder)(
        env[kubernetesClusters()[openobservePod().cluster] ?? "KUBECONFIG_OPENOBSERVE"]!,
      );
      const forward = new PortForward(forwarder);
      cleanups.push(() => forward.close());
      const port = await forward.start().catch((err: unknown) => {
        throw new Error(`OpenObserve: ${errorChain(err)}`);
      });
      const openobserve = new OpenObserveUpstream({
        baseUrl: `http://127.0.0.1:${port}`,
        basicAuth: env.OPENOBSERVE_CI_AUTH!.trim(),
        diagnose: () => forward.lastProblem(),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      await openobserve.ready().catch((err: unknown) => {
        throw new Error(`OpenObserve: ${errorChain(err)}`);
      });
      upstreams.openobserve = openobserve;
    }

    if (wanted.has("slack")) {
      const { WebClient, LogLevel } = await import("@slack/web-api");
      upstreams.slack = new SlackUpstream(
        new WebClient(env.SLACK_AGENTS_BOT_TOKEN!.trim(), {
          logLevel: LogLevel.ERROR,
          retryConfig: { retries: 0 },
          rejectRateLimitedCalls: true,
          timeout: 30_000,
          ...(options.slackApiUrl === undefined
            ? {}
            : { slackApiUrl: options.slackApiUrl }),
        }),
        options.readChannels,
        options.now,
      );
    }
  } catch (err) {
    await close();
    throw new Error(scrubber(secrets)(errorChain(err)));
  }

  return {
    upstreams,
    secrets,
    scrub: scrubber(secrets),
    close,
  };
}
