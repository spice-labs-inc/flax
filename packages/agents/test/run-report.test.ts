import { generateKeyPairSync } from "node:crypto";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { UPSTREAM_OPERATIONS } from "../src/lib/tools.ts";
import {
  GithubUpstream,
  MaintainerNotesReader,
  MAX_REPORT_ZIP_BYTES,
  RunReportReader,
} from "../src/tools-server/artifacts.ts";
import { ToolsServer } from "../src/tools-server/server.ts";
import { loadJobTools } from "../src/tools-server/start.ts";
import { startUpstreams } from "../src/tools-server/start-upstreams.ts";
import type { Upstream } from "../src/tools-server/upstreams.ts";
import {
  fakeGitHubApi,
  writeFakeMcpServer,
  zipFiles,
  type FakeArtifacts,
} from "./fake-upstreams.ts";

const NOW = new Date("2026-10-12T13:05:00Z");
const ATLAS = "notes-co/atlas";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-run-report-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A status.json and input.json as a live atlas-doc-refresh run writes them, trimmed. */
const STATUS = {
  job: "atlas-doc-refresh",
  mode: "live",
  inputSource: "collect",
  ok: true,
  budget: { month: "2026-10", spentUsd: 77.5 },
  delivery: {
    outcome: "delivered",
    branch: "agent/atlas-doc-refresh/2026-10-11",
    pages: [{ repo: ATLAS, path: "repos/widget.md", changedLines: 14 }],
    dropped: [
      {
        repo: ATLAS,
        path: "repos/engine.md",
        by: "second-check",
        problems: ["the page credits #612 to the wrong day"],
      },
    ],
    review: { verdict: "reject", reasons: 1, leftOut: 1, approved: 1 },
    pulls: [
      {
        repo: ATLAS,
        number: 12,
        url: "https://github.com/notes-co/atlas/pull/12",
        branch: "agent/atlas-doc-refresh/2026-10-11",
        autoMerge: { merged: true, sha: "a".repeat(40) },
      },
    ],
  },
};
const INPUT = {
  pages: [
    {
      repo: ATLAS,
      path: "repos/widget.md",
      commit: "b".repeat(40),
      lines: ["# widget"],
    },
    {
      repo: ATLAS,
      path: "repos/engine.md",
      commit: "b".repeat(40),
      lines: ["# engine"],
    },
  ],
  deferred: [
    {
      path: "repos/app-gitops.md",
      repo: "notes-co/app-gitops",
      from: "0e4b511",
      to: "c".repeat(40),
      reason: "the run's limit of 3 refreshes",
    },
  ],
  rules: "never edit generated content",
};
const DIGEST = {
  job: "atlas-doc-refresh",
  run_id: 9001,
  created_at: "2026-10-11T14:15:00Z",
  status: {
    ok: true,
    mode: "live",
    input_source: "collect",
    delivery: {
      outcome: "delivered",
      review_verdict: "reject",
      pages: [{ repo: ATLAS, path: "repos/widget.md" }],
      dropped: [{ repo: ATLAS, path: "repos/engine.md", by: "second-check" }],
      pulls: [
        {
          repo: ATLAS,
          number: 12,
          url: "https://github.com/notes-co/atlas/pull/12",
          auto_merged: true,
        },
      ],
    },
  },
  input: {
    pages: [
      { repo: ATLAS, path: "repos/widget.md" },
      { repo: ATLAS, path: "repos/engine.md" },
    ],
    deferred: [
      {
        repo: "notes-co/app-gitops",
        path: "repos/app-gitops.md",
        reason: "the run's limit of 3 refreshes",
      },
    ],
    waiting: false,
  },
};

function reportArtifact(
  id: number,
  runId: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: "job-atlas-doc-refresh-report",
    expired: false,
    size_in_bytes: 4000,
    created_at: "2026-10-11T14:15:00Z",
    workflow_run: { id: runId, head_branch: "main" },
    ...extra,
  };
}

