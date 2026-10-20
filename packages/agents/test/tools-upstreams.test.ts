import { generateKeyPairSync, verify } from "node:crypto";
import { FIXTURE_WORKSPACE, jobConfig } from "./helpers.ts";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { describe, expect, it, onTestFinished } from "vitest";
import { parse, stringify } from "yaml";
import type { JobConfig } from "../src/lib/job.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { UPSTREAM_OPERATIONS } from "../src/lib/tools.ts";
import {
  createInstallationToken,
  githubArgs,
  githubGuard,
  READ_PERMISSIONS,
  readPermissions,
} from "../src/tools-server/github.ts";
import { jobOperations } from "../src/run-job/tools.ts";
import {
  KUBERNETES_OPERATIONS,
  kubeNamespaceLister,
  kubernetesConfig,
} from "../src/tools-server/kubernetes.ts";
import {
  kubePodForwarder,
  PortForward,
} from "../src/tools-server/openobserve.ts";
import { resultText } from "../src/tools-server/mcp-upstream.ts";
import { ToolsServer } from "../src/tools-server/server.ts";
import { SlackUpstream } from "../src/tools-server/slack.ts";
import { loadJobTools } from "../src/tools-server/start.ts";
import {
  startUpstreams,
  type RunningUpstreams,
  type StartUpstreamsOptions,
} from "../src/tools-server/start-upstreams.ts";
import {
  fakeGitHubApi,
  fakeOpenObserve,
  fakeSlackApi,
  localForwarder,
  writeFakeMcpServer,
} from "./fake-upstreams.ts";
import { tarArchive } from "./fake-tarball.ts";

const NOW = new Date("2026-09-28T20:00:00Z");
const HOUR = 3600 * 1000;
const iso = (msBeforeNow: number) =>
  new Date(NOW.getTime() - msBeforeNow).toISOString();
const READ = [{ id: "C0123456789", name: "alerts-test" }];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-upstreams-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function kubeconfig(cluster: string): string {
  return stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      { name: cluster, cluster: { server: `https://${cluster}.example:6443` } },
    ],
    contexts: [{ name: cluster, context: { cluster, user: "reader" } }],
    "current-context": cluster,
    users: [
      { name: "reader", user: { token: `kube-token-${cluster}-0123456789` } },
    ],
  });
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const ENV = {
  KUBECONFIG_DEV: kubeconfig("dev"),
  KUBECONFIG_STAGING: kubeconfig("staging"),
  KUBECONFIG_PROD: kubeconfig("prod"),
  KUBECONFIG_SHARED_SERVICES: kubeconfig("shared-services"),
  AGENTS_READER_APP_ID: "123456",
  AGENTS_READER_PRIVATE_KEY: privateKey,
  OPENOBSERVE_CI_AUTH: Buffer.from(
    "ci-traces@notes-co.example:oo-password-123",
  ).toString("base64"),
  SLACK_AGENTS_BOT_TOKEN: "xoxb-fake-slack-token-0123456789",
  LLM_GATEWAY_ISSUER_KEY: "issuer-key-must-never-reach-a-child",
};

async function start(
  overrides: Partial<StartUpstreamsOptions> & { servers: string[] },
): Promise<RunningUpstreams & { workDir: string }> {
  const workDir = join(tempDir(), "tools-work");
  const running = await startUpstreams({
    env: ENV,
    workDir,
    binDir: "/nonexistent",
    readChannels: READ,
    now: () => NOW,
    ...overrides,
  });
  onTestFinished(() => running.close());
  return { ...running, workDir };
}

async function serve(running: RunningUpstreams, tools: string[]) {
  return new ToolsServer({
    tools: await loadJobTools(FIXTURE_WORKSPACE, tools),
    limits: { calls: 100, seconds: 10 },
    upstreams: running.upstreams,
    readChannels: READ,
    scrub: running.scrub,
    now: () => NOW,
  });
}

const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;

/** The data between the untrusted-data markers. */
function data(r: CallToolResult): string {
  const m = /\n<data-([0-9a-f]{12})>\n([\s\S]*)\n<\/data-\1>/.exec(textOf(r));
  if (m === null) throw new Error(`no data block in ${textOf(r)}`);
  return m[2]!;
}

describe("startUpstreams", () => {
  it("refuses to start without the secrets the tools need, naming them but not their values", async () => {
    await expect(
      startUpstreams({
        servers: ["github", "slack"],
        env: { AGENTS_READER_APP_ID: "1" },
        workDir: join(tempDir(), "w"),
        binDir: "/nonexistent",
        readChannels: [],
      }),
    ).rejects.toThrow(
      "missing secrets for the tools: AGENTS_READER_PRIVATE_KEY, SLACK_AGENTS_BOT_TOKEN",
    );
    await expect(
      startUpstreams({
        servers: ["shell"],
        env: {},
        workDir: join(tempDir(), "w"),
        binDir: "/nonexistent",
        readChannels: [],
      }),
    ).rejects.toThrow("missing secrets for the tools: shell (not an upstream)");
  });
});

