import { promises as dns } from "node:dns";
import { parse } from "yaml";
import { clusters as kubernetesClusters } from "../tools-server/kubernetes.ts";
import type { Target } from "./probe.ts";
import { workspace } from "../lib/workspace.ts";

/** The hosts the tools reach for the box, which the box itself must never reach, plus one ordinary public host. */
export function fixedTargets(): readonly Omit<Target, "addresses">[] {
  return [
    { name: "GitHub API", host: "api.github.com", port: 443 },
    { name: "Slack API", host: "slack.com", port: 443 },
    ...(workspace().openobserve?.hosts ?? []).map((host, i) => ({
      name: `OpenObserve host ${i + 1}`,
      host,
      port: 443,
    })),
    { name: "a public host", host: "example.com", port: 443 },
  ];
}

/** The API server's host and port from a kubeconfig; nothing else of it is kept. */
export function kubeconfigServer(
  text: string,
): { host: string; port: number } | undefined {
  let config: unknown;
  try {
    config = parse(text);
  } catch {
    return undefined;
  }
  const clusters = (config as { clusters?: unknown } | null)?.clusters;
  if (!Array.isArray(clusters)) return undefined;
  for (const entry of clusters) {
    const server = (entry as { cluster?: { server?: unknown } } | null)?.cluster
      ?.server;
    if (typeof server !== "string") continue;
    try {
      const url = new URL(server);
      return {
        host: url.hostname,
        port: Number(url.port || (url.protocol === "http:" ? 80 : 443)),
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * The targets: each cluster's Kubernetes API (host and port read from its
 * kubeconfig secret, the credentials left behind), then the fixed hosts.
 * A cluster whose kubeconfig is not set or has no server is named in notes.
 */
export function targetsFrom(
  env: NodeJS.ProcessEnv,
  fixed: readonly Omit<Target, "addresses">[] = fixedTargets(),
): {
  targets: Omit<Target, "addresses">[];
  notes: string[];
} {
  const targets: Omit<Target, "addresses">[] = [];
  const notes: string[] = [];
  for (const [cluster, secret] of Object.entries(kubernetesClusters())) {
    const text = env[secret];
    const server =
      text === undefined || text === "" ? undefined : kubeconfigServer(text);
    if (server === undefined) {
      notes.push(
        `${secret} is not set or names no server; kubernetes ${cluster} is not checked`,
      );
      continue;
    }
    if (targets.some((t) => t.host === server.host && t.port === server.port))
      continue;
    targets.push({ name: `kubernetes ${cluster}`, ...server });
  }
  targets.push(...fixed);
  return { targets, notes };
}

/** Resolves each target's IPv4 addresses on the runner, so the box can try them without DNS. */
export async function withAddresses(
  targets: readonly Omit<Target, "addresses">[],
  lookup: (host: string) => Promise<string[]> = async (host) =>
    (await dns.lookup(host, { all: true, family: 4 })).map((a) => a.address),
): Promise<Target[]> {
  return Promise.all(
    targets.map(async (t) => {
      let addresses: string[] = [];
      try {
        addresses = (await lookup(t.host)).slice(0, 2);
      } catch {
        // Not resolvable from the runner either; the box still tries by name.
      }
      return { ...t, addresses };
    }),
  );
}
