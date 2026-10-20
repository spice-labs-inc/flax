import { existsSync, readFileSync } from "node:fs";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { githubHostsCheck } from "../src/check/github-hosts.ts";
import {
  GITHUB_META_URL,
  githubHostsProblems,
  loadGithubHosts,
} from "../src/lib/github-hosts.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import {
  fetchGithubHosts,
  LOG_HOST_PATTERNS,
  logHostsFromMeta,
  MAX_META_BYTES,
} from "../src/tools-server/fetch-github-hosts.ts";
import { makeRepo, run } from "./helpers.ts";

const FILE = "github-log-hosts.yml";
const HOST_PATTERN =
  "^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$";

function hostsFile(overrides: Record<string, unknown> = {}): string {
  return stringify({
    fetched: "2026-09-29",
    source: GITHUB_META_URL,
    hosts: [
      "api.github.com",
      "productionresultssa0.blob.core.windows.net",
      "pipelinesghubeus1.actions.githubusercontent.com",
    ],
    ...overrides,
  });
}

/** A meta answer shaped like api.github.com/meta, trimmed to what matters. */
function meta(full: unknown, wildcard: string[] = []): unknown {
  return {
    verifiable_password_authentication: false,
    domains: {
      actions: ["*.actions.githubusercontent.com"],
      actions_inbound: { full_domains: full, wildcard_domains: wildcard },
    },
  };
}

const PUBLISHED = [
  "api.github.com",
  "github.com",
  "results-receiver.actions.githubusercontent.com",
  "pipelinesghubeus2.actions.githubusercontent.com",
  "pipelinesproxweu1.actions.githubusercontent.com",
  "productionresultssa19.blob.core.windows.net",
  "productionresultssa0.blob.core.windows.net",
  "productionresultssa3.blob.core.windows.net",
  "objects.githubusercontent.com",
  "runnerghubeus1.actions.githubusercontent.com",
];

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("github-log-hosts.yml", () => {
  it("accepts this repository's file: exact hosts, api.github.com, the log storage hosts", async () => {
    expect(await run(githubHostsCheck, makeRepo())).toEqual([]);
    const { hosts } = loadGithubHosts(FIXTURE_WORKSPACE);
    expect(hosts?.source).toBe(GITHUB_META_URL);
    expect(hosts?.hosts).toContain("api.github.com");
    expect(
      hosts?.hosts.filter((h) => LOG_HOST_PATTERNS[0]!.test(h)).length,
    ).toBeGreaterThan(0);
    for (const host of hosts?.hosts ?? []) expect(host).not.toContain("*");
  });

  it("is required", async () => {
    expect(
      await run(githubHostsCheck, makeRepo({ githubHosts: null })),
    ).toEqual([`${FILE}: is missing`]);
  });

  it("refuses a file that is not YAML", async () => {
    expect(
      await run(githubHostsCheck, makeRepo({ githubHosts: "hosts: [a\n" })),
    ).toEqual([
      expect.stringMatching(new RegExp(`^${FILE}: is not valid YAML: `)),
    ]);
  });

  it.each([
    ["*.core.windows.net"],
    ["*.blob.core.windows.net"],
    ["productionresultssa*.blob.core.windows.net"],
    ["ProductionResultsSA0.blob.core.windows.net"],
    ["api.github.com."],
    ["https://api.github.com"],
    ["api.github.com:443"],
    ["140.82.112.6"],
    ["localhost"],
    [""],
  ])("refuses the host %j", async (host) => {
    expect(
      await run(
        githubHostsCheck,
        makeRepo({
          githubHosts: hostsFile({ hosts: ["api.github.com", host] }),
        }),
      ),
    ).toEqual([`${FILE}: hosts[1]: "${host}" must match ${HOST_PATTERN}`]);
  });

  it("refuses a repeated host, an empty list, a bad date, another source and unknown keys", () => {
    const messages = (overrides: Record<string, unknown>) =>
      githubHostsProblems({
        fetched: "2026-09-29",
        source: GITHUB_META_URL,
        hosts: ["api.github.com"],
        ...overrides,
      }).length;
    expect(messages({ hosts: ["api.github.com", "api.github.com"] })).toBe(1);
    expect(messages({ hosts: [] })).toBe(1);
    expect(messages({ fetched: "yesterday" })).toBe(1);
    expect(messages({ source: "https://example.com/meta" })).toBe(1);
    expect(messages({ wildcard_domains: ["*.github.com"] })).toBe(1);
    expect(messages({})).toBe(0);
  });
});

