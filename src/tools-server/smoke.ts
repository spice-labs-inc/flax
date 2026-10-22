import { workspace } from "../lib/workspace.ts";
import { join } from "node:path";
import type { ReadChannel } from "../lib/allowlists.ts";
import { GithubUpstream } from "./artifacts.ts";
import { errorChain } from "./errors.ts";
import {
  BOARD_FIELD_NAMES,
  boardNumber,
  boardQuery,
  EPIC_FIELDS,
  epicsRepo,
  FULL_SHA,
  GITHUB_OPERATIONS,
  githubOrg,
} from "./github.ts";
import {
  clusters,
  type Cluster,
  type KubernetesUpstream,
} from "./kubernetes.ts";
import { McpUpstream } from "./mcp-upstream.ts";
import { OPENOBSERVE_OPERATIONS } from "./openobserve.ts";
import { scrubber } from "./scrub.ts";
import { SLACK_OPERATIONS } from "./slack.ts";
import {
  credentialValues,
  startUpstreams,
  type RunningUpstreams,
  type StartUpstreamsOptions,
} from "./start-upstreams.ts";
import type { Upstream } from "./upstreams.ts";

export const SMOKE_UPSTREAMS = [
  "kubernetes",
  "github",
  "openobserve",
  "slack",
] as const;

/** The one trivial read per upstream. */
export const SMOKE_READS = {
  kubernetesCluster: Object.keys(workspace().clusters)[0] ?? "",
  kubernetesNamespace: "flux-system",
  githubRepo: workspace().repo.slice(workspace().repo.indexOf("/") + 1),
  githubFile: "README.md",
};

/** How long one upstream may take to start, list and read. */
export const SMOKE_UPSTREAM_MS = 120_000;
const CALL_MS = 60_000;
const MAX_DETAIL = 300;

export interface SmokeResult {
  name: string;
  ok: boolean;
  /** Tool names, counts and errors; never results or credential values. */
  lines: string[];
}

export interface SmokeOptions extends Omit<
  StartUpstreamsOptions,
  "servers" | "workDir"
> {
  /** Where each upstream's work directory goes, one per upstream. */
  workRoot: string;
  /** Downloads and checks the MCP server binaries; resolves with a line describing them. */
  fetchBinaries: () => Promise<string>;
  upstreamMs?: number;
}

function parseJson(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("the answer is not a JSON object");
  return value as Record<string, unknown>;
}

function countOf(
  value: Record<string, unknown>,
  total: string,
  list: string,
): number {
  if (typeof value[total] === "number") return value[total];
  const items = value[list];
  if (Array.isArray(items)) return items.length;
  throw new Error(`the answer has neither ${total} nor ${list}`);
}

/** Rows of a kubernetes-mcp-server table, without its header. */
function tableRows(text: string): number {
  const rows = text.split("\n").filter((l) => l.trim() !== "");
  return rows[0]?.startsWith("NAMESPACE") ? rows.length - 1 : rows.length;
}

async function toolNames(upstream: Upstream | undefined): Promise<string[]> {
  if (!(upstream instanceof McpUpstream))
    throw new Error("the upstream is not an MCP connection");
  const { tools } = await upstream.client.listTools();
  return tools.map((t) => t.name).sort();
}

const signal = () => AbortSignal.timeout(CALL_MS);

/** The code reads the tools server serves itself: GraphQL history and blame, a recursive tree and a tarball grep, at main's newest commit to the smoke file. */
async function probeCode(up: Upstream): Promise<string[]> {
  const base = { owner: githubOrg(), repo: SMOKE_READS.githubRepo };
  const path = SMOKE_READS.githubFile;
  const history = parseJson(
    await up.call(
      "path_history",
      { ...base, path, ref: "main", count: 1 },
      signal(),
    ),
  );
  const sha = (history.commits as { sha?: unknown }[] | undefined)?.[0]?.sha;
  if (typeof sha !== "string" || !FULL_SHA.test(sha))
    throw new Error(`path_history found no commit to ${path}`);
  const blame = parseJson(
    await up.call(
      "commit_blame",
      { ...base, sha, path, start_line: 1, line_count: 1 },
      signal(),
    ),
  );
  const tree = await up.call(
    "commit_tree",
    { ...base, sha, max_paths: 1 },
    signal(),
  );
  const grep = await up.call(
    "commit_grep",
    {
      ...base,
      sha,
      pattern: "notes",
      fixed_string: true,
      ignore_case: true,
      path_glob: path,
      max_matches: 1,
    },
    signal(),
  );
  const count = (text: string, what: RegExp) => {
    const m = what.exec(text.split("\n")[0] ?? "");
    if (m === null) throw new Error("the answer has no count");
    return m[1];
  };
  return [
    `path_history of ${path} on main (the tools server, GraphQL): ${(history.commits as unknown[]).length} commits`,
    `commit_blame of ${path} (GraphQL): ${countOf(blame, "", "blame")} lines`,
    `commit_tree at that commit: ${count(tree, /: (\d+) files/)} files`,
    `commit_grep of ${path} at that commit (its tarball): ${count(grep, /: (\d+) matching lines/)} matching lines`,
  ];
}

