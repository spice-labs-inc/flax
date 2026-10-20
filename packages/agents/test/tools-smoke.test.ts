import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, onTestFinished } from "vitest";
import { stringify } from "yaml";
import { GITHUB_MCP_OPERATIONS } from "../src/tools-server/github.ts";
import { KUBERNETES_OPERATIONS } from "../src/tools-server/kubernetes.ts";
import {
  formatSmoke,
  runSmoke,
  type SmokeOptions,
} from "../src/tools-server/smoke.ts";
import {
  fakeGitHubApi,
  fakeOpenObserve,
  fakeSlackApi,
  localForwarder,
  writeFakeMcpServer,
} from "./fake-upstreams.ts";
import { tarArchive } from "./fake-tarball.ts";

const NOW = new Date("2026-09-28T20:00:00Z");
const READ = [{ id: "C0123456789", name: "alerts-test" }];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-smoke-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const kubeconfig = (cluster: string) =>
  stringify({
    apiVersion: "v1",
    kind: "Config",
    users: [{ name: "r", user: { token: `kube-token-${cluster}-0123456789` } }],
  });

const ENV = {
  KUBECONFIG_DEV: kubeconfig("dev"),
  KUBECONFIG_STAGING: kubeconfig("staging"),
  KUBECONFIG_PROD: kubeconfig("prod"),
  KUBECONFIG_SHARED_SERVICES: kubeconfig("shared-services"),
  AGENTS_READER_APP_ID: "123456",
  AGENTS_READER_PRIVATE_KEY: generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey,
  OPENOBSERVE_CI_AUTH: Buffer.from("ci@example.com:oo-password-123").toString(
    "base64",
  ),
  SLACK_AGENTS_BOT_TOKEN: "xoxb-fake-slack-token-0123456789",
};

/** Raw result text the report must never repeat. */
const RAW = {
  pods: "flux-system v1 Pod raw-pod-name-a",
  run: "raw-workflow-run-name",
  stream: "raw:stream:name",
  message: "raw slack message text",
  namespace: "raw-namespace-name",
  item: "raw board item title",
  epic: "raw epic title",
  readme: "raw readme line about notes",
  headline: "raw commit headline",
};

const SHA = "d".repeat(40);

/** A GitHub API with the answers the code reads expect for agents' README.md. */
function smokeGitHubApi() {
  const commit = {
    oid: SHA,
    committedDate: "2026-09-28T00:00:00Z",
    messageHeadline: RAW.headline,
    associatedPullRequests: { nodes: [] },
  };
  return fakeGitHubApi({
    graphql: {
      history: {
        repository: {
          object: {
            history: { pageInfo: { hasNextPage: true }, nodes: [commit] },
          },
        },
      },
      blame: {
        repository: {
          file: { text: `${RAW.readme}\n`, isBinary: false },
          commit: {
            blame: { ranges: [{ startingLine: 1, endingLine: 1, commit }] },
          },
        },
      },
    },
    trees: {
      [`agents/${SHA}`]: {
        tree: [
          { path: "README.md", type: "blob", size: 40 },
          { path: "src/raw.ts", type: "blob", size: 9 },
        ],
      },
    },
    tarballs: {
      [`agents/${SHA}`]: gzipSync(
        tarArchive([{ path: "README.md", data: `${RAW.readme}\n` }]),
      ),
    },
  });
}

async function options(
  overrides: Partial<SmokeOptions> = {},
): Promise<SmokeOptions> {
  const dir = tempDir();
  const k8s = writeFakeMcpServer(join(dir), {
    tools: KUBERNETES_OPERATIONS,
    replies: {
      pods_list: {
        text: `NAMESPACE APIVERSION KIND NAME\n${RAW.pods}\nflux-system v1 Pod b\n`,
      },
    },
  });
  const ghDir = mkdtempSync(join(dir, "gh-"));
  const gh = writeFakeMcpServer(ghDir, {
    tools: [...GITHUB_MCP_OPERATIONS, "search_code"],
    replies: {
      actions_list: {
        text: JSON.stringify({
          total_count: 7,
          workflow_runs: [{ name: RAW.run }],
        }),
      },
      projects_list: {
        text: JSON.stringify({
          items: [{ content: { title: RAW.item } }],
          pageInfo: { hasNextPage: true },
        }),
      },
      list_issues: {
        text: JSON.stringify({
          issues: [{ number: 1, title: RAW.epic }],
          totalCount: 134,
        }),
      },
    },
  });
  const oo = await fakeOpenObserve((req) =>
    req.path === "/api/default/streams"
      ? {
          status: 200,
          body: JSON.stringify({ total: 3, list: [{ name: RAW.stream }] }),
        }
      : undefined,
  );
  const slack = await fakeSlackApi([
    { ts: "1759089600.000100", text: RAW.message },
  ]);
  const api = await smokeGitHubApi();
  return {
    env: ENV,
    binDir: "/nonexistent",
    workRoot: join(dir, "work"),
    readChannels: READ,
    now: () => NOW,
    fetchBinaries: () => Promise.resolve("fetched with checksums checked"),
    commands: {
      "kubernetes-mcp-server": { command: k8s.command, args: k8s.args },
      "github-mcp-server": { command: gh.command, args: gh.args },
    },
    githubApiUrl: api.url,
    githubDownloadHttp: true,
    githubTarballHosts: ["127.0.0.1"],
    podForwarder: () => Promise.resolve(localForwarder(oo.port)),
    namespaceLister: () => ({
      list: () =>
        Promise.resolve([
          {
            name: RAW.namespace,
            phase: "Active",
            creationTimestamp: "2026-09-01T00:00:00Z",
          },
          {
            name: "flux-system",
            phase: "Active",
            creationTimestamp: "2026-09-01T00:00:00Z",
          },
        ]),
    }),
    slackApiUrl: slack.url,
    ...overrides,
  };
}

