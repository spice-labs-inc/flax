import { describe, expect, it } from "vitest";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { loadTools, type ToolSpec } from "../src/lib/tools.ts";
import {
  untrustedInput,
  untrustedTools,
  untrustedToolList,
} from "../src/run-job/input-gate.ts";
import { ToolsServer } from "../src/tools-server/server.ts";

describe("tool source tags", () => {
  it("mark every shipped tool that returns text anyone can write as untrusted", () => {
    const tools = loadTools(FIXTURE_WORKSPACE);
    const by = (source: string) =>
      tools.filter((t) => t.spec?.source === source).map((t) => t.name);
    expect(tools.every((t) => t.spec !== undefined)).toBe(true);
    expect(by("untrusted")).toEqual([
      "gh-blame",
      "gh-board-items",
      "gh-grep",
      "gh-job-log",
      "gh-maintainer-notes",
      "gh-open-prs",
      "gh-path-history",
      "gh-product-epics",
      "gh-pull-requests",
      "gh-run-report",
      "gh-tree",
      "gh-workflow-runs",
      "k8s-events",
      "k8s-pod-log",
      "logs-schema",
      "logs-search",
      "slack-history",
      "traces-latest",
      "traces-search",
    ]);
    expect(by("trusted")).toEqual([
      "echo",
      "gh-commits",
      "gh-compare",
      "gh-file",
      "gh-merged-prs",
      "gh-release-file",
      "gh-releases",
      "k8s-helmreleases",
      "k8s-namespaces",
      "k8s-pods",
      "logs-streams",
      "metrics-range",
    ]);
  });

  it("travel with each call and each result the tools server records", async () => {
    const spec = (name: string, source: ToolSpec["source"]): ToolSpec => ({
      name,
      description: "Returns the text it is given, for the tests.",
      arguments: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", maxLength: 20 } },
      },
      upstream: { server: "fake", operations: ["echo"] },
      source,
      result_max_bytes: 100,
    });
    const mapping = {
      map: (args: Record<string, unknown>) => ({
        operation: "echo",
        arguments: args,
      }),
    };
    const server = new ToolsServer({
      tools: [
        { spec: spec("logs", "untrusted"), mapping },
        { spec: spec("pods", "trusted"), mapping },
      ],
      limits: { calls: 10, seconds: 5 },
      upstreams: {
        fake: { call: (_op, args) => Promise.resolve(String(args.text)) },
      },
    });
    await server.call("logs", { text: "a log line" });
    await server.call("pods", { text: "pod ok" });
    await server.call("nope", {});
    expect(server.calls.map((c) => [c.tool, c.source])).toEqual([
      ["logs", "untrusted"],
      ["pods", "trusted"],
      ["nope", undefined],
    ]);
    expect(untrustedTools(server.results)).toEqual(["logs"]);
  });

  it("add up to whether the model saw untrusted text", () => {
    expect(untrustedInput([], [])).toEqual({
      seen: false,
      model: [],
      collect: [],
    });
    const both = untrustedInput(
      ["slack-history"],
      ["gh-job-log", "slack-history"],
    );
    expect(both.seen).toBe(true);
    expect(untrustedToolList(both)).toEqual(["gh-job-log", "slack-history"]);
  });
});
