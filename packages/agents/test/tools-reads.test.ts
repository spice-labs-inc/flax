import { describe, expect, it } from "vitest";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { loadAllowlists } from "../src/lib/allowlists.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { UPSTREAM_OPERATIONS } from "../src/lib/tools.ts";
import {
  githubGuard,
  mergedPrQuery,
  openPrQuery,
} from "../src/tools-server/github.ts";
import { restCall, summarize } from "../src/tools-server/openobserve.ts";
import { ToolsServer } from "../src/tools-server/server.ts";
import { loadJobTools } from "../src/tools-server/start.ts";
import type { Upstream } from "../src/tools-server/upstreams.ts";

const NOW = new Date("2026-09-28T20:00:00Z");
const HOUR = 3600 * 1000;
const iso = (msBeforeNow: number) =>
  new Date(NOW.getTime() - msBeforeNow).toISOString();
const TOOLS = [
  "traces-search",
  "gh-releases",
  "gh-commits",
  "gh-open-prs",
  "logs-streams",
];

async function serve() {
  const calls: { server: string; operation: string; args: unknown }[] = [];
  const upstream = (server: string): Upstream => ({
    call(operation, args) {
      calls.push({ server, operation, args });
      return Promise.resolve("ok");
    },
  });
  const server = new ToolsServer({
    tools: await loadJobTools(FIXTURE_WORKSPACE, TOOLS),
    limits: { calls: 100, seconds: 5 },
    upstreams: Object.fromEntries(
      Object.keys(UPSTREAM_OPERATIONS).map((s) => [s, upstream(s)]),
    ),
    readChannels: loadAllowlists(FIXTURE_WORKSPACE).allowlists.readChannels,
    now: () => NOW,
  });
  return { server, calls };
}

async function callOf(tool: string, args: Record<string, unknown>) {
  const { server, calls } = await serve();
  const result = await server.call(tool, args);
  expect(result.isError).toBeUndefined();
  expect(calls).toHaveLength(1);
  return calls[0];
}