function leaks(report: string): string[] {
  return [...Object.values(ENV), ...Object.values(RAW), "ghs_faketoken"].filter(
    (v) => report.includes(v),
  );
}

describe("flax agents tools-smoke", () => {
  it("passes each upstream with its tool names and counts, and nothing else", async () => {
    const results = await runSmoke(await options());
    const report = formatSmoke(results);
    expect(report).toBe(
      [
        "PASS binaries",
        "  fetched with checksums checked",
        "PASS kubernetes",
        "  tools on dev: events_list, pods_get, pods_list, pods_log, resources_get, resources_list",
        "  tools on staging: events_list, pods_get, pods_list, pods_log, resources_get, resources_list",
        "  tools on prod: events_list, pods_get, pods_list, pods_log, resources_get, resources_list",
        "  tools on shared-services: events_list, pods_get, pods_list, pods_log, resources_get, resources_list",
        "  pods_list on dev, namespace flux-system: 2 pods",
        "  namespaces_list on dev (the tools server, no MCP server): 2 namespaces",
        "PASS github",
        "  tools: actions_list, get_file_contents, get_job_logs, get_latest_release, issue_read, list_commits, list_issues, list_pull_requests, list_releases, projects_list, pull_request_read, search_code, search_pull_requests",
        "  list_workflow_runs on agents: 7 runs",
        "  list_project_items on project 3, one In progress item: 1 found",
        "  list_issues on product: 134 issues",
        "  path_history of README.md on main (the tools server, GraphQL): 1 commits",
        "  commit_blame of README.md (GraphQL): 1 lines",
        "  commit_tree at that commit: 2 files",
        "  commit_grep of README.md at that commit (its tarball): 1 matching lines",
        "PASS openobserve",
        "  operations (REST through the port-forward, no MCP server): StreamList, StreamSchema, SearchSQL, SearchTracesSQL, PrometheusRangeQuery, GetLatestTraces",
        "  StreamList (logs): 3 streams",
        "PASS slack",
        "  operations (adapter, no MCP server): conversations.history, conversations.replies",
        "  conversations.history on #alerts-test, limit 1: 1 messages",
        "5 of 5 passed",
      ].join("\n"),
    );
    expect(leaks(report)).toEqual([]);
  });

  it("asks for every read permission a GitHub tool may need, so it proves the app has them", async () => {
    const api = await smokeGitHubApi();
    const results = await runSmoke(await options({ githubApiUrl: api.url }));
    expect(results.find((r) => r.name === "github")!.ok).toBe(true);
    const create = api.requests.find((r) => r.method === "POST");
    expect(JSON.parse(create!.body)).toEqual({
      permissions: {
        actions: "read",
        contents: "read",
        metadata: "read",
        pull_requests: "read",
        organization_projects: "read",
        issues: "read",
      },
    });
  });

  it("fails an upstream on its own, with a scrubbed reason, and counts the failures", async () => {
    const { SLACK_AGENTS_BOT_TOKEN: _, ...env } = ENV;
    const results = await runSmoke(
      await options({
        env,
        fetchBinaries: () =>
          Promise.reject(
            new Error(`sha256 mismatch while using ${ENV.OPENOBSERVE_CI_AUTH}`),
          ),
      }),
    );
    const report = formatSmoke(results);
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["binaries", false],
      ["kubernetes", true],
      ["github", true],
      ["openobserve", true],
      ["slack", false],
    ]);
    expect(report).toContain(
      "FAIL binaries\n  sha256 mismatch while using [redacted]",
    );
    expect(report).toContain(
      "FAIL slack\n  missing secrets for the tools: SLACK_AGENTS_BOT_TOKEN",
    );
    expect(report.endsWith("3 of 5 passed")).toBe(true);
    expect(leaks(report)).toEqual([]);
  });

  it("prints which stage failed and why, when the port-forward is refused", async () => {
    const oo = await fakeOpenObserve();
    const forwarder = localForwarder(oo.port);
    forwarder.refusal = {
      type: "error",
      message: "Unexpected server response: 403",
      error: new Error("Unexpected server response: 403"),
    };
    const results = await runSmoke(
      await options({ podForwarder: () => Promise.resolve(forwarder) }),
    );
    const openobserve = results.find((r) => r.name === "openobserve")!;
    expect(openobserve.ok).toBe(false);
    expect(openobserve.lines[0]).toMatch(
      /^OpenObserve: HTTP: fetch failed; cause: .+; port-forward: forward open: Unexpected server response: 403 \(pod openobserve-1\)$/,
    );
  });

  it("fails an upstream that takes too long, and stops it", async () => {
    const results = await runSmoke(
      await options({
        podForwarder: () => new Promise(() => undefined),
        upstreamMs: 300,
      }),
    );
    expect(results.find((r) => r.name === "openobserve")).toEqual({
      name: "openobserve",
      ok: false,
      lines: ["openobserve took longer than 0.3 s"],
    });
  });

  it("fails an upstream whose read does not answer in the expected shape", async () => {
    const dir = tempDir();
    const gh = writeFakeMcpServer(dir, {
      tools: GITHUB_MCP_OPERATIONS,
      replies: { actions_list: { text: "not json" } },
    });
    const results = await runSmoke(
      await options({
        commands: {
          ...(await options()).commands,
          "github-mcp-server": { command: gh.command, args: gh.args },
        },
      }),
    );
    const github = results.find((r) => r.name === "github")!;
    expect(github.ok).toBe(false);
    expect(github.lines[0]).toMatch(/JSON/);
  });
});