/** Lists tools and makes one trivial read; returns the lines to print. */
async function probe(
  name: string,
  running: RunningUpstreams,
  readChannels: readonly ReadChannel[],
  now: Date,
): Promise<string[]> {
  const up = running.upstreams[name];
  switch (name) {
    case "kubernetes": {
      const k8s = up as KubernetesUpstream;
      const lines: string[] = [];
      for (const cluster of Object.keys(clusters()) as Cluster[])
        lines.push(
          `tools on ${cluster}: ${(await toolNames(k8s.clusters.get(cluster))).join(", ")}`,
        );
      const { kubernetesCluster: cluster, kubernetesNamespace: namespace } =
        SMOKE_READS;
      const text = await k8s.call(
        "pods_list",
        { cluster, fieldSelector: `metadata.namespace=${namespace}` },
        signal(),
      );
      lines.push(
        `pods_list on ${cluster}, namespace ${namespace}: ${tableRows(text)} pods`,
      );
      const namespaces = countOf(
        parseJson(await k8s.call("namespaces_list", { cluster }, signal())),
        "count",
        "namespaces",
      );
      lines.push(
        `namespaces_list on ${cluster} (the tools server, no MCP server): ${namespaces} namespaces`,
      );
      return lines;
    }
    case "github": {
      const tools = await toolNames(up instanceof GithubUpstream ? up.mcp : up);
      const text = await up!.call(
        "actions_list",
        {
          owner: githubOrg(),
          repo: SMOKE_READS.githubRepo,
          method: "list_workflow_runs",
          perPage: 1,
          page: 1,
        },
        signal(),
      );
      const runs = countOf(parseJson(text), "total_count", "workflow_runs");
      const board = await up!.call(
        "projects_list",
        {
          method: "list_project_items",
          owner: githubOrg(),
          owner_type: "org",
          project_number: boardNumber(),
          field_names: BOARD_FIELD_NAMES,
          query: boardQuery(undefined, ["In progress"]),
          perPage: 1,
        },
        signal(),
      );
      const epics = await up!.call(
        "list_issues",
        {
          owner: githubOrg(),
          repo: epicsRepo(),
          fields: EPIC_FIELDS,
          perPage: 1,
        },
        signal(),
      );
      const code = await probeCode(up!);
      return [
        `tools: ${tools.join(", ")}`,
        `list_workflow_runs on ${SMOKE_READS.githubRepo}: ${runs} runs`,
        `list_project_items on project ${boardNumber()}, one In progress item: ${countOf(parseJson(board), "totalCount", "items")} found`,
        `list_issues on ${epicsRepo()}: ${countOf(parseJson(epics), "totalCount", "issues")} issues`,
        ...code,
      ];
    }
    case "openobserve": {
      const text = await up!.call("StreamList", {}, signal());
      const streams = countOf(parseJson(text), "total", "streams");
      return [
        `operations (REST through the port-forward, no MCP server): ${OPENOBSERVE_OPERATIONS.join(", ")}`,
        `StreamList (logs): ${streams} streams`,
      ];
    }
    case "slack": {
      const channel = readChannels[0];
      if (channel === undefined)
        throw new Error("channels.yml lists no channel to read");
      const oldest = ((now.getTime() - 24 * 3600 * 1000) / 1000).toFixed(6);
      const text = await up!.call(
        "conversations.history",
        { channel: channel.id, oldest, limit: 1 },
        signal(),
      );
      const messages = countOf(parseJson(text), "count", "messages");
      return [
        `operations (adapter, no MCP server): ${SLACK_OPERATIONS.join(", ")}`,
        `conversations.history on #${channel.name}, limit 1: ${messages} messages`,
      ];
    }
    default:
      throw new Error(`${name} is not an upstream the smoke test knows`);
  }
}

function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} took longer than ${ms / 1000} s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Starts each upstream exactly as a run does, with the real credentials,
 * and makes only read-only calls: its tool list and one trivial read. Each
 * upstream is started, probed and stopped on its own, so one failure does
 * not hide the others. What it reports is tool names, counts and scrubbed
 * error lines, never results.
 */
export async function runSmoke(options: SmokeOptions): Promise<SmokeResult[]> {
  const { workRoot, fetchBinaries, upstreamMs, ...start } = options;
  const results: SmokeResult[] = [];
  const known = scrubber(credentialValues(start.env, SMOKE_UPSTREAMS));
  const clean = (err: unknown) => known(errorChain(err)).slice(0, MAX_DETAIL);
  try {
    results.push({
      name: "binaries",
      ok: true,
      lines: [await fetchBinaries()],
    });
  } catch (err) {
    results.push({ name: "binaries", ok: false, lines: [clean(err)] });
  }
  for (const name of SMOKE_UPSTREAMS) {
    const held: { running?: RunningUpstreams } = {};
    const work = (async () => {
      held.running = await startUpstreams({
        ...start,
        githubOperations: GITHUB_OPERATIONS,
        servers: [name],
        workDir: join(workRoot, name),
      });
      return probe(
        name,
        held.running,
        start.readChannels,
        start.now?.() ?? new Date(),
      );
    })();
    try {
      const lines = await withTimeout(
        work,
        upstreamMs ?? SMOKE_UPSTREAM_MS,
        name,
      );
      results.push({ name, ok: true, lines });
    } catch (err) {
      const message = clean(err);
      results.push({
        name,
        ok: false,
        lines: [
          held.running === undefined ? message : held.running.scrub(message),
        ],
      });
    } finally {
      if (held.running !== undefined)
        await held.running.close().catch(() => undefined);
      // An upstream still starting when its time ran out is stopped once it has started.
      else
        void work.then(
          () => held.running?.close(),
          () => undefined,
        );
    }
  }
  return results;
}

/** The report the workflow prints: PASS or FAIL per upstream, then a total. */
export function formatSmoke(results: readonly SmokeResult[]): string {
  const out: string[] = [];
  for (const r of results) {
    out.push(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
    for (const line of r.lines) out.push(`  ${line}`);
  }
  const passed = results.filter((r) => r.ok).length;
  out.push(`${passed} of ${results.length} passed`);
  return out.join("\n");
}
