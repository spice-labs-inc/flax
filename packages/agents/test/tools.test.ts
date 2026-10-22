import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { allowlistsCheck } from "../src/check/allowlists.ts";
import { jobSchemaCheck } from "../src/check/job-schema.ts";
import { toolsCheck } from "../src/check/tools.ts";
import {
  DEFAULT_TOOL_CALLS,
  DEFAULT_TOOL_SECONDS,
  toolLimits,
  type JobConfig,
  type ModelJobConfig,
} from "../src/lib/job.ts";
import { TOOL_SCHEMA } from "../src/lib/schemas.ts";
import {
  argumentProblems,
  MAX_ARGUMENT_ITEMS,
  MAX_ARGUMENT_STRING,
  UPSTREAM_OPERATIONS,
} from "../src/lib/tools.ts";
import {
  jobConfig,
  jobFiles,
  makeRepo,
  run,
  TOOL,
  TOOL_MAP,
  toolSpec,
} from "./helpers.ts";

const FILE = "tools/demo/tool.yml";

function repoWithTool(files: Record<string, string>): string {
  const root = makeRepo({ tools: [] });
  mkdirSync(join(root, "tools/demo"), { recursive: true });
  for (const [file, content] of Object.entries(files))
    writeFileSync(join(root, "tools/demo", file), content);
  return root;
}

async function problemsFor(
  overrides: Record<string, unknown>,
): Promise<string[]> {
  return run(
    toolsCheck,
    repoWithTool({
      "tool.yml": stringify(toolSpec("demo", overrides)),
      "map.ts": TOOL_MAP,
    }),
  );
}

function argumentsWith(text: unknown): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: { text },
  };
}

describe("tool.yml", () => {
  it("accepts a valid tool", async () => {
    expect(await problemsFor({})).toEqual([]);
  });

  it("rejects unknown keys, missing fields and a name that is not the folder's", async () => {
    expect(await problemsFor({ url: "https://example.com" })).toEqual([
      `${FILE}: url: is not an allowed key`,
    ]);
    expect(await problemsFor({ name: "other" })).toEqual([
      `${FILE}: name: "other" must equal the folder name "demo"`,
    ]);
    const root = repoWithTool({
      "tool.yml": "name: demo\n",
      "map.ts": TOOL_MAP,
    });
    expect(await run(toolsCheck, root)).toEqual([
      `${FILE}: description: is required`,
      `${FILE}: arguments: is required`,
      `${FILE}: upstream: is required`,
      `${FILE}: source: is required`,
      `${FILE}: result_max_bytes: is required`,
    ]);
  });

  it("caps the result size and names only known upstream operations", async () => {
    expect(await problemsFor({ result_max_bytes: 200000 })).toEqual([
      `${FILE}: result_max_bytes: must be <= 131072`,
    ]);
    expect(
      await problemsFor({
        upstream: { server: "builtin", operations: ["echo", "shell"] },
      }),
    ).toEqual([
      `${FILE}: upstream.operations[1]: "shell" is not an operation of builtin (known: echo)`,
    ]);
    expect(
      await problemsFor({ upstream: { server: "github", operations: ["x"] } }),
    ).toEqual([
      `${FILE}: upstream.operations[0]: "x" is not an operation of github (known: actions_list, get_job_logs, list_pull_requests, pull_request_read, search_pull_requests, list_releases, get_latest_release, list_commits, get_file_contents, projects_list, list_issues, issue_read, maintainer_notes_list, compare_commits, run_report_read, commit_grep, path_history, commit_blame, commit_tree)`,
    ]);
    expect(
      await problemsFor({ upstream: { server: "shell", operations: ["x"] } }),
    ).toEqual([
      `${FILE}: upstream.server: must be one of builtin, kubernetes, github, openobserve, slack`,
    ]);
  });

  it("offers in tool.schema.json exactly the upstreams UPSTREAM_OPERATIONS names", () => {
    const schema = TOOL_SCHEMA as {
      properties: {
        upstream: { properties: { server: { enum: string[] } } };
      };
    };
    expect(schema.properties.upstream.properties.server.enum).toEqual(
      Object.keys(UPSTREAM_OPERATIONS),
    );
  });

  it("offers OpenObserve's six read operations only", () => {
    expect(UPSTREAM_OPERATIONS.openobserve).toEqual([
      "StreamList",
      "StreamSchema",
      "SearchSQL",
      "SearchTracesSQL",
      "PrometheusRangeQuery",
      "GetLatestTraces",
    ]);
  });

  it("needs a limit on every argument", async () => {
    expect(
      await problemsFor({ arguments: argumentsWith({ type: "string" }) }),
    ).toEqual([
      `${FILE}: arguments.properties.text: a string needs maxLength of at most ${MAX_ARGUMENT_STRING}`,
    ]);
    expect(
      await problemsFor({
        arguments: { type: "object", properties: {} },
      }),
    ).toEqual([
      `${FILE}: arguments: an object needs additionalProperties: false`,
    ]);
    expect(await problemsFor({ arguments: { type: "string" } })).toEqual([
      `${FILE}: arguments: must have type: object`,
    ]);
    expect(
      await problemsFor({
        arguments: argumentsWith({ type: "strng", maxLength: 3 }),
      }),
    ).toEqual([
      `${FILE}: arguments.properties.text: needs a type of string, integer, number, boolean, array or object`,
      `${FILE}: arguments: is not a valid JSON Schema: schema is invalid: data/properties/text/type must be equal to one of the allowed values, data/properties/text/type must be array, data/properties/text/type must match a schema in anyOf`,
    ]);
  });

  it("refuses a folder with other files, links or a missing map.ts", async () => {
    const tool = stringify(toolSpec("demo"));
    expect(
      await run(
        toolsCheck,
        repoWithTool({ "tool.yml": tool, "map.ts": TOOL_MAP, "run.sh": "" }),
      ),
    ).toEqual([
      "tools/demo/run.sh: is not allowed in a tool folder (allowed: tool.yml, map.ts)",
    ]);
    expect(await run(toolsCheck, repoWithTool({ "tool.yml": tool }))).toEqual([
      "tools/demo/map.ts: is missing",
    ]);
    const root = repoWithTool({ "map.ts": TOOL_MAP });
    symlinkSync("/etc/hostname", join(root, "tools/demo/tool.yml"));
    expect(await run(toolsCheck, root)).toEqual([
      "tools/demo/tool.yml: must not be a symlink",
    ]);
  });

  it("refuses a map.ts that does not load or exports no mapping", async () => {
    const tool = stringify(toolSpec("demo"));
    expect(
      await run(
        toolsCheck,
        repoWithTool({ "tool.yml": tool, "map.ts": "export default 3;\n" }),
      ),
    ).toEqual([
      "tools/demo/map.ts: must export default { map(args, context) { ... } }, with result(text, args) optional",
    ]);
    const broken = await run(
      toolsCheck,
      repoWithTool({ "tool.yml": tool, "map.ts": "throw new Error('no');\n" }),
    );
    expect(broken).toEqual(["tools/demo/map.ts: cannot be loaded: no"]);
  });
});

