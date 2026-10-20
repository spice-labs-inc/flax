import { describe, expect, it } from "vitest";
import {
  GithubUpstream,
  MaintainerNotesReader,
} from "../src/tools-server/artifacts.ts";
import {
  compactComparison,
  CompareReader,
  cutPatch,
  GITHUB_COMPARE_FILES,
} from "../src/tools-server/compare.ts";
import { githubGuard } from "../src/tools-server/github.ts";
import {
  fileLineRange,
  slimDirectory,
} from "../src/tools-server/map-helpers.ts";
import type { Upstream } from "../src/tools-server/upstreams.ts";

const BASE = "0a0a0a0";
const HEAD = "1".repeat(40);
const ARGS = {
  owner: "notes-co",
  repo: "engine",
  base: BASE,
  head: HEAD,
  patch_lines: 2,
};

function rawCompare(files = 2, commits = 2) {
  return {
    status: "ahead",
    ahead_by: commits,
    behind_by: 0,
    total_commits: commits,
    url: "https://api.github.com/repos/notes-co/engine/compare/x",
    commits: Array.from({ length: commits }, (_, i) => ({
      sha: String(i).repeat(40).slice(0, 40),
      commit: {
        message: `Change ${i} (#${i})\n\nThe long body.`,
        author: { date: "2026-09-01T00:00:00Z", email: "someone@example.com" },
        committer: { date: `2026-09-0${(i % 9) + 1}T00:00:00Z` },
      },
      author:
        i === 1
          ? { login: "renovate[bot]", type: "Bot" }
          : { login: "someone", type: "User" },
    })),
    files: Array.from({ length: files }, (_, i) => ({
      filename: `src/file_${i}.rs`,
      status: i === 1 ? "renamed" : "modified",
      additions: 3,
      deletions: 1,
      changes: 4,
      blob_url: "https://github.com/x",
      ...(i === 1 ? { previous_filename: "src/old.rs" } : {}),
      patch: "@@ -1,1 +1,3 @@\n-a\n+b\n+c\n+d",
    })),
  };
}

function fakeFetch(
  status: number,
  body: unknown,
  url = `https://api.github.com/repos/notes-co/engine/compare/${BASE}...${HEAD}`,
) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    const res = new Response(JSON.stringify(body), { status });
    Object.defineProperty(res, "url", { value: url });
    return Promise.resolve(res);
  };
  return { fn: fn as typeof fetch, requests };
}