async function refusalOf(tool: string, args: Record<string, unknown>) {
  const { server, calls } = await serve();
  const result = await server.call(tool, args);
  expect(result.isError).toBe(true);
  expect(calls).toEqual([]);
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

describe("traces-search", () => {
  const range = { start: iso(2 * HOUR), end: iso(HOUR) };
  const sql = `SELECT http_status_code, COUNT(*) AS n FROM "prod" GROUP BY http_status_code`;

  it("sends one time-bounded SELECT over trace streams, at most 100 rows", async () => {
    expect(await callOf("traces-search", { sql, ...range, limit: 10 })).toEqual(
      {
        server: "openobserve",
        operation: "SearchTracesSQL",
        args: {
          sql,
          start_time: (NOW.getTime() - 2 * HOUR) * 1000,
          end_time: (NOW.getTime() - HOUR) * 1000,
          size: 10,
        },
      },
    );
    expect(
      await refusalOf("traces-search", { sql: "DELETE FROM x", ...range }),
    ).toBe("sql must be a SELECT statement");
    expect(
      await refusalOf("traces-search", { sql: "SELECT 1; SELECT 2", ...range }),
    ).toBe("sql must be one statement, with no semicolon");
    expect(
      await refusalOf("traces-search", {
        sql,
        start: iso(26 * HOUR),
        end: range.end,
      }),
    ).toBe("the time range may be at most 24 hours long");
    expect(
      await refusalOf("traces-search", { sql, ...range, limit: 101 }),
    ).toBe("the arguments do not match traces-search: limit: must be <= 100");
  });

  it("asks OpenObserve for traces, with the same limits the log search has", () => {
    const args = { sql: "SELECT 1", start_time: 1, end_time: 2, size: 5 };
    expect(restCall("SearchTracesSQL", args)).toEqual({
      method: "POST",
      path: "/api/default/_search",
      query: { type: "traces" },
      body: {
        query: {
          sql: "SELECT 1",
          start_time: 1,
          end_time: 2,
          from: 0,
          size: 5,
        },
      },
    });
    expect(restCall("SearchSQL", args).query).toEqual({ type: "logs" });
    expect(() => restCall("SearchTracesSQL", { ...args, size: 101 })).toThrow(
      "size must be an integer from 1 to 100",
    );
    expect(() =>
      restCall("SearchTracesSQL", { ...args, type: "logs" }),
    ).toThrow('"type" is not an argument OpenObserve calls take here');
    expect(() =>
      restCall("SearchTracesSQL", { ...args, end_time: 25 * HOUR * 1000 + 2 }),
    ).toThrow("the time range must be positive and at most 24 hours");
    expect(
      summarize(
        "SearchTracesSQL",
        { total: 3, took: 4, hits: [{ n: 1 }, { n: 2 }], scan_size: 9 },
        { size: 1 },
      ),
    ).toEqual({ total: 3, took_ms: 4, hits: [{ n: 1 }] });
  });
});

describe("gh-releases", () => {
  it("lists recent releases without notes, or reads the latest", async () => {
    expect(await callOf("gh-releases", { repo: "engine" })).toEqual({
      server: "github",
      operation: "list_releases",
      args: {
        owner: "notes-co",
        repo: "engine",
        perPage: 5,
        page: 1,
        fields: [
          "tag_name",
          "name",
          "html_url",
          "published_at",
          "prerelease",
          "draft",
        ],
      },
    });
    expect(
      await callOf("gh-releases", { repo: "engine", latest: true }),
    ).toEqual({
      server: "github",
      operation: "get_latest_release",
      args: { owner: "notes-co", repo: "engine" },
    });
    expect(
      await refusalOf("gh-releases", {
        repo: "engine",
        latest: true,
        per_page: 3,
      }),
    ).toBe("per_page lists releases, so cannot be used with latest");
    expect(
      await refusalOf("gh-releases", { repo: "engine", per_page: 21 }),
    ).toBe("the arguments do not match gh-releases: per_page: must be <= 20");
  });
});

describe("gh-commits", () => {
  it("lists commits on main only, at most 50", async () => {
    expect(
      await callOf("gh-commits", { repo: "backend", per_page: 50 }),
    ).toEqual({
      server: "github",
      operation: "list_commits",
      args: {
        owner: "notes-co",
        repo: "backend",
        sha: "main",
        perPage: 50,
        page: 1,
        fields: ["sha", "html_url", "commit"],
      },
    });
    expect(
      await refusalOf("gh-commits", { repo: "backend", per_page: 51 }),
    ).toBe("the arguments do not match gh-commits: per_page: must be <= 50");
    expect(await refusalOf("gh-commits", { repo: "backend", sha: "dev" })).toBe(
      "the arguments do not match gh-commits: sha: is not an allowed key",
    );
  });
});

describe("gh-open-prs", () => {
  it("runs only the fixed organization search, optionally for one author", async () => {
    const fields = [
      "number",
      "title",
      "draft",
      "html_url",
      "user",
      "created_at",
      "repository_url",
    ];
    expect(await callOf("gh-open-prs", {})).toEqual({
      server: "github",
      operation: "search_pull_requests",
      args: {
        owner: "notes-co",
        query: "org:notes-co is:pr is:open",
        sort: "created",
        order: "desc",
        perPage: 30,
        page: 1,
        fields,
      },
    });
    expect(
      (
        (await callOf("gh-open-prs", { author: "octocat" }))!.args as {
          query: string;
        }
      ).query,
    ).toBe("org:notes-co is:pr is:open author:octocat");
    expect(await refusalOf("gh-open-prs", { query: "is:pr" })).toBe(
      "the arguments do not match gh-open-prs: query: is not an allowed key",
    );
    expect(await refusalOf("gh-open-prs", { author: "x repo:other/y" })).toBe(
      'the arguments do not match gh-open-prs: author: "x repo:other/y" must match ^[A-Za-z0-9-]+$',
    );
  });
});

describe("the GitHub upstream's guard on the new reads", () => {
  const ok = { owner: "notes-co" };

  it("allows only the fixed pull request search", () => {
    expect(() =>
      githubGuard("search_pull_requests", { ...ok, query: openPrQuery() }),
    ).not.toThrow();
    expect(() =>
      githubGuard("search_pull_requests", {
        ...ok,
        query: `${openPrQuery()} author:octocat`,
      }),
    ).not.toThrow();
    for (const query of [
      "org:other is:pr is:open",
      `${openPrQuery()} repo:other/x`,
      `${openPrQuery()} author:a author:b`,
      "is:pr is:open",
    ])
      expect(() =>
        githubGuard("search_pull_requests", { ...ok, query }),
      ).toThrow(
        'search_pull_requests may only search "org:notes-co is:pr is:open", optionally with one author, or "org:notes-co is:pr is:merged merged:>=<day>"',
      );
    expect(() =>
      githubGuard("search_pull_requests", {
        ...ok,
        query: mergedPrQuery("2026-09-21"),
      }),
    ).not.toThrow();
    for (const query of [
      `${mergedPrQuery("2026-09-21")} repo:other/x`,
      "org:other is:pr is:merged merged:>=2026-09-21",
      "org:notes-co is:pr is:merged merged:>=2026-09-21..2026-09-22",
      "org:notes-co is:pr is:merged",
    ])
      expect(() =>
        githubGuard("search_pull_requests", { ...ok, query }),
      ).toThrow("search_pull_requests may only search");
    expect(() =>
      githubGuard("search_pull_requests", {
        ...ok,
        query: openPrQuery(),
        repo: "x",
      }),
    ).toThrow(
      "search_pull_requests searches the organization, not one repository",
    );
    expect(() =>
      githubGuard("search_pull_requests", {
        owner: "other",
        query: openPrQuery(),
      }),
    ).toThrow("only notes-co repositories may be read");
  });

  it("allows commits of main only, at most 50, with no other filter", () => {
    const commits = { ...ok, repo: "x", sha: "main", perPage: 50 };
    expect(() => githubGuard("list_commits", commits)).not.toThrow();
    expect(() =>
      githubGuard("list_commits", { ...commits, sha: "dev" }),
    ).toThrow("list_commits reads main only");
    expect(() =>
      githubGuard("list_commits", { ...commits, perPage: 51 }),
    ).toThrow("list_commits returns 1 to 50 commits");
    expect(() =>
      githubGuard("list_commits", { ...commits, path: "src" }),
    ).toThrow("list_commits takes no path");
  });

  it("reads files of main, a release tag vX.Y.Z or a commit by its full sha only", () => {
    const file = { ...ok, repo: "x", path: "a.md", ref: "refs/heads/main" };
    expect(() => githubGuard("get_file_contents", file)).not.toThrow();
    expect(() =>
      githubGuard("get_file_contents", { ...file, ref: "refs/tags/v1.8.5" }),
    ).not.toThrow();
    for (const ref of [
      "refs/heads/dev",
      "refs/tags/v1.8",
      "refs/tags/1.8.5",
      "refs/tags/v1.8.5-rc.1",
      "refs/tags/v1.8.5/../x",
      "refs/heads/v1.8.5",
      "v1.8.5",
    ])
      expect(() => githubGuard("get_file_contents", { ...file, ref })).toThrow(
        "get_file_contents reads main, a release tag vX.Y.Z or a commit by its full sha only",
      );
    expect(() =>
      githubGuard("get_file_contents", { ...ok, repo: "x", path: "a.md" }),
    ).toThrow(
      "get_file_contents reads main, a release tag vX.Y.Z or a commit by its full sha only",
    );
    const atCommit = { ...ok, repo: "x", path: "a.md", sha: "e".repeat(40) };
    expect(() => githubGuard("get_file_contents", atCommit)).not.toThrow();
    for (const sha of ["abc1234", "E".repeat(40), "main", 7])
      expect(() =>
        githubGuard("get_file_contents", { ...atCommit, sha }),
      ).toThrow("get_file_contents sha must be a full commit sha");
    expect(() =>
      githubGuard("get_file_contents", { ...file, sha: "e".repeat(40) }),
    ).toThrow("get_file_contents takes a sha or a ref, not both");
    expect(() =>
      githubGuard("get_file_contents", { ...file, owner: "other" }),
    ).toThrow("only notes-co repositories may be read");
  });

  it("reads Status of project 3 only, filtered by a day, statuses or both", () => {
    const items = {
      ...ok,
      method: "list_project_items",
      owner_type: "org",
      project_number: 3,
      field_names: ["Status"],
      query: 'updated:>=2026-09-21 status:"Ready","In progress"',
      perPage: 50,
    };
    expect(() => githubGuard("projects_list", items)).not.toThrow();
    for (const query of ["updated:>=2026-09-21", 'status:"In review"'])
      expect(() =>
        githubGuard("projects_list", { ...items, query, after: "Y3Vy" }),
      ).not.toThrow();
    for (const [change, message] of [
      [
        { method: "list_projects" },
        'projects_list method "list_projects" is not allowed',
      ],
      [{ method: "list_project_fields" }, "is not allowed"],
      [
        { project_number: 16 },
        "projects_list reads the notes-co project 3 only",
      ],
      [
        { owner_type: "user" },
        "projects_list reads the notes-co project 3 only",
      ],
      [{ owner: "other" }, "only notes-co repositories may be read"],
      [
        { field_names: ["Status", "Assignees"] },
        "projects_list reads the Status field only",
      ],
      [{ field_names: undefined }, "projects_list reads the Status field only"],
      [{ fields: ["1"] }, "projects_list takes no fields"],
      [{ before: "x" }, "projects_list takes no before"],
      [{ perPage: 51 }, "projects_list returns 1 to 50 items a page"],
      [{ query: "" }, "projects_list may only filter by"],
      [{ query: "is:open" }, "projects_list may only filter by"],
      [{ query: 'status:"Shipped"' }, "projects_list may only filter by"],
      [
        { query: "updated:>=2026-09-21 assignee:someone" },
        "projects_list may only filter by",
      ],
      [
        { query: 'status:"Ready" updated:>=2026-09-21' },
        "projects_list may only filter by",
      ],
    ] as [Record<string, unknown>, string][])
      expect(() =>
        githubGuard("projects_list", { ...items, ...change }),
      ).toThrow(message);
  });

  it("reads issues of notes-co/product only, with fixed fields, and one issue with get only", () => {
    const list = {
      ...ok,
      repo: "product",
      fields: [
        "number",
        "title",
        "state",
        "labels",
        "created_at",
        "updated_at",
      ],
      perPage: 100,
      since: "2026-09-21T00:00:00Z",
    };
    expect(() => githubGuard("list_issues", list)).not.toThrow();
    for (const [change, message] of [
      [{ repo: "engine" }, "issues are read from product only"],
      [
        { fields: ["number", "title", "body"] },
        "list_issues returns only number, title, state, labels, created_at, updated_at",
      ],
      [{ fields: undefined }, "list_issues returns only"],
      [{ labels: ["x"] }, "list_issues takes no labels"],
      [{ field_filters: [] }, "list_issues takes no field_filters"],
      [{ perPage: 101 }, "list_issues returns 1 to 100 issues a page"],
      [
        { since: "2026-09-21T13:00:00Z" },
        "list_issues since must be the start of a UTC day",
      ],
    ] as [Record<string, unknown>, string][])
      expect(() => githubGuard("list_issues", { ...list, ...change })).toThrow(
        message,
      );
    const one = { ...ok, repo: "product", method: "get", issue_number: 1 };
    expect(() => githubGuard("issue_read", one)).not.toThrow();
    expect(() =>
      githubGuard("issue_read", { ...one, method: "get_comments" }),
    ).toThrow('issue_read method "get_comments" is not allowed');
    expect(() => githubGuard("issue_read", { ...one, repo: "engine" })).toThrow(
      "issues are read from product only",
    );
  });

  it("reads releases of the organization only", () => {
    expect(() =>
      githubGuard("list_releases", { ...ok, repo: "x" }),
    ).not.toThrow();
    expect(() =>
      githubGuard("get_latest_release", { owner: "other", repo: "x" }),
    ).toThrow("only notes-co repositories may be read");
  });
});

describe("logs-streams asking about fields", () => {
  it("asks OpenObserve for schemas only when fields are named, and passes on only which of them each stream has", async () => {
    expect(
      await callOf("logs-streams", { keyword: "prod:", has_fields: ["level"] }),
    ).toEqual({
      server: "openobserve",
      operation: "StreamList",
      args: { keyword: "prod:", fields: ["level"] },
    });
    expect(await refusalOf("logs-streams", { has_fields: [] })).toBe(
      "the arguments do not match logs-streams: has_fields: must NOT have fewer than 1 items",
    );
    expect(restCall("StreamList", { keyword: "prod:" }).query).toEqual({
      type: "logs",
      keyword: "prod:",
    });
    expect(
      restCall("StreamList", { fields: ["level", "error"] }).query,
    ).toEqual({
      type: "logs",
      fetchSchema: "true",
    });
    expect(() => restCall("StreamList", { fields: ["level; drop"] })).toThrow(
      "fields must be 1 to 10 field names of letters, digits and underscores",
    );
    const answer = {
      total: 2,
      list: [
        {
          name: "prod:apps:servicea",
          stream_type: "logs",
          stats: {
            doc_num: 5,
            storage_size: 1,
            doc_time_max: 1790709324961948,
          },
          schema: [
            { name: "_timestamp", type: "Int64" },
            { name: "body", type: "Utf8" },
            { name: "severity", type: "Int64" },
          ],
        },
        {
          name: "prod:apps:backend",
          stream_type: "logs",
          stats: { doc_num: 9, storage_size: 2 },
          schema: [
            { name: "level", type: "Utf8" },
            { name: "message", type: "Utf8" },
          ],
        },
      ],
    };
    expect(
      summarize("StreamList", answer, { fields: ["level", "body"] }),
    ).toEqual({
      total: 2,
      streams: [
        {
          name: "prod:apps:servicea",
          stream_type: "logs",
          doc_num: 5,
          storage_size: 1,
          doc_time_max: 1790709324961948,
          has_fields: ["body"],
        },
        {
          name: "prod:apps:backend",
          stream_type: "logs",
          doc_num: 9,
          storage_size: 2,
          has_fields: ["level"],
        },
      ],
    });
    // Without fields named, no schema is asked for or passed on.
    expect(
      (summarize("StreamList", answer, {}) as { streams: object[] }).streams[1],
    ).toEqual({
      name: "prod:apps:backend",
      stream_type: "logs",
      doc_num: 9,
      storage_size: 2,
    });
  });
});