describe("the kubernetes upstream", () => {
  async function k8s(tools = UPSTREAM_OPERATIONS.kubernetes!) {
    const dir = tempDir();
    const fake = writeFakeMcpServer(dir, { tools, replies: {} });
    const running = await start({
      servers: ["kubernetes"],
      commands: {
        "kubernetes-mcp-server": { command: fake.command, args: fake.args },
      },
    });
    return { fake, running };
  }

  it("starts one read-only server per cluster, each with only its own kubeconfig", async () => {
    const { fake, running } = await k8s();
    const starts = fake.records().filter((r) => r.type === "start");
    expect(starts).toHaveLength(4);
    for (const [i, cluster] of [
      "dev",
      "staging",
      "prod",
      "shared-services",
    ].entries()) {
      const s = starts[i]!;
      expect(s.kubeconfig).toBe(kubeconfig(cluster));
      expect(s.config).toBe(kubernetesConfig());
      expect(s.argv).toEqual(
        expect.arrayContaining([
          "--read-only",
          "--toolsets",
          "core",
          "--disable-multi-cluster",
        ]),
      );
      for (const value of Object.values(ENV))
        expect(Object.values(s.env!)).not.toContain(value);
      expect(
        Object.keys(s.env!).filter((k) => /KUBECONFIG|TOKEN|KEY|AUTH/.test(k)),
      ).toEqual([]);
    }
    const kubeconfigPath =
      starts[0]!.argv![starts[0]!.argv!.indexOf("--kubeconfig") + 1]!;
    expect(statSync(kubeconfigPath).mode & 0o777).toBe(0o600);
    expect(statSync(running.workDir).mode & 0o777).toBe(0o700);
    await running.close();
    expect(existsSync(running.workDir)).toBe(false);
  });

  it("configures read-only core tools, only the ones the tools call, never the config toolset, and no Secrets", () => {
    const config = kubernetesConfig();
    expect(config).toContain("read_only = true");
    expect(config).toContain('toolsets = ["core"]');
    expect(config).toContain(
      'enabled_tools = ["pods_list", "pods_get", "events_list", "pods_log", "resources_list", "resources_get"]',
    );
    expect(config).toContain(
      '[[denied_resources]]\ngroup = ""\nversion = "v1"\nkind = "Secret"',
    );
    expect(config).not.toMatch(/config"|configuration_view/);
  });

  it("routes each call to its cluster's server, without the cluster argument", async () => {
    const { fake, running } = await k8s();
    const server = await serve(running, ["k8s-pods", "k8s-pod-log"]);
    await server.call("k8s-pods", { cluster: "prod", namespace: "backend" });
    await server.call("k8s-pod-log", {
      cluster: "dev",
      namespace: "a",
      name: "b",
      tail: 5,
    });
    const records = fake.records();
    const pidOf = (cluster: string) =>
      records.find(
        (r) => r.type === "start" && r.kubeconfig === kubeconfig(cluster),
      )!.pid;
    const calls = records.filter((r) => r.type === "call");
    expect(calls).toEqual([
      {
        type: "call",
        pid: pidOf("prod"),
        name: "pods_list",
        arguments: { fieldSelector: "metadata.namespace=backend" },
      },
      {
        type: "call",
        pid: pidOf("dev"),
        name: "pods_log",
        arguments: { namespace: "a", name: "b", tail: 5 },
      },
    ]);
  });

  it("refuses a cluster that is not one of the four, sending nothing", async () => {
    const { fake, running } = await k8s();
    await expect(
      running.upstreams.kubernetes!.call(
        "pods_list",
        { cluster: "prod-vault" },
        new AbortController().signal,
      ),
    ).rejects.toThrow('"prod-vault" is not a cluster tools may read');
    await expect(
      running.upstreams.kubernetes!.call(
        "pods_delete",
        { cluster: "prod" },
        new AbortController().signal,
      ),
    ).rejects.toThrow('"pods_delete" is not an allowed operation');
    expect(fake.records().filter((r) => r.type === "call")).toEqual([]);
  });

  it("fails to start when a server does not offer an operation the tools call", async () => {
    const dir = tempDir();
    const fake = writeFakeMcpServer(dir, { tools: ["pods_list"] });
    const workDir = join(dir, "work");
    await expect(
      startUpstreams({
        servers: ["kubernetes"],
        env: ENV,
        workDir,
        binDir: "/nonexistent",
        readChannels: [],
        commands: {
          "kubernetes-mcp-server": { command: fake.command, args: fake.args },
        },
      }),
    ).rejects.toThrow(
      "kubernetes-mcp-server for dev: does not offer pods_get, events_list, pods_log, resources_list, resources_get",
    );
    expect(existsSync(workDir)).toBe(false);
  });

  it("scrubs the kubeconfig token and UUIDs from results", async () => {
    const dir = tempDir();
    const fake = writeFakeMcpServer(dir, {
      tools: UPSTREAM_OPERATIONS.kubernetes!,
      replies: {
        pods_get: {
          text: "uid: 7c9e6679-7425-40de-944b-e07fc1f90ae7\ntoken: kube-token-prod-0123456789",
        },
      },
    });
    const running = await start({
      servers: ["kubernetes"],
      commands: {
        "kubernetes-mcp-server": { command: fake.command, args: fake.args },
      },
    });
    const server = await serve(running, ["k8s-pods"]);
    const out = data(
      await server.call("k8s-pods", {
        cluster: "prod",
        namespace: "a",
        name: "b",
      }),
    );
    expect(out).toBe("uid: :id\ntoken: [redacted]");
  });

  it("lists namespaces with the cluster's own kubeconfig, never through the MCP server, returning four fields", async () => {
    const dir = tempDir();
    const fake = writeFakeMcpServer(dir, { tools: KUBERNETES_OPERATIONS });
    const asked: { kubeconfig: string; phase: string | undefined }[] = [];
    const running = await start({
      servers: ["kubernetes"],
      commands: {
        "kubernetes-mcp-server": { command: fake.command, args: fake.args },
      },
      namespaceLister: (kc) => ({
        list: (phase) => {
          asked.push({ kubeconfig: kc, phase });
          return Promise.resolve([
            {
              name: "project-7c9e6679-7425-40de-944b-e07fc1f90ae7",
              phase: "Terminating",
              creationTimestamp: "2026-09-20T10:00:00Z",
              deletionTimestamp: "2026-09-28T19:30:00Z",
            },
          ]);
        },
      }),
    });
    const server = await serve(running, ["k8s-namespaces"]);
    const out = data(
      await server.call("k8s-namespaces", {
        cluster: "dev",
        phase: "Terminating",
      }),
    );
    expect(JSON.parse(out)).toEqual({
      count: 1,
      namespaces: [
        {
          name: "project-:id",
          phase: "Terminating",
          creationTimestamp: "2026-09-20T10:00:00Z",
          deletionTimestamp: "2026-09-28T19:30:00Z",
        },
      ],
    });
    expect(asked).toEqual([
      { kubeconfig: kubeconfig("dev"), phase: "Terminating" },
    ]);
    expect(fake.records().filter((r) => r.type === "call")).toEqual([]);
  });

  it("refuses namespaces_list arguments other than a known phase, reading nothing", async () => {
    const dir = tempDir();
    const fake = writeFakeMcpServer(dir, { tools: KUBERNETES_OPERATIONS });
    let listed = 0;
    const running = await start({
      servers: ["kubernetes"],
      commands: {
        "kubernetes-mcp-server": { command: fake.command, args: fake.args },
      },
      namespaceLister: () => ({
        list: () => {
          listed += 1;
          return Promise.resolve([]);
        },
      }),
    });
    const k8s = running.upstreams.kubernetes!;
    const signal = new AbortController().signal;
    await expect(
      k8s.call(
        "namespaces_list",
        { cluster: "prod", fieldSelector: "metadata.name=x" },
        signal,
      ),
    ).rejects.toThrow("namespaces_list takes no fieldSelector");
    await expect(
      k8s.call("namespaces_list", { cluster: "prod", phase: "Gone" }, signal),
    ).rejects.toThrow('"Gone" is not a namespace phase');
    await expect(
      k8s.call("namespaces_list", { cluster: "prod-vault" }, signal),
    ).rejects.toThrow('"prod-vault" is not a cluster tools may read');
    expect(listed).toBe(0);
    expect(fake.records().filter((r) => r.type === "call")).toEqual([]);
  });

  it("reads namespaces with one GET of /api/v1/namespaces and keeps only name, phase and the two timestamps", async () => {
    const requests: string[] = [];
    const api = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          apiVersion: "v1",
          kind: "NamespaceList",
          metadata: {},
          items: [
            {
              metadata: {
                name: "project-a",
                creationTimestamp: "2026-09-20T10:00:00Z",
                deletionTimestamp: "2026-09-28T19:30:00Z",
                labels: { team: "raw-label" },
                annotations: { note: "raw-annotation" },
                finalizers: ["raw-finalizer"],
              },
              spec: { finalizers: ["kubernetes"] },
              status: {
                phase: "Terminating",
                conditions: [{ type: "NamespaceContentRemaining" }],
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    onTestFinished(() => new Promise<void>((r) => api.close(() => r())));
    const { port } = api.address() as AddressInfo;
    const kc = stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "c",
          cluster: {
            server: `http://127.0.0.1:${port}`,
            "insecure-skip-tls-verify": true,
          },
        },
      ],
      contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
      "current-context": "c",
      users: [{ name: "u", user: { token: "kube-token-local-0123456789" } }],
    });
    expect(await kubeNamespaceLister(kc).list("Terminating")).toEqual([
      {
        name: "project-a",
        phase: "Terminating",
        creationTimestamp: "2026-09-20T10:00:00Z",
        deletionTimestamp: "2026-09-28T19:30:00Z",
      },
    ]);
    expect(requests).toEqual([
      "GET /api/v1/namespaces?fieldSelector=status.phase%3DTerminating",
    ]);
  });

  it("turns an upstream error result into a failed call", async () => {
    const dir = tempDir();
    const fake = writeFakeMcpServer(dir, {
      tools: UPSTREAM_OPERATIONS.kubernetes!,
      replies: { pods_get: { text: 'pods "b" not found', isError: true } },
    });
    const running = await start({
      servers: ["kubernetes"],
      commands: {
        "kubernetes-mcp-server": { command: fake.command, args: fake.args },
      },
    });
    const server = await serve(running, ["k8s-pods"]);
    const result = await server.call("k8s-pods", {
      cluster: "prod",
      namespace: "a",
      name: "b",
    });
    expect(result.isError).toBe(true);
    expect(data(result)).toBe('pods "b" not found');
    expect(server.calls[0]).toMatchObject({ outcome: "failed" });
  });
});