describe("argument limits", () => {
  it("accepts every kind of bounded value", () => {
    expect(
      argumentProblems({
        type: "object",
        additionalProperties: false,
        properties: {
          s: { type: "string", maxLength: MAX_ARGUMENT_STRING },
          e: { type: "string", enum: ["a", "b"] },
          i: { type: "integer", minimum: 0, maximum: 10 },
          n: { type: "number", minimum: 0, maximum: 1 },
          b: { type: "boolean" },
          a: {
            type: "array",
            maxItems: MAX_ARGUMENT_ITEMS,
            items: { type: "string", maxLength: 5 },
          },
          o: {
            type: "object",
            additionalProperties: false,
            properties: { x: { type: "integer", const: 1 } },
          },
        },
      }),
    ).toEqual([]);
  });

  it("refuses unbounded numbers and arrays, and composed schemas", () => {
    expect(
      argumentProblems(
        argumentsWith({
          type: "array",
          maxItems: MAX_ARGUMENT_ITEMS + 1,
          items: { type: "integer", minimum: 0 },
        }),
      ),
    ).toEqual([
      {
        field: "arguments.properties.text",
        message: `an array needs maxItems of at most ${MAX_ARGUMENT_ITEMS}`,
      },
      {
        field: "arguments.properties.text.items",
        message: "an integer needs minimum and maximum",
      },
    ]);
    expect(
      argumentProblems(argumentsWith({ anyOf: [{ type: "string" }] })),
    ).toEqual([
      {
        field: "arguments.properties.text",
        message:
          "uses anyOf; argument schemas use plain types so their limits can be checked",
      },
    ]);
  });

  it("accepts a string limit exactly when it is at most the cap", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 * MAX_ARGUMENT_STRING }), (n) => {
        const problems = argumentProblems(
          argumentsWith({ type: "string", maxLength: n }),
        );
        expect(problems.length === 0).toBe(n <= MAX_ARGUMENT_STRING);
      }),
    );
  });
});

describe("jobs and tools", () => {
  it("rejects a job naming a tool whose folder is not valid", async () => {
    const root = makeRepo({
      jobs: { demo: jobFiles("demo", { tools: [TOOL, "demo"] }) },
    });
    mkdirSync(join(root, "tools/demo"));
    writeFileSync(join(root, "tools/demo/tool.yml"), "name: demo\n");
    expect(await run(allowlistsCheck, root)).toEqual([
      `jobs/demo/job.yml: tools[1]: "demo" is not a valid tool; fix the problems reported for tools/demo/`,
    ]);
  });

  it("takes tool limits from job.yml, with defaults", async () => {
    const job = jobConfig("demo") as unknown as ModelJobConfig;
    expect(toolLimits(job)).toEqual({
      calls: DEFAULT_TOOL_CALLS,
      seconds: DEFAULT_TOOL_SECONDS,
    });
    expect(
      toolLimits({
        ...job,
        limits: { ...job.limits, tool_calls: 5, tool_seconds: 9 },
      }),
    ).toEqual({ calls: 5, seconds: 9 });
    expect(DEFAULT_TOOL_CALLS).toBe(200);
    expect(DEFAULT_TOOL_SECONDS).toBe(60);
  });

  it("caps tool limits in the schema", async () => {
    const limits = { turns: 1, tokens_per_run: 1, usd_per_month: 1 };
    const problems = async (extra: Record<string, unknown>) =>
      run(
        jobSchemaCheck,
        makeRepo({
          jobs: { demo: jobFiles("demo", { limits: { ...limits, ...extra } }) },
        }),
      );
    expect(await problems({ tool_calls: 1000, tool_seconds: 300 })).toEqual([]);
    expect(await problems({ tool_calls: 1001, tool_seconds: 0 })).toEqual([
      "jobs/demo/job.yml: limits.tool_calls: must be <= 1000",
      "jobs/demo/job.yml: limits.tool_seconds: must be >= 1",
    ]);
  });
});
