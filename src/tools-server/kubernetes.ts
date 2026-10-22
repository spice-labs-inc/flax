import { parse, stringify } from "yaml";
import { UPSTREAM_OPERATIONS } from "../lib/tools.ts";
import type { Upstream } from "./upstreams.ts";
import { workspace } from "../lib/workspace.ts";

/** The clusters Kubernetes tools may read, and the secret holding each one's kubeconfig. */
export function clusters(): Record<string, string> {
  return workspace().clusters;
}

export type Cluster = string;

/** Served by the tools server itself with the cluster's kubeconfig, not by kubernetes-mcp-server. */
export const NATIVE_KUBERNETES_OPERATIONS = ["namespaces_list"] as const;

/** The operations kubernetes-mcp-server is enabled for and must offer. */
export const KUBERNETES_OPERATIONS = UPSTREAM_OPERATIONS.kubernetes!.filter(
  (op) => !(NATIVE_KUBERNETES_OPERATIONS as readonly string[]).includes(op),
);

export const NAMESPACE_PHASES = ["Active", "Terminating"] as const;

/** One namespace, as namespaces_list returns it: these four fields and nothing else. */
export interface NamespaceSummary {
  name: string;
  phase: string;
  creationTimestamp: string;
  deletionTimestamp?: string;
}

/** Lists one cluster's namespaces, optionally only those in one phase. */
export interface NamespaceLister {
  list(phase?: string): Promise<NamespaceSummary[]>;
}

/**
 * Lists namespaces with @kubernetes/client-node from one kubeconfig, which
 * is loaded on the first call. It makes one request, GET
 * /api/v1/namespaces (with a status.phase field selector when a phase is
 * given), and keeps only the name, phase and the two timestamps.
 */
export function kubeNamespaceLister(kubeconfig: string): NamespaceLister {
  let core: Promise<import("@kubernetes/client-node").CoreV1Api> | undefined;
  const client = () =>
    (core ??= import("@kubernetes/client-node").then((k8s) => {
      const kc = new k8s.KubeConfig();
      kc.loadFromString(kubeconfig);
      return kc.makeApiClient(k8s.CoreV1Api);
    }));
  const time = (value: unknown): string | undefined =>
    value instanceof Date
      ? value.toISOString().replace(/\.\d+Z$/, "Z")
      : typeof value === "string"
        ? value
        : undefined;
  return {
    async list(phase) {
      const answer = await (
        await client()
      ).listNamespace(
        phase === undefined ? {} : { fieldSelector: `status.phase=${phase}` },
      );
      return answer.items.map((ns) => {
        const deletion = time(ns.metadata?.deletionTimestamp);
        return {
          name: ns.metadata?.name ?? "",
          phase: ns.status?.phase ?? "",
          creationTimestamp: time(ns.metadata?.creationTimestamp) ?? "",
          ...(deletion === undefined ? {} : { deletionTimestamp: deletion }),
        };
      });
    },
  };
}

export function isCluster(value: unknown): value is Cluster {
  return typeof value === "string" && Object.hasOwn(clusters(), value);
}

/**
 * kubernetes-mcp-server's configuration: read-only tools of the core
 * toolset only, and of those only the ones the tools call. The config
 * toolset stays off because configuration_view returns the kubeconfig,
 * token included. Secrets are refused by the server as well as by the
 * reader account's view role.
 */
export function kubernetesConfig(): string {
  const list = (items: readonly string[]) =>
    `[${items.map((i) => JSON.stringify(i)).join(", ")}]`;
  return [
    "read_only = true",
    'toolsets = ["core"]',
    `enabled_tools = ${list(KUBERNETES_OPERATIONS)}`,
    'list_output = "table"',
    "stateless = true",
    "",
    "[[denied_resources]]",
    'group = ""',
    'version = "v1"',
    'kind = "Secret"',
    "",
  ].join("\n");
}

/** The command line for one cluster's server; the flags repeat the config file's settings, and win over it. */
export function kubernetesArgs(
  configPath: string,
  kubeconfigPath: string,
): string[] {
  return [
    "--config",
    configPath,
    "--kubeconfig",
    kubeconfigPath,
    "--read-only",
    "--toolsets",
    "core",
    "--disable-multi-cluster",
  ];
}

/**
 * One kubernetes-mcp-server per cluster behind one upstream, plus a
 * namespace lister per cluster for namespaces_list. Every call names its
 * cluster in a "cluster" argument, which picks the server and is not
 * passed on.
 */
export class KubernetesUpstream implements Upstream {
  readonly clusters: ReadonlyMap<Cluster, Upstream>;
  readonly namespaces: ReadonlyMap<Cluster, NamespaceLister>;

  constructor(
    clusters: ReadonlyMap<Cluster, Upstream>,
    namespaces: ReadonlyMap<Cluster, NamespaceLister> = new Map(),
  ) {
    this.clusters = clusters;
    this.namespaces = namespaces;
  }

  call(
    operation: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const { cluster, ...rest } = args;
    if (!isCluster(cluster))
      return Promise.reject(
        new Error(`"${String(cluster)}" is not a cluster tools may read`),
      );
    if (operation === "namespaces_list")
      return this.listNamespaces(cluster, rest);
    const upstream = this.clusters.get(cluster);
    if (upstream === undefined)
      return Promise.reject(
        new Error(`${cluster} is not available in this run`),
      );
    return upstream.call(operation, rest, signal);
  }

  private async listNamespaces(
    cluster: Cluster,
    args: Record<string, unknown>,
  ): Promise<string> {
    const extra = Object.keys(args).filter((k) => k !== "phase");
    if (extra.length > 0)
      throw new Error(`namespaces_list takes no ${extra.join(", ")}`);
    const { phase } = args;
    if (
      phase !== undefined &&
      !(NAMESPACE_PHASES as readonly unknown[]).includes(phase)
    )
      throw new Error(`"${String(phase)}" is not a namespace phase`);
    const lister = this.namespaces.get(cluster);
    if (lister === undefined)
      throw new Error(`${cluster} is not available in this run`);
    const namespaces = await lister.list(phase as string | undefined);
    return JSON.stringify({ count: namespaces.length, namespaces });
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.clusters.values()].map((u) => u.close?.()),
    );
  }
}

/**
 * Keeps the first max events of an events_list result, which lists the
 * newest first as YAML after a comment line. events_list has no limit of
 * its own. Text in any other shape is refused rather than passed on
 * uncounted.
 */
export function limitEvents(text: string, max: number): string {
  const newline = text.indexOf("\n");
  const header = newline === -1 ? text : text.slice(0, newline);
  if (!header.startsWith("# "))
    throw new Error("events_list answered in an unknown shape");
  if (newline === -1 || text.slice(newline + 1).trim() === "") return text;
  const events: unknown = parse(text.slice(newline + 1));
  if (!Array.isArray(events))
    throw new Error("events_list answered in an unknown shape");
  if (events.length <= max) return text;
  return `# The newest ${max} of ${events.length} events (YAML format):\n${stringify(events.slice(0, max))}`;
}