describe("the GitHub upstream", () => {
  it("creates an installation token narrowed to read permissions, signed by the app", async () => {
    const api = await fakeGitHubApi();
    const token = await createInstallationToken({
      appId: "123456",
      privateKey,
      apiUrl: api.url,
      now: NOW,
    });
    expect(token.token).toBe("ghs_faketoken000000000000000000000000000");
    const [lookup, create] = api.requests;
    expect(lookup).toMatchObject({
      method: "GET",
      path: "/orgs/notes-co/installation",
    });
    expect(create).toMatchObject({
      method: "POST",
      path: "/app/installations/42/access_tokens",
    });
    expect(JSON.parse(create!.body)).toEqual({ permissions: READ_PERMISSIONS });
    expect(READ_PERMISSIONS).toEqual({
      actions: "read",
      contents: "read",
      metadata: "read",
      pull_requests: "read",
    });
    const jwt = lookup!.authorization.replace(/^Bearer /, "");
    const [header, payload, signature] = jwt.split(".");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    const claims = JSON.parse(
      Buffer.from(payload!, "base64url").toString(),
    ) as Record<string, number | string>;
    expect(claims).toEqual({
      iss: "123456",
      iat: NOW.getTime() / 1000 - 60,
      exp: NOW.getTime() / 1000 + 540,
    });
    await token.revoke();
    expect(api.requests[2]).toMatchObject({
      method: "DELETE",
      path: "/installation/token",
      authorization: `token ${token.token}`,
    });
  });

  it("revokes and refuses a token granted more than read access", async () => {
    const api = await fakeGitHubApi({
      permissions: {
        ...READ_PERMISSIONS,
        contents: "write",
        administration: "read",
      },
    });
    await expect(
      createInstallationToken({ appId: "1", privateKey, apiUrl: api.url }),
    ).rejects.toThrow(
      "the installation token was granted more than the read access it asked for (contents:write, administration:read); it was revoked",
    );
    expect(api.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/installation/token",
    });
  });

  it("adds issues and organization projects read only for the operations that need them", () => {
    expect(readPermissions([])).toEqual(READ_PERMISSIONS);
    expect(readPermissions(["actions_list", "get_file_contents"])).toEqual(
      READ_PERMISSIONS,
    );
    expect(readPermissions(["projects_list"])).toEqual({
      ...READ_PERMISSIONS,
      organization_projects: "read",
    });
    expect(readPermissions(["list_issues", "issue_read"])).toEqual({
      ...READ_PERMISSIONS,
      issues: "read",
    });
    // The fixture workspace's own tools: the epics tool reads issues, the board tool reads organization projects.
    const ops = (tools: string[]) =>
      jobOperations(
        FIXTURE_WORKSPACE,
        jobConfig("demo", { tools }) as unknown as JobConfig,
        "github",
      );
    expect(
      readPermissions(ops(["gh-product-epics", "gh-board-items", "gh-pull-requests"])),
    ).toEqual({
      ...READ_PERMISSIONS,
      issues: "read",
      organization_projects: "read",
    });
    for (const tools of [[], ["gh-pull-requests"], ["gh-file", "gh-tree", "gh-workflow-runs"]])
      expect(readPermissions(ops(tools)), tools.join(",")).toEqual(READ_PERMISSIONS);
  });

  it("asks for the permissions its operations need, and refuses a token missing none but granted more", async () => {
    const api = await fakeGitHubApi();
    const fake = writeFakeMcpServer(tempDir(), {
      tools: UPSTREAM_OPERATIONS.github!,
    });
    await start({
      servers: ["github"],
      githubOperations: ["projects_list", "list_issues"],
      githubApiUrl: api.url,
      commands: {
        "github-mcp-server": { command: fake.command, args: fake.args },
      },
    });
    const create = api.requests.find((r) => r.method === "POST");
    expect(JSON.parse(create!.body)).toEqual({
      permissions: {
        ...READ_PERMISSIONS,
        issues: "read",
        organization_projects: "read",
      },
    });
    const wider = await fakeGitHubApi({
      permissions: { ...READ_PERMISSIONS, issues: "read" },
    });
    await expect(
      createInstallationToken({
        appId: "1",
        privateKey,
        apiUrl: wider.url,
      }),
    ).rejects.toThrow("(issues:read); it was revoked");
  });

  it("names only the status of a failed GitHub request, never its body", async () => {
    await expect(
      createInstallationToken({
        appId: "1",
        privateKey,
        apiUrl: "http://127.0.0.1:9",
        fetch: () =>
          Promise.resolve(new Response('{"echo":"secret"}', { status: 401 })),
      }),
    ).rejects.toThrow("GET /orgs/notes-co/installation returned 401");
  });

  it("gives github-mcp-server only the run's token, read-only flags, and revokes the token at the end", async () => {
    const api = await fakeGitHubApi();
    const fake = writeFakeMcpServer(tempDir(), {
      tools: UPSTREAM_OPERATIONS.github!,
    });
    const running = await start({
      servers: ["github"],
      githubApiUrl: api.url,
      commands: {
        "github-mcp-server": { command: fake.command, args: fake.args },
      },
    });
    const [s] = fake.records().filter((r) => r.type === "start");
    expect(s!.argv).toEqual(githubArgs());
    expect(githubArgs()).toEqual([
      "stdio",
      "--read-only",
      "--toolsets",
      "repos,pull_requests,actions",
      "--tools",
      "actions_list,get_job_logs,list_pull_requests,pull_request_read,search_pull_requests,list_releases,get_latest_release,list_commits,get_file_contents,projects_list,list_issues,issue_read",
      "--lockdown-mode",
    ]);
    expect(s!.env!.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(
      "ghs_faketoken000000000000000000000000000",
    );
    for (const value of Object.values(ENV))
      expect(Object.values(s!.env!)).not.toContain(value);
    expect(running.secrets).toContain(
      "ghs_faketoken000000000000000000000000000",
    );

    const server = await serve(running, ["gh-job-log"]);
    await server.call("gh-job-log", { repo: "engine", job_id: 5 });
    expect(fake.records().filter((r) => r.type === "call")).toEqual([
      expect.objectContaining({
        name: "get_job_logs",
        arguments: {
          owner: "notes-co",
          repo: "engine",
          job_id: 5,
          return_content: true,
          tail_lines: 100,
        },
      }),
    ]);
    await running.close();
    expect(api.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/installation/token",
    });
  });

  it("reads a reply bigger than the SDK's 10 MiB default, such as the diff of a pull request with a bundle, and cuts it", async () => {
    const api = await fakeGitHubApi();
    const fake = writeFakeMcpServer(tempDir(), {
      tools: UPSTREAM_OPERATIONS.github!,
      replies: {
        pull_request_read: { text: "+".padEnd(1024, "x"), repeat: 12 * 1024 },
      },
    });
    const running = await start({
      servers: ["github"],
      githubApiUrl: api.url,
      commands: {
        "github-mcp-server": { command: fake.command, args: fake.args },
      },
    });
    const server = await serve(running, ["gh-pull-requests"]);
    const result = await server.call("gh-pull-requests", {
      repo: "agents",
      number: 28,
      view: "get_diff",
    });
    expect(result.isError).toBeUndefined();
    expect(server.calls[0]).toMatchObject({
      outcome: "ok",
      resultBytes: 65536,
      truncated: true,
    });
    expect(fake.records().filter((r) => r.type === "start")).toHaveLength(1);
  });

  it("scrubs the token and signed URLs from results and errors", async () => {
    const api = await fakeGitHubApi();
    const fake = writeFakeMcpServer(tempDir(), {
      tools: UPSTREAM_OPERATIONS.github!,
      replies: {
        get_job_logs: {
          text: 'failed to download log content: Get "https://results.blob.core.windows.net/logs/1.txt?sv=2021&sig=abcDEF123": ghs_faketoken000000000000000000000000000',
          isError: true,
        },
      },
    });
    const running = await start({
      servers: ["github"],
      githubApiUrl: api.url,
      commands: {
        "github-mcp-server": { command: fake.command, args: fake.args },
      },
    });
    const server = await serve(running, ["gh-job-log"]);
    const out = data(
      await server.call("gh-job-log", { repo: "engine", job_id: 5 }),
    );
    expect(out).toBe(
      'failed to download log content: Get "https://results.blob.core.windows.net/logs/1.txt?[redacted]": [redacted]',
    );
  });

  it("greps a commit's tarball on the runner with the run's token, keeping it in the work directory until the run ends", async () => {
    const sha = "c".repeat(40);
    const api = await fakeGitHubApi({
      tarballs: {
        [`engine/${sha}`]: gzipSync(
          tarArchive([
            { path: "src/store.rs", data: "fn a() {}\nfailed to open\n" },
          ]),
        ),
      },
    });
    const fake = writeFakeMcpServer(tempDir(), {
      tools: UPSTREAM_OPERATIONS.github!,
    });
    const running = await start({
      servers: ["github"],
      githubApiUrl: api.url,
      githubDownloadHttp: true,
      githubTarballHosts: ["127.0.0.1"],
      commands: {
        "github-mcp-server": { command: fake.command, args: fake.args },
      },
    });
    const server = await serve(running, ["gh-grep"]);
    const call = () =>
      server.call("gh-grep", { repo: "engine", sha, pattern: "open$" });
    const out = data(await call());
    expect(out.split("\n")).toEqual([
      `notes-co/engine at ${sha}: 1 matching lines in 1 files (1 text files searched). Each line: path:line:text.`,
      "src/store.rs:2:failed to open",
    ]);
    await call();
    const reads = api.requests.filter(
      (r) => r.path.includes("tarball") || r.path.startsWith("/codeload/"),
    );
    expect(reads.map((r) => [r.path, r.authorization])).toEqual([
      [
        `/repos/notes-co/engine/tarball/${sha}`,
        "Bearer ghs_faketoken000000000000000000000000000",
      ],
      [`/codeload/engine/${sha}?token=fakeCodeloadToken123`, "undefined"],
    ]);
    expect(
      existsSync(join(running.workDir, "tarballs", `engine-${sha}.tar.gz`)),
    ).toBe(true);
    await running.close();
    expect(existsSync(running.workDir)).toBe(false);
  });

  it("guards every call: the organization, read methods, and job logs as content only", () => {
    const ok = { owner: "notes-co", repo: "x" };
    expect(() =>
      githubGuard("list_pull_requests", { ...ok, owner: "other" }),
    ).toThrow("only notes-co repositories may be read");
    expect(() =>
      githubGuard("actions_list", {
        ...ok,
        method: "list_workflow_run_artifacts",
      }),
    ).toThrow(
      'actions_list method "list_workflow_run_artifacts" is not allowed',
    );
    expect(() =>
      githubGuard("pull_request_read", { ...ok, method: "update" }),
    ).toThrow('pull_request_read method "update" is not allowed');
    expect(() => githubGuard("get_job_logs", { ...ok, job_id: 1 })).toThrow(
      "get_job_logs must return content, never a URL",
    );
    expect(() =>
      githubGuard("get_job_logs", {
        ...ok,
        run_id: 1,
        failed_only: true,
        return_content: true,
      }),
    ).toThrow("get_job_logs reads one job at a time");
    expect(() =>
      githubGuard("get_job_logs", { ...ok, job_id: 1, return_content: true }),
    ).not.toThrow();
  });

  it("keeps the text of a file get_file_contents returns as an embedded resource, never a binary one", () => {
    const head = "successfully downloaded text file (SHA: abc123)";
    expect(
      resultText({
        content: [
          { type: "text", text: head },
          {
            type: "resource",
            resource: {
              uri: "repo://x",
              mimeType: "text/plain",
              text: "line 1\nline 2\n",
            },
          },
        ],
      }),
    ).toBe(`${head}\nline 1\nline 2\n`);
    expect(
      resultText({
        content: [
          { type: "text", text: "successfully downloaded binary file" },
          { type: "resource", resource: { uri: "repo://x", blob: "AAEC" } },
        ],
      }),
    ).toBe("successfully downloaded binary file");
  });
});