const ARTIFACTS: FakeArtifacts = {
  list: [
    reportArtifact(1, 9001),
    {
      ...reportArtifact(2, 9001),
      name: "job-atlas-doc-refresh-maintainer-notes",
    },
    reportArtifact(3, 9002),
    reportArtifact(4, 9003),
    reportArtifact(5, 9004, { expired: true }),
    reportArtifact(6, 9005, { size_in_bytes: MAX_REPORT_ZIP_BYTES + 1 }),
  ],
  zips: {
    1: zipFiles({
      "status.json": JSON.stringify(STATUS),
      "input.json": JSON.stringify(INPUT),
      "answer.json": JSON.stringify({ pages: [{ patch: "secret text" }] }),
    }),
    3: zipFiles({ "status.json": "{not json" }),
    4: zipFiles({
      "status.json": JSON.stringify({ ok: false, delivery: null }),
      "input.json": JSON.stringify({
        pages: [],
        waiting: { pull: 12, url: "x", branch: "y" },
      }),
    }),
  },
};

const ARGS = {
  owner: "notes-co",
  repo: "agents",
  job: "atlas-doc-refresh",
};

async function reader(): Promise<{
  reports: RunReportReader;
  api: Awaited<ReturnType<typeof fakeGitHubApi>>;
}> {
  const api = await fakeGitHubApi({ artifacts: ARTIFACTS });
  return {
    api,
    reports: new RunReportReader({
      token: "ghs_runtoken0000000000000000000000000000",
      apiUrl: api.url,
      downloadHosts: ["127.0.0.1"],
      allowHttp: true,
      now: () => NOW,
    }),
  };
}

