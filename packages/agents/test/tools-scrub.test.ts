import type { CallToolResult } from "@modelcontextprotocol/server";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../src/lib/tools.ts";
import { scrub, scrubber } from "../src/tools-server/scrub.ts";
import { ToolsServer } from "../src/tools-server/server.ts";

const hex = (n: number) =>
  fc.string({
    unit: fc.constantFrom(..."0123456789abcdefABCDEF"),
    minLength: n,
    maxLength: n,
  });
const alnum = (min: number, max: number) =>
  fc.string({
    unit: fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ),
    minLength: min,
    maxLength: max,
  });
const uuid = fc
  .tuple(hex(8), hex(4), hex(4), hex(4), hex(12))
  .map((parts) => parts.join("-"));
/** Text that holds no secret shape and no UUID: words of lowercase letters. */
const plain = fc.string({
  unit: fc.constantFrom(..."abcdefghij klmnop\n:,."),
  maxLength: 200,
});

const secretShapes: fc.Arbitrary<string>[] = [
  alnum(36, 40).map((s) => `ghs_${s}`),
  alnum(36, 40).map((s) => `ghp_${s}`),
  alnum(22, 40).map((s) => `github_pat_${s}`),
  alnum(10, 40).map((s) => `xoxb-${s}`),
  fc
    .tuple(alnum(10, 30), alnum(10, 30), alnum(10, 30))
    .map(([a, b, c]) => `eyJ${a}.eyJ${b}.${c}`),
  alnum(16, 16).map((s) => `AKIA${s.toUpperCase()}`),
  alnum(8, 30).map((s) => `o2oi_${s}`),
];

describe("scrub", () => {
  it("collapses every UUID to :id, as chicory does", () => {
    fc.assert(
      fc.property(plain, uuid, plain, (a, id, b) => {
        const out = scrub(`${a}/org/${id}/project/${id.toUpperCase()}${b}`);
        expect(out).toBe(`${a}/org/:id/project/:id${b}`);
      }),
    );
  });

  it("collapses a project id that Helm cut short before appending its hash", () => {
    expect(
      scrub(
        "HelmRelease project-710938c0-bbc9-48cf-8e6e-afb5eaca-7c4cced0fecb.v1 drifted",
      ),
    ).toBe("HelmRelease project-:id-7c4cced0fecb.v1 drifted");
    fc.assert(
      fc.property(uuid, fc.integer({ min: 1, max: 11 }), (id, keep) => {
        const cut = id.slice(0, 24 + keep);
        expect(scrub(`project-${cut}-abc123`)).toBe("project-:id-abc123");
      }),
    );
  });

  it("removes secret-shaped strings wherever they sit", () => {
    fc.assert(
      fc.property(plain, fc.oneof(...secretShapes), plain, (a, secret, b) => {
        const out = scrub(`${a} ${secret} ${b}`);
        expect(out).not.toContain(secret);
        expect(out).toBe(`${a} [redacted] ${b}`);
      }),
    );
  });

  it("removes the run's known credential values, however they are embedded", () => {
    fc.assert(
      fc.property(plain, alnum(8, 60), plain, (a, secret, b) => {
        expect(scrubber([secret])(`${a}${secret}${b}`)).not.toContain(secret);
      }),
    );
  });

  it("leaves text with no secret shape or UUID unchanged", () => {
    fc.assert(
      fc.property(plain, (text) => {
        expect(scrub(text)).toBe(text);
      }),
    );
  });

  it("removes a whole private key block", () => {
    const key =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(scrub(`before\n${key}\nafter`)).toBe("before\n[redacted]\nafter");
  });

  it("removes credentials after an auth scheme", () => {
    expect(scrub("Authorization: Basic Y2ktdHJhY2VzOnBhc3N3b3Jk")).toBe(
      "Authorization: Basic [redacted]",
    );
    expect(scrub('"authorization":"Bearer abcdefgh12345678"')).toBe(
      '"authorization":"Bearer [redacted]"',
    );
    expect(scrub("the basic idea is simple")).toBe("the basic idea is simple");
  });

  it("drops the query string of a signed URL and keeps ordinary ones", () => {
    const signed =
      "https://productionresultssa1.blob.core.windows.net/actions-results/x/logs.txt?rsct=text%2Fplain&se=2026-09-28T20%3A00%3A00Z&sig=AbC%2Bdef&sp=r&sv=2021-12-02";
    expect(scrub(`failed to download logs: Get "${signed}": timeout`)).toBe(
      'failed to download logs: Get "https://productionresultssa1.blob.core.windows.net/actions-results/x/logs.txt?[redacted]": timeout',
    );
    expect(scrub("https://s3.example/x?X-Amz-Signature=abc")).toBe(
      "https://s3.example/x?[redacted]",
    );
    const plainUrl =
      "https://github.com/notes-co/engine/pulls?state=open&base=main";
    expect(scrub(plainUrl)).toBe(plainUrl);
  });
});

describe("the tools server scrubs", () => {
  const spec: ToolSpec = {
    name: "probe",
    description: "Returns whatever the fake upstream says, for the tests.",
    arguments: { type: "object", additionalProperties: false, properties: {} },
    upstream: { server: "fake", operations: ["read"] },
    source: "trusted",
    result_max_bytes: 10000,
  };
  const ORG = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const TOKEN = "s3cr3t-kubeconfig-token-value";

  function serverAnswering(answer: () => Promise<string>) {
    return new ToolsServer({
      tools: [
        {
          spec,
          mapping: { map: () => ({ operation: "read", arguments: {} }) },
        },
      ],
      limits: { calls: 10, seconds: 5 },
      upstreams: { fake: { call: answer } },
      scrub: scrubber([TOKEN]),
    });
  }

  const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;

  it("results, before the model sees them", async () => {
    const server = serverAnswering(() =>
      Promise.resolve(
        `GET /org/${ORG}/reports token=${TOKEN} xoxb-1234567890abc`,
      ),
    );
    const out = textOf(await server.call("probe", {}));
    expect(out).toContain("GET /org/:id/reports token=[redacted] [redacted]");
    expect(out).not.toContain(ORG);
    expect(out).not.toContain(TOKEN);
  });

  it("upstream error text, in the reply and in the run record", async () => {
    const server = serverAnswering(() =>
      Promise.reject(new Error(`401 for ${ORG} with ${TOKEN}`)),
    );
    const out = textOf(await server.call("probe", {}));
    expect(out).toContain("401 for :id with [redacted]");
    expect(JSON.stringify(server.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(server.calls)).not.toContain(ORG);
    expect(server.calls[0]?.reason).toBe(
      "probe failed: 401 for :id with [redacted]",
    );
  });

  it("with no known credentials by default", async () => {
    const server = new ToolsServer({
      tools: [
        {
          spec,
          mapping: { map: () => ({ operation: "read", arguments: {} }) },
        },
      ],
      limits: { calls: 10, seconds: 5 },
      upstreams: { fake: { call: () => Promise.resolve(`id ${ORG}`) } },
    });
    expect(textOf(await server.call("probe", {}))).toContain("id :id");
  });
});