describe("the OpenObserve upstream", () => {
  async function openobserve(respond?: Parameters<typeof fakeOpenObserve>[0]) {
    // The start-up health check passes; respond shapes the API's answers.
    const oo = await fakeOpenObserve((req) =>
      req.path === "/healthz" ? undefined : respond?.(req),
    );
    const forwarder = localForwarder(oo.port);
    const running = await start({
      servers: ["openobserve"],
      podForwarder: (kc) => {
        expect(kc).toBe(ENV.KUBECONFIG_SHARED_SERVICES);
        return Promise.resolve(forwarder);
      },
    });
    const server = await serve(running, [
      "logs-streams",
      "logs-schema",
      "logs-search",
      "metrics-range",
      "traces-latest",
    ]);
    return { oo, forwarder, running, server };
  }

  const range = { start: iso(2 * HOUR), end: iso(HOUR) };
  const startUs = (NOW.getTime() - 2 * HOUR) * 1000;
  const endUs = (NOW.getTime() - HOUR) * 1000;

  it("calls each read endpoint through the port-forward with the service account, and returns a summary", async () => {
    const { oo, forwarder, server } = await openobserve();
    const answers = {
      streams: JSON.parse(
        data(await server.call("logs-streams", { keyword: "backend" })),
      ),
      schema: JSON.parse(
        data(await server.call("logs-schema", { stream: "prod:apps:backend" })),
      ),
      search: JSON.parse(
        data(
          await server.call("logs-search", {
            sql: "SELECT * FROM x",
            ...range,
            limit: 1,
          }),
        ),
      ),
      metrics: JSON.parse(
        data(
          await server.call("metrics-range", {
            query: "up",
            ...range,
            step_seconds: 60,
          }),
        ),
      ),
      traces: JSON.parse(
        data(
          await server.call("traces-latest", {
            stream: "prod",
            ...range,
            filter: "a='b'",
          }),
        ),
      ),
    };
    expect(oo.requests.map(({ authorization: _, ...r }) => r)).toEqual([
      { method: "GET", path: "/healthz", query: {} },
      {
        method: "GET",
        path: "/api/default/streams",
        query: { type: "logs", keyword: "backend" },
      },
      {
        method: "GET",
        path: "/api/default/streams/prod%3Aapps%3Abackend/schema",
        query: { type: "logs" },
      },
      {
        method: "POST",
        path: "/api/default/_search",
        query: { type: "logs" },
        body: {
          query: {
            sql: "SELECT * FROM x",
            start_time: startUs,
            end_time: endUs,
            from: 0,
            size: 1,
          },
        },
      },
      {
        method: "GET",
        path: "/api/default/prometheus/api/v1/query_range",
        query: { query: "up", start: range.start, end: range.end, step: "60" },
      },
      {
        method: "GET",
        path: "/api/default/prod/traces/latest",
        query: {
          start_time: String(startUs),
          end_time: String(endUs),
          from: "0",
          size: "20",
          filter: "a='b'",
        },
      },
    ]);
    expect(oo.requests[0]!.authorization).toBe("undefined");
    for (const r of oo.requests.slice(1))
      expect(r.authorization).toBe(`Basic ${ENV.OPENOBSERVE_CI_AUTH}`);
    expect(answers).toEqual({
      streams: {
        total: 1,
        streams: [
          {
            name: "prod:apps:backend",
            stream_type: "logs",
            doc_num: 12,
            storage_size: 3.5,
          },
        ],
      },
      schema: {
        name: "prod:apps:backend",
        stream_type: "logs",
        fields: [
          { name: "_timestamp", type: "Int64" },
          { name: "message", type: "Utf8" },
        ],
      },
      search: {
        total: 2,
        took_ms: 12,
        hits: [{ level: "error", message: "boom" }],
      },
      metrics: {
        status: "success",
        data: { resultType: "matrix", result: [] },
      },
      traces: {
        total: 1,
        took_ms: 3,
        hits: [
          {
            trace_id: "abc",
            spans: [3, 0],
            service_name: [{ service_name: "backend" }],
          },
        ],
      },
    });
    expect(forwarder.forwards.length).toBeGreaterThan(0);
  });

  it("accepts only its five operations and their own arguments, sending nothing otherwise", async () => {
    const { oo, running } = await openobserve();
    const up = running.upstreams.openobserve!;
    const signal = new AbortController().signal;
    const ok = {
      sql: "SELECT 1",
      start_time: startUs,
      end_time: endUs,
      size: 10,
    };
    const refused: [string, Record<string, unknown>, string][] = [
      ["tools_call", {}, '"tools_call" is not an allowed operation'],
      [
        "LogsIngestionJson",
        {},
        '"LogsIngestionJson" is not an allowed operation',
      ],
      [
        "StreamDelete",
        { stream_name: "x" },
        '"StreamDelete" is not an allowed operation',
      ],
      [
        "SearchSQL",
        { ...ok, org_id: "other" },
        '"org_id" is not an argument OpenObserve calls take here',
      ],
      [
        "SearchSQL",
        { ...ok, query_fn: ".x = 1" },
        '"query_fn" is not an argument OpenObserve calls take here',
      ],
      [
        "SearchSQL",
        { ...ok, sql: "SELECT 1; DROP x" },
        "sql must be one statement, with no semicolon",
      ],
      [
        "SearchSQL",
        { ...ok, sql: "DELETE FROM x" },
        "sql must be a SELECT statement",
      ],
      [
        "SearchSQL",
        { ...ok, size: 101 },
        "size must be an integer from 1 to 100",
      ],
      [
        "SearchSQL",
        { ...ok, start_time: endUs - 25 * HOUR * 1000 },
        "the time range must be positive and at most 24 hours",
      ],
      [
        "StreamSchema",
        { stream_name: "../../users" },
        "stream_name has characters a stream name cannot have",
      ],
      [
        "StreamList",
        { type: "traces" },
        '"type" is not an argument OpenObserve calls take here',
      ],
      [
        "GetLatestTraces",
        { stream_name: "prod", start_time: startUs, end_time: endUs, size: 51 },
        "size must be an integer from 1 to 50",
      ],
      [
        "PrometheusRangeQuery",
        { query: "up", start: range.start, end: range.end, step: "59" },
        "step must be an integer from 60 to 86400",
      ],
    ];
    for (const [op, args, message] of refused)
      await expect(up.call(op, args, signal)).rejects.toThrow(message);
    expect(oo.requests.map((r) => r.path)).toEqual(["/healthz"]);
  });

  it.each([
    [
      401,
      '{"code":401,"message":"Unauthorized Access"}',
      'OpenObserve answered 401: {"code":401,"message":"Unauthorized Access"}',
    ],
    [
      500,
      "internal error for org 0f8fad5b-d9cb-469f-a165-70867728950e",
      "OpenObserve answered 500: internal error for org :id",
    ],
    [
      200,
      "<html>not json</html>",
      "OpenObserve answered StreamList with something that is not JSON",
    ],
    [
      200,
      '{"unexpected":true}',
      "OpenObserve answered StreamList in an unknown shape",
    ],
  ])(
    "turns an answer of %i %s into a scrubbed, wrapped failure",
    async (status, body, message) => {
      const { server } = await openobserve(() => ({ status, body }));
      const result = await server.call("logs-streams", {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(
        /^logs-streams failed:\nThe text between the two data-/,
      );
      expect(data(result)).toBe(message);
    },
  );

  it("scrubs the service account's credentials from error text", async () => {
    const { server } = await openobserve(() => ({
      status: 403,
      body: `denied for Basic ${ENV.OPENOBSERVE_CI_AUTH} with password oo-password-123`,
    }));
    const out = data(await server.call("logs-streams", {}));
    expect(out).not.toContain(ENV.OPENOBSERVE_CI_AUTH);
    expect(out).not.toContain("oo-password-123");
  });

  it("tries a request once more when the forward drops under it", async () => {
    const { oo, forwarder, server } = await openobserve();
    await server.call("logs-streams", {});
    for (const s of forwarder.sockets) s.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await server.call("logs-streams", {});
    expect(result.isError).toBeUndefined();
    expect(oo.requests).toHaveLength(3);
  });

  it("fails at start, naming the stage and the cause, when the Kubernetes API refuses the forward", async () => {
    // What run 36504195145 hit: the reader's Role allowed create but not get
    // on pods/portforward, and client-node opens the forward with a
    // WebSocket GET, so every forward was refused with 403 and fetch said
    // only "fetch failed".
    const oo = await fakeOpenObserve();
    const forwarder = localForwarder(oo.port);
    forwarder.refusal = {
      type: "error",
      message: "Unexpected server response: 403",
      error: new Error("Unexpected server response: 403"),
    };
    await expect(
      startUpstreams({
        servers: ["openobserve"],
        env: ENV,
        workDir: join(tempDir(), "w"),
        binDir: "/nonexistent",
        readChannels: [],
        podForwarder: () => Promise.resolve(forwarder),
      }),
    ).rejects.toThrow(
      /^OpenObserve: HTTP: fetch failed; cause: .+; port-forward: forward open: Unexpected server response: 403 \(pod openobserve-1\)$/,
    );
    expect(oo.requests).toEqual([]);
  });

  it("fails at start at the pod lookup, with its cause", async () => {
    await expect(
      startUpstreams({
        servers: ["openobserve"],
        env: ENV,
        workDir: join(tempDir(), "w"),
        binDir: "/nonexistent",
        readChannels: [],
        podForwarder: () =>
          Promise.resolve({
            findPod: () =>
              Promise.reject(
                new Error("HTTP-Code: 403", {
                  cause: {
                    code: "Forbidden",
                    message: `token ${ENV.OPENOBSERVE_CI_AUTH}`,
                  },
                }),
              ),
            connect: () => Promise.reject(new Error("unused")),
          }),
      }),
    ).rejects.toThrow(
      "OpenObserve: pod lookup: HTTP-Code: 403; cause: Forbidden token [redacted]",
    );
  });

  it("adds the port-forward's last problem to a request that fails mid-run", async () => {
    const { forwarder, server } = await openobserve();
    forwarder.refusal = new Error("Unexpected server response: 500");
    for (const s of forwarder.sockets) s.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const out = data(await server.call("logs-streams", {}));
    expect(out).toMatch(
      /^HTTP: fetch failed; cause: .+; port-forward: forward open: Unexpected server response: 500 \(pod openobserve-1\)$/,
    );
  });

  it("closes the port-forward at the end of the run", async () => {
    const { forwarder, running, server } = await openobserve();
    await server.call("logs-streams", {});
    await running.close();
    for (const s of forwarder.sockets) expect(s.destroyed).toBe(true);
  });
});

describe("the port-forward", () => {
  /** A tiny TCP echo service standing in for the OpenObserve pod. */
  async function echoPort(): Promise<number> {
    const { createServer } = await import("node:net");
    const server = createServer((s) => s.pipe(s));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    onTestFinished(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    return (server.address() as { port: number }).port;
  }

  function roundTrip(port: number, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(text));
      socket.once("data", (d) => {
        resolve(d.toString());
        socket.destroy();
      });
      socket.once("error", reject);
      socket.once("close", () => resolve(""));
    });
  }

  it("opens a new forward for each connection, so a dropped forward costs only its own", async () => {
    const forwarder = localForwarder(await echoPort());
    const forward = new PortForward(forwarder);
    onTestFinished(() => forward.close());
    const port = await forward.start();
    expect(await roundTrip(port, "one")).toBe("one");
    forwarder.sockets[0]!.destroy();
    expect(await roundTrip(port, "two")).toBe("two");
    expect(forward.forwards).toBe(2);
    expect(forwarder.lookups).toBe(1);
  });

  it("looks the pod up again when a forward cannot be opened", async () => {
    const forwarder = localForwarder(await echoPort(), [
      "openobserve-old",
      "openobserve-new",
    ]);
    const forward = new PortForward(forwarder);
    onTestFinished(() => forward.close());
    const port = await forward.start();
    forwarder.stale.add("openobserve-old");
    expect(await roundTrip(port, "hello")).toBe("hello");
    expect(forwarder.forwards).toEqual(["openobserve-new"]);
    expect(forwarder.lookups).toBe(2);
  });

  it("drops a connection it cannot forward even after a fresh lookup", async () => {
    const forwarder = localForwarder(await echoPort());
    const forward = new PortForward(forwarder);
    onTestFinished(() => forward.close());
    const port = await forward.start();
    forwarder.stale.add("openobserve-1");
    expect(await roundTrip(port, "x")).toBe("");
  });

  it("closes open forwards and stops listening when closed", async () => {
    const forwarder = localForwarder(await echoPort());
    const forward = new PortForward(forwarder);
    const port = await forward.start();
    const open = connect(port, "127.0.0.1");
    await new Promise((resolve) => open.once("connect", resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await forward.close();
    for (const s of forwarder.sockets) expect(s.destroyed).toBe(true);
    await expect(
      new Promise((resolve, reject) => {
        const s = connect(port, "127.0.0.1", () => resolve("connected"));
        s.once("error", reject);
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("the Slack upstream", () => {
  const messages = [
    {
      ts: "1759089600.000100",
      user: "U1",
      text: "deploy failed for org 0f8fad5b-d9cb-469f-a165-70867728950e",
      blocks: [{ type: "rich_text" }],
      attachments: [{ title: "Alert", text: "details", color: "#f00" }],
      reply_count: 2,
    },
  ];

  it("reads listed channels with the bot token and keeps only the useful fields", async () => {
    const slack = await fakeSlackApi(messages);
    const running = await start({ servers: ["slack"], slackApiUrl: slack.url });
    const server = await serve(running, ["slack-history"]);
    const out = data(
      await server.call("slack-history", { channel: "alerts-test", limit: 10 }),
    );
    expect(JSON.parse(out)).toEqual({
      channel: "#alerts-test",
      messages: [
        {
          ts: "1759089600.000100",
          user: "U1",
          text: "deploy failed for org :id",
          reply_count: 2,
          attachments: [{ title: "Alert", text: "details" }],
        },
      ],
      has_more: false,
    });
    expect(slack.requests).toEqual([
      {
        method: "conversations.history",
        params: {
          channel: "C0123456789",
          oldest: ((NOW.getTime() - 24 * HOUR) / 1000).toFixed(6),
          limit: "10",
          inclusive: "true",
        },
        authorization: `Bearer ${ENV.SLACK_AGENTS_BOT_TOKEN}`,
      },
    ]);
    await server.call("slack-history", {
      channel: "C0123456789",
      thread_ts: "1759089600.000100",
    });
    expect(slack.requests[1]).toMatchObject({
      method: "conversations.replies",
      params: { channel: "C0123456789", ts: "1759089600.000100", limit: "50" },
    });
  });

  it("refuses unlisted channels, big pages and old ranges itself, whatever the tool asks", async () => {
    const slack = await fakeSlackApi();
    const { WebClient } = await import("@slack/web-api");
    const upstream = new SlackUpstream(
      new WebClient("xoxb-x", {
        slackApiUrl: slack.url,
        retryConfig: { retries: 0 },
      }),
      READ,
      () => NOW,
    );
    const signal = new AbortController().signal;
    const oldest = ((NOW.getTime() - HOUR) / 1000).toFixed(6);
    const ok = { channel: "C0123456789", oldest, limit: 10 };
    await expect(
      upstream.call(
        "conversations.history",
        { ...ok, channel: "C0999999999" },
        signal,
      ),
    ).rejects.toThrow("channel C0999999999 is not listed for reading");
    await expect(
      upstream.call("conversations.history", { ...ok, limit: 101 }, signal),
    ).rejects.toThrow("limit must be 1 to 100");
    await expect(
      upstream.call(
        "conversations.history",
        { ...ok, oldest: ((NOW.getTime() - 25 * HOUR) / 1000).toFixed(6) },
        signal,
      ),
    ).rejects.toThrow("oldest must be within the last 24 hours");
    await expect(
      upstream.call(
        "conversations.history",
        { ...ok, oldest: undefined },
        signal,
      ),
    ).rejects.toThrow("oldest must be within the last 24 hours");
    await expect(upstream.call("chat.postMessage", ok, signal)).rejects.toThrow(
      '"chat.postMessage" is not an allowed operation',
    );
    await expect(
      upstream.call("conversations.replies", ok, signal),
    ).rejects.toThrow("conversations.replies needs a thread ts");
    expect(slack.requests).toEqual([]);
    await upstream.call("conversations.history", ok, signal);
    expect(slack.requests).toHaveLength(1);
  });
});

describe("the Kubernetes pod lookup for the port-forward", () => {
  it("picks a running, ready OpenObserve pod through the Kubernetes API with the reader token", async () => {
    const { createServer } = await import("node:http");
    const seen: { url: string; authorization: string }[] = [];
    const pod = (
      name: string,
      phase: string,
      ready: boolean,
      deleting = false,
    ) => ({
      metadata: {
        name,
        ...(deleting ? { deletionTimestamp: "2026-09-28T19:00:00Z" } : {}),
      },
      status: {
        phase,
        conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
      },
    });
    let items = [
      pod("openobserve-pending", "Pending", false),
      pod("openobserve-terminating", "Running", true, true),
      pod("openobserve-unready", "Running", false),
      pod("openobserve-good", "Running", true),
    ];
    const api = createServer((req, res) => {
      seen.push({
        url: String(req.url),
        authorization: String(req.headers.authorization),
      });
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          apiVersion: "v1",
          kind: "PodList",
          metadata: {},
          items,
        }),
      );
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    onTestFinished(
      () => new Promise<void>((resolve) => api.close(() => resolve())),
    );
    const port = (api.address() as { port: number }).port;
    const config = stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "ss",
          cluster: {
            server: `http://127.0.0.1:${port}`,
            "insecure-skip-tls-verify": true,
          },
        },
      ],
      contexts: [{ name: "ss", context: { cluster: "ss", user: "reader" } }],
      "current-context": "ss",
      users: [{ name: "reader", user: { token: "reader-token-0123456789" } }],
    });
    const forwarder = await kubePodForwarder(config);
    expect(await forwarder.findPod()).toBe("openobserve-good");
    expect(seen[0]).toEqual({
      url: "/api/v1/namespaces/openobserve/pods?labelSelector=app%3Dopenobserve",
      authorization: "Bearer reader-token-0123456789",
    });
    items = items.slice(0, 3);
    await expect(forwarder.findPod()).rejects.toThrow(
      "no ready pod matches app=openobserve in openobserve",
    );
  });
});