describe("logHostsFromMeta", () => {
  it("keeps the log download hosts and api.github.com, sorted, and nothing else", () => {
    expect(
      logHostsFromMeta(meta(PUBLISHED, ["*.core.windows.net", "*.github.com"])),
    ).toEqual([
      "api.github.com",
      "pipelinesghubeus2.actions.githubusercontent.com",
      "pipelinesproxweu1.actions.githubusercontent.com",
      "productionresultssa0.blob.core.windows.net",
      "productionresultssa19.blob.core.windows.net",
      "productionresultssa3.blob.core.windows.net",
    ]);
  });

  it("adds api.github.com even when the list leaves it out", () => {
    expect(
      logHostsFromMeta(meta(["productionresultssa1.blob.core.windows.net"])),
    ).toEqual(["api.github.com", "productionresultssa1.blob.core.windows.net"]);
  });

  it.each([
    ["*.core.windows.net"],
    ["*.blob.core.windows.net"],
    ["productionresultssa.blob.core.windows.net"],
    ["xproductionresultssa1.blob.core.windows.net"],
    ["productionresultssa1.blob.core.windows.net.example.com"],
    ["attackerproductionresultssa1.blob.core.windows.net"],
    ["productionresultssa1.file.core.windows.net"],
    ["pipelines.actions.githubusercontent.com"],
    ["pipelinesghubeus1.actions.githubusercontent.com.example.com"],
    ["evil.pipelinesghubeus1.actions.githubusercontent.com"],
  ])("never takes the look-alike %s", (host) => {
    expect(
      logHostsFromMeta(
        meta([host, "productionresultssa0.blob.core.windows.net"]),
      ),
    ).toEqual(["api.github.com", "productionresultssa0.blob.core.windows.net"]);
  });

  it("refuses an answer without the list, or with no log storage host in it", () => {
    for (const bad of [{}, meta("x"), meta([1, 2]), null])
      expect(() => logHostsFromMeta(bad)).toThrow(
        "does not list domains.actions_inbound.full_domains",
      );
    expect(() =>
      logHostsFromMeta(
        meta(["pipelinesghubeus1.actions.githubusercontent.com"]),
      ),
    ).toThrow("lists no productionresultssa*.blob.core.windows.net host");
  });

  it("never yields a wildcard or a host the schema refuses, whatever the answer lists", () => {
    const label = fc.stringMatching(/^[a-z0-9*.-]{0,12}$/);
    const domain = fc.oneof(
      fc
        .tuple(label, label, label)
        .map((parts) => parts.filter((p) => p !== "").join(".")),
      fc.nat(40).map((n) => `productionresultssa${n}.blob.core.windows.net`),
      fc
        .tuple(
          label,
          fc.constantFrom(".blob.core.windows.net", ".core.windows.net"),
        )
        .map(([a, b]) => `${a}${b}`),
      fc.constantFrom(...PUBLISHED, "*.core.windows.net", "*.github.com"),
    );
    fc.assert(
      fc.property(fc.array(domain, { maxLength: 30 }), (list) => {
        const full = [...list, "productionresultssa0.blob.core.windows.net"];
        const hosts = logHostsFromMeta(meta(full));
        expect(hosts[0]).toBe("api.github.com");
        for (const host of hosts) {
          expect(host).not.toContain("*");
          if (host !== "api.github.com") {
            expect(LOG_HOST_PATTERNS.some((p) => p.test(host))).toBe(true);
            expect(full).toContain(host);
          }
        }
        expect(
          githubHostsProblems({
            fetched: "2026-09-29",
            source: GITHUB_META_URL,
            hosts,
          }),
        ).toEqual([]);
      }),
    );
  });
});

describe("flax agents fetch-github-hosts", () => {
  it("writes a file that passes the check, dated the day it read the list", async () => {
    const root = makeRepo({ githubHosts: null });
    const seen: string[] = [];
    const fetchFn = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(meta(PUBLISHED)));
    }) as unknown as typeof fetch;
    const result = await fetchGithubHosts({
      root,
      fetch: fetchFn,
      now: () => new Date("2026-10-01T23:30:00Z"),
    });
    expect(seen).toEqual([GITHUB_META_URL]);
    expect(result.fetched).toBe("2026-10-01");
    expect(await run(githubHostsCheck, root)).toEqual([]);
    const text = readFileSync(join(root, FILE), "utf8");
    expect(text).toMatch(/^# The exact hosts/);
    expect(loadGithubHosts(root).hosts).toEqual(result);
    expect(existsSync(join(root, `${FILE}.partial`))).toBe(false);
  });

  it.each([
    ["a failed request", jsonFetch({}, 503), "returned 503"],
    [
      "an answer that is not JSON",
      (async () => new Response("<html>")) as unknown as typeof fetch,
      "did not return JSON",
    ],
    [
      "an answer over the size cap",
      (async () =>
        new Response(
          "x".repeat(MAX_META_BYTES + 1),
        )) as unknown as typeof fetch,
      "is larger than",
    ],
    [
      "an answer with no log hosts",
      jsonFetch(meta(["github.com"])),
      "lists no",
    ],
  ])("leaves the file alone on %s", async (_, fetchFn, message) => {
    const before = hostsFile();
    const root = makeRepo({ githubHosts: before });
    await expect(fetchGithubHosts({ root, fetch: fetchFn })).rejects.toThrow(
      message,
    );
    expect(readFileSync(join(root, FILE), "utf8")).toBe(before);
  });
});
