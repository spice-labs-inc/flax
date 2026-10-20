import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  envOfTitle,
  parseArtifacts,
  parseRunning,
  toDownload,
} from "../server/poller.ts";
import { runDirName, writeArtifactRun } from "../server/store.ts";

describe("the GitHub artifact fallback", () => {
  it("lists the artifacts of one name with the workflow run that uploaded each", () => {
    const body = {
      artifacts: [
        {
          id: 1,
          name: "checks-prod",
          expired: false,
          created_at: "2026-10-15T01:00:00Z",
          workflow_run: { id: 10 },
        },
        {
          id: 2,
          name: "checks-staging",
          expired: false,
          created_at: "2026-10-15T01:00:00Z",
          workflow_run: { id: 11 },
        },
        {
          id: 3,
          name: "checks-prod",
          expired: true,
          created_at: "2026-10-14T01:00:00Z",
          workflow_run: { id: 9 },
        },
        { id: 4, name: "checks-prod" },
      ],
    };
    expect(
      parseArtifacts(body, "checks-prod").map((a) => [
        a.id,
        a.runId,
        a.expired,
      ]),
    ).toEqual([
      [1, 10, false],
      [3, 9, true],
    ]);
    expect(() => parseArtifacts({}, "checks-prod")).toThrow(/no list/);
  });

  it("downloads the newest runs not here yet, one artifact per run, never an expired one", () => {
    const at = (h: number) => `2026-10-15T${String(h).padStart(2, "0")}:00:00Z`;
    const artifacts = [
      { id: 1, runId: 10, expired: false, createdAt: at(1) },
      { id: 2, runId: 10, expired: false, createdAt: at(2) },
      { id: 3, runId: 11, expired: false, createdAt: at(3) },
      { id: 4, runId: 12, expired: true, createdAt: at(4) },
      { id: 5, runId: 13, expired: false, createdAt: at(5) },
    ];
    expect(
      toDownload(artifacts, new Set([11]), new Set([5])).map((a) => a.id),
    ).toEqual([2]);
  });

  it("reads the env a running workflow names in its title and keeps the rest", () => {
    expect(envOfTitle("Scenario checks (staging)")).toBe("staging");
    expect(envOfTitle("Scenario checks")).toBeUndefined();
    const runs = parseRunning(
      {
        workflow_runs: [
          {
            id: 7,
            event: "schedule",
            created_at: "2026-10-15T01:00:00Z",
            display_title: "checks prod",
          },
          {
            id: 8,
            event: "workflow_dispatch",
            run_started_at: "2026-10-15T02:00:00Z",
            html_url: "https://example.com/8",
          },
          { id: "nine", event: "schedule" },
        ],
      },
      "acme/acme-scenarios",
    );
    expect(runs).toEqual([
      {
        id: 7,
        event: "schedule",
        startedAt: "2026-10-15T01:00:00Z",
        url: "https://github.com/acme/acme-scenarios/actions/runs/7",
        env: "prod",
      },
      {
        id: 8,
        event: "workflow_dispatch",
        startedAt: "2026-10-15T02:00:00Z",
        url: "https://example.com/8",
      },
    ]);
  });
});

describe("where a downloaded run goes", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("names the directory by run.json's run id, or workflow-<id> with the failure when only index.json came", () => {
    expect(
      runDirName("prod", {
        run: JSON.stringify({
          env: "prod",
          runId: "prod-2026-10-15T01-00-00-000Z",
        }),
      }),
    ).toEqual({
      name: "prod-2026-10-15T01-00-00-000Z",
    });
    expect(() =>
      runDirName("prod", {
        run: JSON.stringify({ env: "staging", runId: "x" }),
      }),
    ).toThrow(/run on staging/);
    const index = JSON.stringify({
      version: 1,
      job: "checks",
      env: "prod",
      shadow: false,
      run: {
        id: "10-1",
        at: "2026-10-15T01:00:00Z",
        failure: "the runner never started",
      },
      builds: {},
      counts: { passed: 0, failed: 0, skipped: 0 },
      checks: {},
    });
    expect(runDirName("prod", { index })).toEqual({
      name: "workflow-10-1",
      failure: "the runner never started",
    });
    expect(() => runDirName("prod", {})).toThrow(/neither/);
  });

  it("skips a run that left no results and keeps one that did, once", () => {
    dir = mkdtempSync(join(tmpdir(), "explorer-store-"));
    const files = new Map([
      [
        "run.json",
        Buffer.from(
          JSON.stringify({
            env: "prod",
            runId: "prod-2026-10-15T01-00-00-000Z",
            scenarios: [],
          }),
        ),
      ],
    ]);
    expect(writeArtifactRun(dir, "prod", files, { id: 1, runId: 10 })).toEqual({
      kept: "prod-2026-10-15T01-00-00-000Z",
    });
    expect(
      writeArtifactRun(dir, "prod", files, { id: 2, runId: 10 }),
    ).toMatchObject({ skipped: expect.stringMatching(/already here/) });
    const only = new Map([
      [
        "index.json",
        Buffer.from(
          JSON.stringify({
            version: 1,
            job: "checks",
            env: "prod",
            shadow: false,
            run: {
              id: "11-1",
              at: "2026-10-15T02:00:00Z",
              failure: "no browser",
            },
            builds: {},
            counts: { passed: 0, failed: 0, skipped: 0 },
            checks: {},
          }),
        ),
      ],
    ]);
    expect(writeArtifactRun(dir, "prod", only, { id: 3, runId: 11 })).toEqual({
      skipped: "its scenario run left no results: no browser",
    });
  });
});