describe("run_report_read", () => {
  it("reads one run's report artifact down to names and counts, downloading without the token", async () => {
    const { reports, api } = await reader();
    const text = await reports.read(
      { ...ARGS, run_id: 9001 },
      AbortSignal.timeout(5000),
    );
    expect(JSON.parse(text)).toEqual(DIGEST);
    for (const leftOut of ["secret text", "# widget", "wrong day", "77.5"])
      expect(text).not.toContain(leftOut);
    expect(api.requests[0]!.path).toBe(
      "/repos/notes-co/agents/actions/runs/9001/artifacts?name=job-atlas-doc-refresh-report&per_page=10",
    );
    const blobs = api.requests.filter((r) => r.path.startsWith("/blob/"));
    expect(blobs.map((r) => r.path.split("?")[0])).toEqual(["/blob/1"]);
    for (const r of blobs) expect(r.authorization).toBe("undefined");
    for (const r of api.requests.filter((r) => r.path.startsWith("/repos/")))
      expect(r.authorization).toBe(
        "Bearer ghs_runtoken0000000000000000000000000000",
      );
  });

  it("says which file of a report could not be read, and reads a waiting run", async () => {
    const { reports } = await reader();
    const signal = AbortSignal.timeout(5000);
    expect(
      JSON.parse(await reports.read({ ...ARGS, run_id: 9002 }, signal)),
    ).toMatchObject({
      status: { unreadable: "status.json is not JSON" },
      input: { unreadable: "the report has no input.json" },
    });
    expect(
      JSON.parse(await reports.read({ ...ARGS, run_id: 9003 }, signal)),
    ).toMatchObject({
      status: { ok: false, mode: null, input_source: null, delivery: null },
      input: { pages: [], deferred: null, waiting: true },
    });
  });

  it("refuses a run with no report, an expired or oversized one, and a download to an unlisted host", async () => {
    const { reports, api } = await reader();
    const signal = AbortSignal.timeout(5000);
    await expect(
      reports.read({ ...ARGS, run_id: 9999 }, signal),
    ).rejects.toThrow("run 9999 has no job-atlas-doc-refresh-report artifact");
    await expect(
      reports.read({ ...ARGS, run_id: 9004 }, signal),
    ).rejects.toThrow(
      "the job-atlas-doc-refresh-report artifact of run 9004 has expired",
    );
    await expect(
      reports.read({ ...ARGS, run_id: 9005 }, signal),
    ).rejects.toThrow(
      `the artifact is ${MAX_REPORT_ZIP_BYTES + 1} bytes, over the ${MAX_REPORT_ZIP_BYTES} byte limit`,
    );
    const unlisted = new RunReportReader({
      token: "t",
      apiUrl: api.url,
      downloadHosts: ["productionresultssa0.blob.core.windows.net"],
      allowHttp: true,
    });
    await expect(
      unlisted.read({ ...ARGS, run_id: 9001 }, signal),
    ).rejects.toThrow(
      "GitHub sent the download to http://127.0.0.1, which is not a host in github-log-hosts.yml",
    );
  });

  it("refuses other repositories, bad names, run ids and keys, and names only the status of a failed list", async () => {
    const mcpCalls: string[] = [];
    const mcp: Upstream = {
      call: (operation) => {
        mcpCalls.push(operation);
        return Promise.resolve("from github-mcp-server");
      },
    };
    const options = {
      token: "t",
      apiUrl: "http://127.0.0.1:9",
      downloadHosts: [],
      fetch: () =>
        Promise.resolve(new Response('{"echo":"secret"}', { status: 403 })),
    };
    const github = new GithubUpstream(
      mcp,
      new MaintainerNotesReader(options),
      undefined,
      new RunReportReader(options),
    );
    const signal = AbortSignal.timeout(5000);
    const base = { ...ARGS, run_id: 9001 };
    await expect(
      github.call("run_report_read", { ...base, repo: "engine" }, signal),
    ).rejects.toThrow("run reports are read from agents only");
    await expect(
      github.call("run_report_read", { ...base, owner: "other" }, signal),
    ).rejects.toThrow("only notes-co repositories may be read");
    await expect(
      github.call("run_report_read", { ...base, job: "../x" }, signal),
    ).rejects.toThrow('"../x" is not a job name');
    await expect(
      github.call("run_report_read", { ...base, run_id: 1.5 }, signal),
    ).rejects.toThrow("run_id must be a workflow run id");
    await expect(
      github.call("run_report_read", { ...base, path: "x" }, signal),
    ).rejects.toThrow("run_report_read takes no path");
    await expect(github.call("run_report_read", base, signal)).rejects.toThrow(
      /^listing the run's artifacts returned 403$/,
    );
    await expect(
      new GithubUpstream(mcp, new MaintainerNotesReader(options)).call(
        "run_report_read",
        base,
        signal,
      ),
    ).rejects.toThrow("run_report_read is not set up");
    expect(mcpCalls).toEqual([]);
  });

  it("is served by the tools server itself in a run, through gh-run-report", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const api = await fakeGitHubApi({ artifacts: ARTIFACTS });
    const fake = writeFakeMcpServer(tempDir(), {
      tools: UPSTREAM_OPERATIONS.github!.filter(
        (op) => op !== "run_report_read",
      ),
    });
    const running = await startUpstreams({
      servers: ["github"],
      env: { AGENTS_READER_APP_ID: "1", AGENTS_READER_PRIVATE_KEY: privateKey },
      workDir: join(tempDir(), "work"),
      binDir: "/nonexistent",
      readChannels: [],
      githubApiUrl: api.url,
      githubDownloadHosts: ["127.0.0.1"],
      githubDownloadHttp: true,
      commands: {
        "github-mcp-server": { command: fake.command, args: fake.args },
      },
      now: () => NOW,
    });
    onTestFinished(() => running.close());
    const server = new ToolsServer({
      tools: await loadJobTools(FIXTURE_WORKSPACE, ["gh-run-report"]),
      limits: { calls: 10, seconds: 10 },
      upstreams: running.upstreams,
      readChannels: [],
      scrub: running.scrub,
      now: () => NOW,
    });
    const result = await server.call("gh-run-report", {
      job: "atlas-doc-refresh",
      run_id: 9001,
    });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('"run_id":9001');
    expect(text).toContain('"by":"second-check"');
    expect(fake.records().filter((r) => r.type === "call")).toEqual([]);
    const refused = await server.call("gh-run-report", {
      job: "atlas-doc-refresh",
      run_id: 9001,
      repo: "engine",
    });
    expect(refused.isError).toBe(true);
  });
});