describe("compare_commits", () => {
  it("makes one GET of the compare path with the run's token and returns commits and files, diffs cut to patch_lines", async () => {
    const f = fakeFetch(200, rawCompare());
    const reader = new CompareReader({ token: "ghs_run", fetch: f.fn });
    const out = JSON.parse(
      await reader.compare(ARGS, AbortSignal.timeout(1000)),
    ) as Record<string, unknown>;
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.url).toBe(
      `https://api.github.com/repos/notes-co/engine/compare/${BASE}...${HEAD}`,
    );
    expect(f.requests[0]!.init.method ?? "GET").toBe("GET");
    expect(
      (f.requests[0]!.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer ghs_run");
    expect(out).toEqual({
      repo: "engine",
      base: BASE,
      head: HEAD,
      status: "ahead",
      ahead_by: 2,
      behind_by: 0,
      total_commits: 2,
      commits: [
        {
          sha: "0".repeat(40),
          date: "2026-09-01T00:00:00Z",
          subject: "Change 0 (#0)",
          author: "someone",
        },
        {
          sha: "1".repeat(40),
          date: "2026-09-02T00:00:00Z",
          subject: "Change 1 (#1)",
        },
      ],
      commits_left_out: 0,
      files: [
        {
          path: "src/file_0.rs",
          status: "modified",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,1 +1,3 @@\n-a",
          patch_cut: true,
        },
        {
          path: "src/file_1.rs",
          status: "renamed",
          additions: 3,
          deletions: 1,
          previous_path: "src/old.rs",
          patch: "@@ -1,1 +1,3 @@\n-a",
          patch_cut: true,
        },
      ],
      files_may_be_more: false,
      patches_left_out: 0,
    });
  });

  it("names only the status of a failed comparison, and refuses a redirect away from the API", async () => {
    const failed = fakeFetch(404, { message: "secret-looking echo" });
    await expect(
      new CompareReader({ token: "t", fetch: failed.fn }).compare(
        ARGS,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow(/^comparing the commits returned 404$/);
    const away = fakeFetch(200, rawCompare(), "https://elsewhere.example/x");
    await expect(
      new CompareReader({ token: "t", fetch: away.fn }).compare(
        ARGS,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("the comparison was redirected away from the GitHub API");
  });

  it("refuses branch names, other arguments and out-of-range diff lengths before any request", async () => {
    const f = fakeFetch(200, rawCompare());
    const reader = new CompareReader({ token: "t", fetch: f.fn });
    const signal = AbortSignal.timeout(1000);
    await expect(
      reader.compare({ ...ARGS, base: "main" }, signal),
    ).rejects.toThrow("base must be a commit sha");
    await expect(
      reader.compare({ ...ARGS, path: "x" }, signal),
    ).rejects.toThrow("compare_commits takes no path");
    await expect(
      reader.compare({ ...ARGS, patch_lines: 401 }, signal),
    ).rejects.toThrow("patch_lines must be 0 to 400");
    expect(f.requests).toEqual([]);
  });

  it("fits any comparison in its budget: the newest commits, then fewer files, and diffs only while they fit", () => {
    const big = compactComparison(
      rawCompare(40, 250),
      "engine",
      BASE,
      HEAD,
      400,
      8000,
    );
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(8000);
    expect(big.commits.at(-1)!.sha).toBe("249".repeat(14).slice(0, 40));
    expect(big.commits_left_out).toBe(250 - big.commits.length);
    expect(big.files.length).toBeGreaterThan(0);
    const withPatches = compactComparison(
      rawCompare(40, 1),
      "engine",
      BASE,
      HEAD,
      400,
      5000,
    );
    expect(withPatches.files).toHaveLength(40);
    const patched = withPatches.files.filter(
      (f) => f.patch !== undefined,
    ).length;
    expect(patched).toBeGreaterThan(0);
    expect(withPatches.patches_left_out).toBe(40 - patched);
    expect(Buffer.byteLength(JSON.stringify(withPatches))).toBeLessThanOrEqual(
      5000,
    );
    expect(
      compactComparison(
        rawCompare(GITHUB_COMPARE_FILES, 1),
        "engine",
        BASE,
        HEAD,
        0,
      ).files_may_be_more,
    ).toBe(true);
  });

  it("cuts a diff to its first lines", () => {
    expect(cutPatch("a\nb\nc", 2)).toEqual({ patch: "a\nb", cut: true });
    expect(cutPatch("a\nb", 2)).toEqual({ patch: "a\nb", cut: false });
  });

  it("is guarded like every GitHub read, and served by the tools server itself", async () => {
    expect(() =>
      githubGuard("compare_commits", { ...ARGS, owner: "other" }),
    ).toThrow("only notes-co repositories may be read");
    expect(() =>
      githubGuard("compare_commits", { ...ARGS, head: "HEAD~1" }),
    ).toThrow("compare_commits head must be a commit sha");
    expect(() =>
      githubGuard("compare_commits", { ...ARGS, patch_lines: -1 }),
    ).toThrow("compare_commits patch_lines must be 0 to 400");
    const mcpCalls: string[] = [];
    const mcp: Upstream = {
      call(operation) {
        mcpCalls.push(operation);
        return Promise.resolve("mcp");
      },
    };
    const f = fakeFetch(200, rawCompare());
    const notes = new MaintainerNotesReader({ token: "t", downloadHosts: [] });
    const github = new GithubUpstream(
      mcp,
      notes,
      new CompareReader({ token: "t", fetch: f.fn }),
    );
    const signal = AbortSignal.timeout(1000);
    expect(
      JSON.parse(await github.call("compare_commits", ARGS, signal)),
    ).toMatchObject({
      repo: "engine",
    });
    await expect(
      github.call("compare_commits", { ...ARGS, owner: "other" }, signal),
    ).rejects.toThrow("only notes-co repositories may be read");
    expect(f.requests).toHaveLength(1);
    expect(mcpCalls).toEqual([]);
    await expect(
      new GithubUpstream(mcp, notes).call("compare_commits", ARGS, signal),
    ).rejects.toThrow("compare_commits is not set up");
  });
});

describe("fileLineRange", () => {
  const head = `successfully downloaded text file (SHA: ${"c".repeat(40)})`;

  it("keeps the head line and returns the asked lines of a file with or without a final newline", () => {
    expect(fileLineRange(`${head}\na\nb\nc\n`, 2, 5)).toBe(
      `${head}; lines 2-3 of 3\nb\nc\n`,
    );
    expect(fileLineRange(`${head}\na\nb\nc`, 1, 1)).toBe(
      `${head}; lines 1-1 of 3\na\n`,
    );
    expect(fileLineRange(`${head}\n`, 1, 1)).toBe(`${head}; lines none of 0\n`);
  });

  it("changes nothing without a range or without a file head", () => {
    expect(fileLineRange(`${head}\na\n`, undefined, undefined)).toBe(
      `${head}\na\n`,
    );
    expect(fileLineRange("[]", 1, 1)).toBe("[]");
  });
});

describe("slimDirectory", () => {
  it("keeps each entry's name, path, type, size and sha, so a big directory fits the cap", () => {
    const entry = (i: number) => ({
      type: "file",
      size: 1000 + i,
      name: `doc${i}.md`,
      path: `repos/doc${i}.md`,
      sha: "a".repeat(40),
      url: `https://api.github.com/repos/o/r/contents/repos/doc${i}.md?ref=main`,
      html_url: `https://github.com/o/r/blob/main/repos/doc${i}.md`,
      git_url: `https://api.github.com/repos/o/r/git/blobs/${"a".repeat(40)}`,
      download_url: `https://raw.githubusercontent.com/o/r/main/repos/doc${i}.md`,
      _links: { self: "x", git: "y", html: "z" },
    });
    const listing = JSON.stringify(
      Array.from({ length: 200 }, (_, i) => entry(i)),
    );
    expect(listing.length).toBeGreaterThan(65536);
    const slim = slimDirectory(listing);
    expect(slim.length).toBeLessThan(65536);
    expect(JSON.parse(slim)[3]).toEqual({
      name: "doc3.md",
      path: "repos/doc3.md",
      type: "file",
      size: 1003,
      sha: "a".repeat(40),
    });
  });

  it("returns a file, an error or other JSON as it is", () => {
    const file = `successfully downloaded text file (SHA: ${"c".repeat(40)})\n[]\n`;
    expect(slimDirectory(file)).toBe(file);
    expect(slimDirectory("not json")).toBe("not json");
    expect(slimDirectory('{"a":1}')).toBe('{"a":1}');
    expect(slimDirectory('[{"a":1}]')).toBe('[{"a":1}]');
  });
});
