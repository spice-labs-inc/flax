import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  GithubUpstream,
  MaintainerNotesReader,
} from "../src/tools-server/artifacts.ts";
import {
  globToRegExp,
  grepPatternProblem,
  grepTarball,
} from "../src/tools-server/code-grep.ts";
import { CodeReader } from "../src/tools-server/code-reader.ts";
import {
  branchProblem,
  githubGuard,
  isPlainPath,
} from "../src/tools-server/github.ts";
import { tarFiles } from "../src/tools-server/tar.ts";
import type { Upstream } from "../src/tools-server/upstreams.ts";
import { tarArchive, type TarEntry } from "./fake-tarball.ts";

const SHA = "c".repeat(40);
const OWNER = "notes-co";
const API = "https://api.github.com";
const scratch = mkdtempSync(join(tmpdir(), "agents-code-reads-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
const tempDir = () => {
  const dir = join(scratch, String(dirs++));
  return dir;
};

const LONG_DIR = `src/${"deep/".repeat(25)}x`;

const tar = (entries: TarEntry[]) => tarArchive(entries);

const FILES: TarEntry[] = [
  { dir: "src" },
  {
    path: "src/store.rs",
    data: 'fn open() {\r\n    error!("failed to open the store: {}", e);\n}\n',
  },
  { path: "src/lib.rs", data: "// nothing here\nFailed TO OPEN twice\n" },
  { path: "README.md", data: "failed to open (docs)\n" },
  { path: "assets/logo.png", data: Buffer.from([0x89, 0, 1, 2, 0x0a]) },
  { path: "big.txt", data: "failed to open\n".repeat(80_000) },
  { path: `${LONG_DIR}/far.rs`, data: "failed to open far away\n" },
  { link: "src/link.rs" },
];

function tarball(entries: TarEntry[] = FILES): Buffer {
  return gzipSync(tar(entries));
}

async function* chunks(data: Buffer, size: number) {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

const LIMITS = { maxBytes: 64 * 1024 * 1024, maxEntries: 1000 };

describe("the tar reader", () => {
  it("reads regular files without GitHub's top directory, long pax paths included, skipping the rest", async () => {
    const seen: { path: string; size: number; data?: string }[] = [];
    for await (const f of tarFiles(
      chunks(tar(FILES), 777),
      (path) => path.endsWith(".rs"),
      LIMITS,
    ))
      seen.push({
        path: f.path,
        size: f.size,
        ...(f.data === undefined ? {} : { data: f.data.toString("utf8") }),
      });
    expect(seen.map((s) => s.path)).toEqual([
      "src/store.rs",
      "src/lib.rs",
      "README.md",
      "assets/logo.png",
      "big.txt",
      `${LONG_DIR}/far.rs`,
    ]);
    expect(seen[1]).toEqual({
      path: "src/lib.rs",
      size: 37,
      data: "// nothing here\nFailed TO OPEN twice\n",
    });
    expect(seen[2]!.data).toBeUndefined();
    expect(seen[5]!.data).toBe("failed to open far away\n");
  });

  it("stops at its limits and refuses what is not tar", async () => {
    const all = async (data: Buffer, limits = LIMITS) => {
      for await (const _ of tarFiles(chunks(data, 4096), () => true, limits));
    };
    await expect(
      all(tar(FILES), { maxBytes: 10_000, maxEntries: 1000 }),
    ).rejects.toThrow("the archive unpacks to more than 10000 bytes");
    await expect(
      all(tar(FILES), { maxBytes: 64 * 1024 * 1024, maxEntries: 3 }),
    ).rejects.toThrow("the archive holds more than 3 entries");
    await expect(all(Buffer.alloc(600, 7))).rejects.toThrow(
      "the archive is not tar",
    );
    await expect(all(tar(FILES).subarray(0, 3000))).rejects.toThrow(
      "the archive ends inside an entry",
    );
  });
});

describe("grep patterns", () => {
  it("accepts ordinary patterns", () => {
    for (const p of [
      "failed to open",
      'error!\\("[^"]+"',
      "\\bStoreError::\\w+",
      "(foo)+bar",
      "(?:ab){2,3}",
      "x{1,5}y*",
      "\\p{L}+ thing",
      "(a+)?b",
      "a|b",
    ])
      expect(grepPatternProblem(p), p).toBeUndefined();
  });

  it("refuses back references, lookarounds, repeated groups that repeat, empty matches and bad syntax", () => {
    expect(grepPatternProblem("(a)\\1")).toBe(
      "the pattern may not use back references",
    );
    expect(grepPatternProblem("(?<n>a)\\k<n>")).toBe(
      "the pattern may not use back references",
    );
    for (const p of ["a(?=b)", "a(?!b)", "(?<=a)b", "(?<!a)b"])
      expect(grepPatternProblem(p)).toBe("the pattern may not use lookarounds");
    for (const p of [
      "(a+)+b",
      "(a*)*b",
      "(a|aa)*b",
      "((ab)*c)+",
      "(?:x+y)+",
      "(\\w+\\s?)*$",
      "(a+){2,}",
      "(a|b){1,50}",
    ])
      expect(grepPatternProblem(p), p).toMatch(
        /repeats a group that itself repeats/,
      );
    expect(grepPatternProblem("x*")).toBe("the pattern matches every line");
    expect(grepPatternProblem("a((b")).toMatch(
      /^the pattern is not a valid regular expression/,
    );
    expect(grepPatternProblem("")).toBe(
      "the pattern must be 1 to 200 characters",
    );
    expect(grepPatternProblem("x".repeat(201))).toBe(
      "the pattern must be 1 to 200 characters",
    );
  });

  it("turns a path filter into a match on the path, or on the file name when it has no /", () => {
    const g = (glob: string, path: string) => globToRegExp(glob).test(path);
    expect(g("*.rs", "src/a/b.rs")).toBe(true);
    expect(g("*.rs", "src/a/b.rsx")).toBe(false);
    expect(g("src/*.rs", "src/b.rs")).toBe(true);
    expect(g("src/*.rs", "src/a/b.rs")).toBe(false);
    expect(g("src/**/*.rs", "src/b.rs")).toBe(true);
    expect(g("src/**/*.rs", "src/a/b/c.rs")).toBe(true);
    expect(g("src/**", "src/a/b")).toBe(true);
    expect(g("src/[id].ts", "src/[id].ts")).toBe(true);
    expect(g("src/?.rs", "src/a.rs")).toBe(true);
    expect(g("src/?.rs", "src/ab.rs")).toBe(false);
  });
});

describe("grepTarball", () => {
  const file = join(scratch, "engine.tar.gz");
  writeFileSync(file, tarball());
  const options = {
    pattern: "failed to open",
    fixedString: false,
    ignoreCase: false,
    glob: undefined,
    maxMatches: 100,
    signal: AbortSignal.timeout(30_000),
  };

  it("finds lines in text files, skipping binary files and files over 1 MiB", async () => {
    const out = await grepTarball(file, options);
    expect(out).toEqual({
      matches: [
        {
          path: "src/store.rs",
          line: 2,
          text: '    error!("failed to open the store: {}", e);',
        },
        { path: "README.md", line: 1, text: "failed to open (docs)" },
        {
          path: `${LONG_DIR}/far.rs`,
          line: 1,
          text: "failed to open far away",
        },
      ],
      files_matched: 3,
      files_searched: 4,
      binary_skipped: 1,
      large_skipped: 1,
    });
  });

  it("filters paths, ignores case, matches plain text and stops at max_matches", async () => {
    const rs = await grepTarball(file, {
      ...options,
      glob: "src/*.rs",
      ignoreCase: true,
    });
    expect(rs.matches.map((m) => `${m.path}:${m.line}`)).toEqual([
      "src/store.rs:2",
      "src/lib.rs:2",
    ]);
    expect(rs.files_searched).toBe(2);
    const fixed = await grepTarball(file, {
      ...options,
      pattern: "open (docs)",
      fixedString: true,
    });
    expect(fixed.matches.map((m) => m.path)).toEqual(["README.md"]);
    const one = await grepTarball(file, { ...options, maxMatches: 1 });
    expect(one.matches).toHaveLength(1);
    expect(one.stopped).toBe("matches");
  });

  it("cuts long lines around the match and stops at the result's size", async () => {
    const longFile = join(scratch, "long.tar.gz");
    writeFileSync(
      longFile,
      tarball([
        {
          path: "min.js",
          data: `${"x".repeat(5000)}NEEDLE${"y".repeat(5000)}\n`,
        },
        { path: "many.txt", data: "NEEDLE here\n".repeat(150) },
      ]),
    );
    const out = await grepTarball(longFile, {
      ...options,
      pattern: "NEEDLE",
      maxMatches: 200,
      maxResultBytes: 1000,
    });
    expect(out.matches[0]!.text).toBe(
      `...${"x".repeat(40)}NEEDLE${"y".repeat(194)}...`,
    );
    expect(out.stopped).toBe("bytes");
    expect(
      out.matches.reduce(
        (n, m) => n + `${m.path}:${m.line}:${m.text}`.length + 1,
        0,
      ),
    ).toBeLessThanOrEqual(1000);
  });

  it("stops a pattern that runs too long, in its own thread", async () => {
    const slow = join(scratch, "slow.tar.gz");
    writeFileSync(
      slow,
      tarball([{ path: "a.txt", data: `${"a".repeat(40)}!\n` }]),
    );
    const started = Date.now();
    await expect(
      grepTarball(slow, { ...options, pattern: "^(a+)+$", batchMs: 300 }),
    ).rejects.toThrow(/ran for more than 0.3 seconds .* and was stopped/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

// ---- a fake GitHub for the reader ----

interface Seen {
  method: string;
  url: string;
  authorization?: string;
  body?: string;
}

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fakeGithub(routes: Record<string, Route | Response[]>) {
  const seen: Seen[] = [];
  const used = new WeakSet<Response>();
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    seen.push({
      method: init.method ?? "GET",
      url: url.href,
      ...(headers.authorization === undefined
        ? {}
        : { authorization: headers.authorization }),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    });
    const key = `${init.method ?? "GET"} ${url.origin}${url.pathname}`;
    const route = routes[key];
    if (route === undefined) return new Response("{}", { status: 404 });
    if (Array.isArray(route)) {
      if (route.length > 1) return route.shift()!;
      const last = route[0]!;
      if (used.has(last)) return last.clone();
      used.add(last);
      return last;
    }
    return route(url, init);
  };
  return { fn: fn as typeof fetch, seen };
}

const TARBALL_URL = `${API}/repos/${OWNER}/engine/tarball/${SHA}`;
const CODELOAD = `https://codeload.github.com/${OWNER}/engine/legacy.tar.gz/${SHA}`;

function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

function reader(
  f: { fn: typeof fetch },
  extra: Partial<ConstructorParameters<typeof CodeReader>[0]> = {},
) {
  const slept: number[] = [];
  const r = new CodeReader({
    token: "ghs_run",
    cacheDir: tempDir(),
    fetch: f.fn,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    ...extra,
  });
  return { r, slept };
}

const GREP = {
  owner: OWNER,
  repo: "engine",
  sha: SHA,
  pattern: "failed to open",
  fixed_string: false,
  ignore_case: false,
  max_matches: 100,
};
const signal = () => AbortSignal.timeout(30_000);

describe("commit_grep", () => {
  it("downloads the commit's tarball once, from codeload without the token, and searches it on the runner", async () => {
    const f = fakeGithub({
      [`GET ${TARBALL_URL}`]: [redirect(`${CODELOAD}?token=SIGNED`)],
      [`GET ${CODELOAD}`]: [new Response(tarball())],
    });
    const { r } = reader(f);
    const out = await r.grep(GREP, signal());
    expect(out.split("\n")).toEqual([
      `notes-co/engine at ${SHA}: 3 matching lines in 3 files (4 text files searched; skipped 1 binary and 1 over 1 MiB). Each line: path:line:text.`,
      'src/store.rs:2:    error!("failed to open the store: {}", e);',
      "README.md:1:failed to open (docs)",
      `${LONG_DIR}/far.rs:1:failed to open far away`,
    ]);
    expect(f.seen).toEqual([
      { method: "GET", url: TARBALL_URL, authorization: "Bearer ghs_run" },
      { method: "GET", url: `${CODELOAD}?token=SIGNED` },
    ]);
    const again = await r.grep(
      { ...GREP, pattern: "nothing", path_glob: "*.md" },
      signal(),
    );
    expect(again).toBe(
      `notes-co/engine at ${SHA} in paths *.md: 0 matching lines in 0 files (1 text files searched). Each line: path:line:text.`,
    );
    expect(f.seen).toHaveLength(2);
  });

  it("shares one download between calls for the same commit and keeps at most eight tarballs", async () => {
    let downloads = 0;
    const f = fakeGithub({
      [`GET ${API}/repos/${OWNER}/engine/tarball/${SHA}`]: () =>
        redirect(CODELOAD),
      [`GET ${CODELOAD}`]: () => {
        downloads += 1;
        return new Response(tarball());
      },
    });
    const { r } = reader(f);
    await Promise.all([r.grep(GREP, signal()), r.grep(GREP, signal())]);
    expect(downloads).toBe(1);
  });

  it("tries a 5xx or a dropped connection again, and names only the status of a refusal", async () => {
    const f = fakeGithub({
      [`GET ${TARBALL_URL}`]: [
        new Response("{}", { status: 502 }),
        redirect(CODELOAD),
      ],
      [`GET ${CODELOAD}`]: [
        new Response("{}", { status: 503, headers: { "retry-after": "1" } }),
        new Response(tarball()),
      ],
    });
    const { r, slept } = reader(f);
    expect(await r.grep(GREP, signal())).toContain("3 matching lines");
    expect(slept).toEqual([2000, 1000]);
    const refused = fakeGithub({
      [`GET ${TARBALL_URL}`]: [
        new Response('{"message":"echo of secret"}', { status: 404 }),
      ],
    });
    const { r: r2, slept: none } = reader(refused);
    await expect(r2.grep(GREP, signal())).rejects.toThrow(
      /^downloading the commit's tarball returned 404$/,
    );
    expect(none).toEqual([]);
    expect(refused.seen).toHaveLength(1);
  });

  it("follows a renamed repository within the API, and refuses a tarball sent anywhere but codeload", async () => {
    const moved = `${API}/repositories/7/tarball/${SHA}`;
    const f = fakeGithub({
      [`GET ${TARBALL_URL}`]: [redirect(moved, 301)],
      [`GET ${moved}`]: [redirect(CODELOAD)],
      [`GET ${CODELOAD}`]: [new Response(tarball())],
    });
    expect(await reader(f).r.grep(GREP, signal())).toContain(
      "3 matching lines",
    );
    expect(f.seen.map((s) => s.authorization)).toEqual([
      "Bearer ghs_run",
      "Bearer ghs_run",
      undefined,
    ]);
    for (const where of [
      "https://elsewhere.example/x.tar.gz",
      "http://codeload.github.com/x.tar.gz",
    ]) {
      const away = fakeGithub({ [`GET ${TARBALL_URL}`]: [redirect(where)] });
      await expect(reader(away).r.grep(GREP, signal())).rejects.toThrow(
        /which is not codeload\.github\.com$/,
      );
      expect(away.seen).toHaveLength(1);
    }
  });

  it("removes a broken download, so the next call fetches it again", async () => {
    const dir = tempDir();
    const f = fakeGithub({
      [`GET ${TARBALL_URL}`]: [redirect(CODELOAD)],
      [`GET ${CODELOAD}`]: [
        new Response(tarball().subarray(0, 50)),
        new Response(tarball()),
      ],
    });
    const { r } = reader(f, { cacheDir: dir });
    await expect(r.grep(GREP, signal())).rejects.toThrow();
    expect(await r.grep(GREP, signal())).toContain("3 matching lines");
    expect(readdirSync(dir)).toEqual([`engine-${SHA}.tar.gz`]);
  });
});

function graphqlRoute(data: unknown, seen: unknown[] = []): Route {
  return (_url, init) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ data }));
  };
}

const commitNode = (i: number, prs: unknown[]) => ({
  oid: String(i).repeat(40),
  committedDate: `2026-10-0${i}T00:00:00Z`,
  messageHeadline: `Change ${i}`,
  author: { user: i === 1 ? { login: "dani" } : null },
  associatedPullRequests: { nodes: prs },
});

describe("path_history", () => {
  const ARGS = {
    owner: OWNER,
    repo: "engine",
    path: "src/store.rs",
    ref: "main",
    count: 20,
  };

  it("makes one fixed GraphQL query and returns each commit with its pull request", async () => {
    const bodies: { query: string; variables: Record<string, unknown> }[] = [];
    const f = fakeGithub({
      [`POST ${API}/graphql`]: graphqlRoute(
        {
          repository: {
            object: {
              history: {
                pageInfo: { hasNextPage: true },
                nodes: [
                  commitNode(1, [
                    { number: 9, state: "OPEN" },
                    { number: 12, state: "MERGED" },
                  ]),
                  commitNode(2, []),
                ],
              },
            },
          },
        },
        bodies,
      ),
    });
    const out = JSON.parse(await reader(f).r.pathHistory(ARGS, signal()));
    expect(out).toEqual({
      repo: "engine",
      ref: "main",
      path: "src/store.rs",
      commits: [
        {
          sha: "1".repeat(40),
          date: "2026-10-01T00:00:00Z",
          author: "dani",
          headline: "Change 1",
          pr: 12,
        },
        {
          sha: "2".repeat(40),
          date: "2026-10-02T00:00:00Z",
          headline: "Change 2",
        },
      ],
      more: true,
    });
    expect(bodies[0]!.variables).toEqual({
      owner: OWNER,
      name: "engine",
      ref: "refs/heads/main",
      path: "src/store.rs",
      count: 20,
    });
    expect(bodies[0]!.query).toMatch(/^query\(/);
    expect(bodies[0]!.query).not.toMatch(/mutation/);
    expect(f.seen[0]!.authorization).toBe("Bearer ghs_run");
    await reader(f).r.pathHistory({ ...ARGS, ref: SHA }, signal());
    expect(bodies[1]!.variables.ref).toBe(SHA);
  });

  it("names a missing ref or repository, and GitHub's GraphQL error", async () => {
    const missing = fakeGithub({
      [`POST ${API}/graphql`]: graphqlRoute({ repository: { object: null } }),
    });
    await expect(reader(missing).r.pathHistory(ARGS, signal())).rejects.toThrow(
      "main was not found in notes-co/engine",
    );
    const failed = fakeGithub({
      [`POST ${API}/graphql`]: [
        new Response(
          JSON.stringify({
            errors: [{ type: "NOT_FOUND", message: "Could not resolve" }],
          }),
        ),
      ],
    });
    await expect(reader(failed).r.pathHistory(ARGS, signal())).rejects.toThrow(
      "reading the path's history: GitHub answered NOT_FOUND: Could not resolve",
    );
    const flaky = fakeGithub({
      [`POST ${API}/graphql`]: [
        new Response("", { status: 502 }),
        new Response(
          JSON.stringify({
            data: {
              repository: {
                object: { history: { nodes: [], pageInfo: {} } },
              },
            },
          }),
        ),
      ],
    });
    const { r, slept } = reader(flaky);
    expect(JSON.parse(await r.pathHistory(ARGS, signal())).commits).toEqual([]);
    expect(slept).toEqual([2000]);
  });
});

describe("commit_blame", () => {
  const ARGS = {
    owner: OWNER,
    repo: "engine",
    sha: SHA,
    path: "src/store.rs",
    start_line: 2,
    line_count: 3,
  };
  const ranges = [
    {
      startingLine: 1,
      endingLine: 2,
      commit: commitNode(1, [{ number: 5, state: "MERGED" }]),
    },
    { startingLine: 3, endingLine: 3, commit: commitNode(2, []) },
    {
      startingLine: 4,
      endingLine: 6,
      commit: commitNode(1, [{ number: 5, state: "MERGED" }]),
    },
  ];

  it("returns the asked lines with their text, commit and pull request, from one GraphQL query", async () => {
    const bodies: { variables: Record<string, unknown> }[] = [];
    const f = fakeGithub({
      [`POST ${API}/graphql`]: graphqlRoute(
        {
          repository: {
            file: {
              text: "a\nb\r\nc\nd\ne\nf\n",
              isBinary: false,
              isTruncated: false,
            },
            commit: { blame: { ranges } },
          },
        },
        bodies,
      ),
    });
    const out = JSON.parse(await reader(f).r.blame(ARGS, signal()));
    expect(out).toEqual({
      repo: "engine",
      sha: SHA,
      path: "src/store.rs",
      lines: "2-4 of 6",
      commits: {
        ["1".repeat(40)]: {
          date: "2026-10-01T00:00:00Z",
          headline: "Change 1",
          pr: 5,
        },
        ["2".repeat(40)]: {
          date: "2026-10-02T00:00:00Z",
          headline: "Change 2",
        },
      },
      blame: [
        { line: 2, commit: "1".repeat(40), text: "b" },
        { line: 3, commit: "2".repeat(40), text: "c" },
        { line: 4, commit: "1".repeat(40), text: "d" },
      ],
    });
    expect(bodies[0]!.variables).toEqual({
      owner: OWNER,
      name: "engine",
      oid: SHA,
      path: "src/store.rs",
      file: `${SHA}:src/store.rs`,
    });
  });

  it("refuses a binary file and names a missing file", async () => {
    const binary = fakeGithub({
      [`POST ${API}/graphql`]: graphqlRoute({
        repository: { file: { isBinary: true }, commit: { blame: { ranges } } },
      }),
    });
    await expect(reader(binary).r.blame(ARGS, signal())).rejects.toThrow(
      "src/store.rs is a binary file",
    );
    const missing = fakeGithub({
      [`POST ${API}/graphql`]: graphqlRoute({
        repository: { file: null, commit: { blame: { ranges: [] } } },
      }),
    });
    await expect(reader(missing).r.blame(ARGS, signal())).rejects.toThrow(
      `src/store.rs is not a file at ${SHA}`,
    );
  });
});

describe("commit_tree", () => {
  const ARGS = { owner: OWNER, repo: "engine", sha: SHA, max_paths: 1000 };
  const TREE = `${API}/repos/${OWNER}/engine/git/trees/${SHA}`;
  const tree = (truncated = false) =>
    new Response(
      JSON.stringify({
        sha: SHA,
        truncated,
        tree: [
          { path: "README.md", type: "blob", size: 10 },
          { path: "src", type: "tree" },
          { path: "src/a.rs", type: "blob", size: 20 },
          { path: "src/b.rs", type: "blob", size: 30 },
          { path: "srcx/c.rs", type: "blob", size: 40 },
          { path: "vendor/lib", type: "commit" },
        ],
      }),
    );

  it("lists files and submodules with sizes from one recursive tree GET", async () => {
    const f = fakeGithub({ [`GET ${TREE}`]: [tree()] });
    expect(await reader(f).r.tree(ARGS, signal())).toBe(
      [
        `notes-co/engine at ${SHA}: 5 files. Each line: size in bytes, a tab, the path.`,
        "10\tREADME.md",
        "20\tsrc/a.rs",
        "30\tsrc/b.rs",
        "40\tsrcx/c.rs",
        "submodule\tvendor/lib",
      ].join("\n"),
    );
    expect(f.seen).toEqual([
      {
        method: "GET",
        url: `${TREE}?recursive=1`,
        authorization: "Bearer ghs_run",
      },
    ]);
  });

  it("keeps a prefix's files, stops at max_paths and says when GitHub cut the tree", async () => {
    const f = fakeGithub({ [`GET ${TREE}`]: [tree(true)] });
    expect(
      await reader(f).r.tree(
        { ...ARGS, prefix: "src", max_paths: 1 },
        signal(),
      ),
    ).toBe(
      [
        `notes-co/engine at ${SHA} under src/: 2 files; the first 1 shown (max_paths); GitHub cut the tree short, so some files are missing: list a prefix. Each line: size in bytes, a tab, the path.`,
        "20\tsrc/a.rs",
      ].join("\n"),
    );
  });
});

describe("the code reads' guard and routing", () => {
  it("checks every argument again before a request leaves the runner", () => {
    const ok = [
      ["commit_grep", GREP],
      [
        "path_history",
        { owner: OWNER, repo: "engine", path: "src", ref: "dev/x", count: 50 },
      ],
      [
        "commit_blame",
        {
          owner: OWNER,
          repo: "engine",
          sha: SHA,
          path: "a",
          start_line: 1,
          line_count: 200,
        },
      ],
      [
        "commit_tree",
        { owner: OWNER, repo: "engine", sha: SHA, max_paths: 5000 },
      ],
    ] as const;
    for (const [op, args] of ok)
      expect(() => githubGuard(op, args)).not.toThrow();
    const refused: [string, Record<string, unknown>, string][] = [
      [
        "commit_grep",
        { ...GREP, owner: "other" },
        "only notes-co repositories may be read",
      ],
      [
        "commit_grep",
        { ...GREP, sha: "abc1234" },
        "commit_grep sha must be a full commit sha",
      ],
      [
        "commit_grep",
        { ...GREP, pattern: "(a+)+" },
        "commit_grep: the pattern repeats a group",
      ],
      [
        "commit_grep",
        { ...GREP, max_matches: 201 },
        "commit_grep max_matches must be 1 to 200",
      ],
      [
        "commit_grep",
        { ...GREP, path_glob: "a b" },
        "commit_grep path_glob is not a path filter",
      ],
      ["commit_grep", { ...GREP, repo: "../x/y" }, "is not a repository name"],
      [
        "path_history",
        {
          owner: OWNER,
          repo: "engine",
          path: "src",
          ref: "HEAD@{1}",
          count: 5,
        },
        'path_history: "HEAD@{1}" is not a branch name',
      ],
      [
        "path_history",
        { owner: OWNER, repo: "engine", path: "/etc", ref: "main", count: 5 },
        "path_history path must be a plain relative path",
      ],
      [
        "path_history",
        { owner: OWNER, repo: "engine", path: "src", ref: "main", count: 51 },
        "path_history count must be 1 to 50",
      ],
      [
        "commit_blame",
        {
          owner: OWNER,
          repo: "engine",
          sha: SHA,
          path: "a",
          start_line: 1,
          line_count: 201,
        },
        "commit_blame line_count must be 1 to 200",
      ],
      [
        "commit_tree",
        {
          owner: OWNER,
          repo: "engine",
          sha: SHA,
          prefix: "../x",
          max_paths: 5,
        },
        "commit_tree prefix must be a plain relative path",
      ],
    ];
    for (const [op, args, message] of refused)
      expect(() => githubGuard(op, args), message).toThrow(message);
  });

  it("is served by the tools server itself, never github-mcp-server, and refuses extra arguments", async () => {
    const mcpCalls: string[] = [];
    const mcp: Upstream = {
      call(operation) {
        mcpCalls.push(operation);
        return Promise.resolve("mcp");
      },
    };
    const f = fakeGithub({
      [`GET ${API}/repos/${OWNER}/engine/git/trees/${SHA}`]: [
        new Response(JSON.stringify({ tree: [] })),
      ],
    });
    const notes = new MaintainerNotesReader({ token: "t", downloadHosts: [] });
    const github = new GithubUpstream(
      mcp,
      notes,
      undefined,
      undefined,
      reader(f).r,
    );
    const args = { owner: OWNER, repo: "engine", sha: SHA, max_paths: 5 };
    expect(await github.call("commit_tree", args, signal())).toContain(
      "0 files",
    );
    await expect(
      github.call("commit_tree", { ...args, recursive: 0 }, signal()),
    ).rejects.toThrow("commit_tree takes no recursive");
    await expect(
      github.call("commit_tree", { ...args, owner: "other" }, signal()),
    ).rejects.toThrow("only notes-co repositories may be read");
    expect(mcpCalls).toEqual([]);
    expect(f.seen).toHaveLength(1);
    await expect(
      new GithubUpstream(mcp, notes).call("commit_tree", args, signal()),
    ).rejects.toThrow("commit_tree is not set up");
  });

  it("knows a plain path and a branch name", () => {
    expect(isPlainPath("src/a.rs")).toBe(true);
    for (const p of ["", "/a", "a/", "a//b", "./a", "a/../b", "x".repeat(401)])
      expect(isPlainPath(p), p).toBe(false);
    for (const b of ["main", "release/1.2", "octocat/crash-tools"])
      expect(branchProblem(b), b).toBeUndefined();
    for (const b of [
      "-x",
      "a..b",
      "a/",
      "/a",
      "a.lock",
      "a b",
      "a@{1}",
      "a.",
      "a//b",
    ])
      expect(branchProblem(b), b).toBe(`"${b}" is not a branch name`);
  });
});
