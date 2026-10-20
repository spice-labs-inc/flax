import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { stringify } from "yaml";
import { generate } from "../src/generate/generate.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { GatewayClient, gatewayLedger } from "../src/run-job/gateway.ts";
import { LbxLauncher, type Launcher } from "../src/run-job/launcher.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import {
  startFakeGateway,
  TLS,
  type FakeGateway,
  type FakeGatewayConfig,
} from "./fake-gateway.ts";
import { writeFakeLbx } from "./fake-lbx.ts";
import { GATEWAY, jobConfig, jobFiles, makeRepo, MODEL } from "./helpers.ts";

// Built at runtime so no key-shaped literal sits in the source.
const ISSUER = ["issuer", "test", "key", "5e4d3c2b1a"].join("-");
const WHO = { uid: process.getuid!(), home: "/nonexistent-home" };
const NOW = () => new Date("2026-09-25T12:00:00Z");
const CLAUDE = "anthropic/claude-test-1";
const MODELS = [
  {
    id: MODEL,
    provider: "acme",
    usd_per_million_input: 1,
    usd_per_million_output: 2,
  },
  {
    id: CLAUDE,
    provider: "anthropic",
    usd_per_million_input: 4,
    usd_per_million_output: 20,
  },
];
// 1000 tokens at $2 per million.
const WORST_CASE = 0.002;
const ALIAS = "agents/demo/2026-09/job-demo-77-1";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-gw-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function repo(
  files: Record<string, string | null> = {},
  ca = TLS.ca,
  serverName = "localhost",
): Promise<string> {
  const root = makeRepo({
    jobs: { demo: { ...jobFiles("demo"), ...files } },
    models: MODELS,
    gateway: { ...GATEWAY, server_name: serverName },
    files: { "gateway-ca.pem": ca },
  });
  await generate(loadRepo(root));
  return root;
}

interface Setup {
  fake?: Partial<FakeGatewayConfig>;
  env?: Record<string, string>;
  files?: Record<string, string | null>;
  ca?: string;
  extra?: Partial<RunOptions>;
  /** gateway.yml's server_name; the fake's certificate is issued for localhost. */
  serverName?: string;
  /** Point the runner at a port nothing listens on. */
  unreachable?: boolean;
}

async function gatewayRun(setup: Setup = {}) {
  const fake: FakeGateway = await startFakeGateway({
    issuerKey: ISSUER,
    ...setup.fake,
  });
  const root = await repo(setup.files, setup.ca, setup.serverName);
  const bin = scratch();
  const dir = scratch();
  const summary = join(dir, "step-summary.md");
  const opts: RunOptions = {
    root,
    name: "demo",
    scratch: dir,
    out: join(dir, "report"),
    identity: WHO,
    now: NOW,
    log: () => {},
    lbx: writeFakeLbx(bin),
    launcher: new LbxLauncher(new PassThrough(), new PassThrough()),
    gateway: {
      baseUrl: setup.unreachable ? "https://127.0.0.1:1" : fake.url,
      settleMs: 0,
      timeoutMs: 5000,
    },
    socketBases: [scratch()],
    env: {
      PATH: process.env.PATH ?? "",
      LLM_GATEWAY_ISSUER_KEY: ISSUER,
      GITHUB_RUN_ID: "77",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_STEP_SUMMARY: summary,
      FAKE_LBX_ANSWER: '{"summary":"through the gateway"}',
      ...setup.env,
    },
    ...setup.extra,
  };
  const result = await runJob(opts);
  const seenFile = join(bin, "seen.json");
  const seen = existsSync(seenFile)
    ? JSON.parse(readFileSync(seenFile, "utf8"))
    : undefined;
  const files = existsSync(opts.out!) ? reportFiles(opts.out!) : new Map();
  const stepSummary = existsSync(summary) ? readFileSync(summary, "utf8") : "";
  return { result, seen, fake, files, stepSummary, root };
}

function reportFiles(dir: string, rel = ""): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory())
      for (const [k, v] of reportFiles(dir, path)) files.set(k, v);
    else files.set(path, readFileSync(join(dir, path), "utf8"));
  }
  return files;
}

const paths = (fake: FakeGateway) =>
  fake.requests.map((r) => `${r.method} ${r.path.split("?")[0]}`);

describe("a run through the model gateway", () => {
  it("reads the month's spend, issues one key for the run, forwards the box's model calls with it, then blocks it and reads its spend", async () => {
    const { result, seen, fake, files, stepSummary } = await gatewayRun({
      fake: { spendOfIssued: 0.0012 },
      env: {
        GITHUB_SHA: "a".repeat(40),
        FAKE_LBX_MODEL_CALL: JSON.stringify({
          model: "some-other-model",
          max_tokens: 99999,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    });
    expect(result.messages[0]).toBe("demo: answer accepted.");
    expect(paths(fake)).toEqual([
      "GET /team/info",
      "POST /key/generate",
      "POST /v1/messages",
      "POST /key/update",
      "GET /key/info",
    ]);
    expect(fake.requests[0]!.path).toBe("/team/info?team_id=agents");
    const key = fake.issued[0]!;
    for (const r of fake.requests)
      expect(r.authorization).toBe(
        r.path === "/v1/messages" ? `Bearer ${key}` : `Bearer ${ISSUER}`,
      );
    expect(fake.requests[1]!.body).toEqual({
      team_id: "agents",
      key_alias: ALIAS,
      models: ["test-model"],
      max_budget: WORST_CASE,
      duration: "20m",
      max_parallel_requests: 2,
      rpm_limit: 60,
      key_type: "llm_api",
      metadata: {
        job: "demo",
        run: "job-demo-77-1",
        month: "2026-09",
        model: MODEL,
        workflow_run: "77",
        sha: "a".repeat(40),
      },
    });
    // The box's call reached the gateway with the run's key, its model and a capped max_tokens.
    expect(seen.modelReply.status).toBe(200);
    expect(JSON.parse(seen.modelReply.body).got).toEqual({
      model: "test-model",
      max_tokens: 1000,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(fake.requests[3]!.body).toEqual({ key, blocked: true });
    expect(fake.keys.find((k) => k.key_alias === ALIAS)!.blocked).toBe(true);
    // The key was issued before the box started and blocked after it ended.
    expect(fake.requests[1]!.at).toBeLessThanOrEqual(seen.at);
    expect(fake.requests[3]!.at).toBeGreaterThanOrEqual(seen.at);

    // The box holds no key at all and has no network: only the model socket.
    expect(seen.envNames).not.toContain("ACME_API_KEY");
    expect(seen.hasIssuerKey).toBe(false);
    expect(seen.socketExists).toBe(true);
    expect(seen.socketEntries).toEqual([
      { name: "model.sock", socket: true, uid: process.getuid!() },
    ]);
    const after = (flag: string) =>
      seen.argv.flatMap((a: string, i: number) =>
        a === flag ? [seen.argv[i + 1]] : [],
      );
    expect(after("--env")).toEqual([]);
    expect(after("--model")).toEqual([MODEL]);
    expect(seen.argv).toContain("--no-network");
    expect(seen.argv).not.toContain("--net-policy");
    expect(seen.dataFiles).toEqual([
      "input.json",
      "output.schema.json",
      "prompt.md",
      "session",
    ]);

    // The report records the key by alias and id, never the key, and every forwarded call.
    const status = JSON.parse(files.get("status.json")!);
    expect(status.gateway).toEqual({
      url: "https://192.168.128.1:8443",
      keyAlias: ALIAS,
      keyId: fake.keys.find((k) => k.key_alias === ALIAS)!.token,
      maxBudgetUsd: WORST_CASE,
      minutes: 20,
      expires: "2026-09-25T13:00:00Z",
      forwarder: { forwarded: 1, refused: 0, failed: 0, polls: 0 },
      blocked: true,
      spendUsd: 0.0012,
      problems: [],
    });
    const forwarded = JSON.parse(files.get("forwarder.json")!);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      method: "POST",
      path: "/v1/messages",
      outcome: "forwarded",
      status: 200,
      model: { asked: "some-other-model", sent: "test-model" },
      maxTokens: { asked: 99999, sent: 1000 },
    });
    expect(status.budget).toEqual({
      month: "2026-09",
      spentUsd: 0,
      reserveUsd: WORST_CASE,
      ledger: "durable",
      shared: {
        who: "all jobs (gateway team agents)",
        spentUsd: 0,
        limitUsd: 150,
      },
    });
    expect(stepSummary).toContain(
      `| Model gateway | key \`${ALIAS}\`, $0.0012 spent of $0.00, 1 call forwarded, 0 refused, blocked |`,
    );
    for (const [file, text] of files) {
      expect(text.includes(key), file).toBe(false);
      expect(text.includes(ISSUER), file).toBe(false);
    }
    expect(stepSummary.includes(key) || stepSummary.includes(ISSUER)).toBe(
      false,
    );
  });

  it("reaches a Claude model as acme/<name>, with a key for that model alone", async () => {
    const { result, seen, fake } = await gatewayRun({
      extra: { model: CLAUDE },
    });
    expect(result.ok).toBe(true);
    const body = fake.requests[1]!.body as {
      models: string[];
      max_budget: number;
    };
    expect(body.models).toEqual(["claude-test-1"]);
    // 1000 tokens at $20 per million.
    expect(body.max_budget).toBeCloseTo(0.02, 10);
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe(
      "acme/claude-test-1",
    );
  });

  it.each<[string, Record<string, string>]>([
    ["Pi exits non-zero", { FAKE_LBX_STATUS: "status=exited code=1" }],
    ["the run times out", { FAKE_LBX_STATUS: "status=timeout code=124" }],
    ["the answer does not match", { FAKE_LBX_ANSWER: '{"summary":3}' }],
    ["there is no answer", { FAKE_LBX_ANSWER: "" }],
  ])("blocks the key when %s", async (_, env) => {
    const { result, fake, files } = await gatewayRun({ env });
    expect(result.ok).toBe(false);
    expect(paths(fake)).toContain("POST /key/update");
    expect(fake.keys.find((k) => k.key_alias === ALIAS)!.blocked).toBe(true);
    expect(JSON.parse(files.get("status.json")!).gateway.blocked).toBe(true);
  });

  it("blocks the key when launching the box throws", async () => {
    const throwing: Launcher = {
      kind: "lbx",
      launch: () => Promise.reject(new Error("docker went away")),
    };
    const { result, fake } = await gatewayRun({
      extra: { launcher: throwing },
    });
    expect(result.messages[0]).toBe("demo: docker went away");
    expect(fake.keys.find((k) => k.key_alias === ALIAS)!.blocked).toBe(true);
  });

  it("marks the run incomplete when the key cannot be blocked", async () => {
    const { result, fake, files } = await gatewayRun({
      fake: {
        failures: { "/key/update": { status: 500, message: "db down" } },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      `demo: the run is incomplete: its gateway key ${ALIAS} could not be blocked and stays usable until it expires at 2026-09-25T13:00:00Z`,
    );
    const status = JSON.parse(files.get("status.json")!);
    expect(status.gateway.blocked).toBe(false);
    expect(status.gateway.problems).toEqual([
      `blocking the key failed: the model gateway at ${fake.url} answered HTTP 500 to /key/update: db down`,
    ]);
    // The answer is still kept.
    expect(files.has("answer.json")).toBe(true);
  });

  it("notes, without failing, a spend it could not read", async () => {
    const { result, files } = await gatewayRun({
      fake: {
        failures: { "/key/info": { status: 500, message: "busy" } },
      },
    });
    expect(result.ok).toBe(true);
    const status = JSON.parse(files.get("status.json")!);
    expect(status.gateway.spendUsd).toBeUndefined();
    expect(status.gateway.problems[0]).toMatch(
      /^reading the key's spend failed: /,
    );
  });

  it("gives collect.ts no issuer key", async () => {
    const collect =
      "console.log(JSON.stringify({ issuer: process.env.LLM_GATEWAY_ISSUER_KEY ?? null }));\n";
    const { result, seen } = await gatewayRun({
      files: { "collect.ts": collect },
    });
    expect(result.ok).toBe(true);
    const dataDir = seen.argv[seen.argv.indexOf("--data") + 1];
    expect(
      JSON.parse(readFileSync(join(dataDir, "input.json"), "utf8")),
    ).toEqual({ issuer: null });
  });
});

describe("a run through the gateway does not start", () => {
  it("without the issuer key", async () => {
    const { result, seen } = await gatewayRun({
      env: { LLM_GATEWAY_ISSUER_KEY: "" },
    });
    expect(result.messages).toEqual([
      "LLM_GATEWAY_ISSUER_KEY is not set; the model gateway needs it to issue the run's key",
    ]);
    expect(seen).toBeUndefined();
  });

  it("when the gateway is unreachable", async () => {
    const { result, seen } = await gatewayRun({ unreachable: true });
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      "the model gateway at https://127.0.0.1:1 is unreachable (ECONNREFUSED) calling /team/info?team_id=agents; the job did not start",
    );
    expect(seen).toBeUndefined();
  });

  it("when the gateway's certificate does not chain to the pinned CA", async () => {
    const { result, seen, fake } = await gatewayRun({ ca: TLS.otherCa });
    expect(result.messages).toEqual([
      `the model gateway at ${fake.url} presented a certificate the pinned CA root does not vouch for as localhost (UNABLE_TO_VERIFY_LEAF_SIGNATURE); check gateway.yml and gateway-ca.pem; the job did not start`,
    ]);
    expect(seen).toBeUndefined();
    // The TLS handshake failed, so no request reached the gateway.
    expect(fake.requests).toEqual([]);
  });

  it("when the gateway's certificate is not issued for server_name", async () => {
    const { result, seen, fake } = await gatewayRun({
      serverName: "llm-gateway.internal",
    });
    expect(result.messages).toEqual([
      `the model gateway at ${fake.url} presented a certificate the pinned CA root does not vouch for as llm-gateway.internal (ERR_TLS_CERT_ALTNAME_INVALID); check gateway.yml and gateway-ca.pem; the job did not start`,
    ]);
    expect(seen).toBeUndefined();
    expect(fake.requests).toEqual([]);
  });

  it("when the gateway refuses the issuer key", async () => {
    const { result, seen, fake } = await gatewayRun({
      env: {
        LLM_GATEWAY_ISSUER_KEY: ["other", "issuer", "key", "77"].join("-"),
      },
    });
    expect(result.messages[0]).toBe(
      `the model gateway at ${fake.url} refused LLM_GATEWAY_ISSUER_KEY for /team/info?team_id=agents (HTTP 401); check the secret; the job did not start`,
    );
    expect(seen).toBeUndefined();
  });

  it("when issuing the key fails, and nothing is left to block", async () => {
    const { result, seen, fake, files } = await gatewayRun({
      fake: {
        failures: {
          "/key/generate": {
            status: 400,
            message: "Budget has been exceeded! Current cost: 150.1",
          },
        },
      },
    });
    expect(result.messages[0]).toBe(
      `demo: the model gateway at ${fake.url} answered HTTP 400 to /key/generate: Budget has been exceeded! Current cost: 150.1; the job did not start`,
    );
    expect(seen).toBeUndefined();
    expect(paths(fake)).not.toContain("POST /key/update");
    expect(JSON.parse(files.get("status.json")!).gateway).toEqual({
      url: "https://192.168.128.1:8443",
      blocked: false,
      problems: [],
    });
  });

  it("when the job's month-to-date spend plus the worst case passes its limit", async () => {
    const keys = [
      { key_alias: "agents/demo/2026-09/job-demo-1-1", spend: 3 },
      { key_alias: "agents/demo/2026-09/job-demo-2-1", spend: 1.999 },
      // Another month and another job do not count.
      { key_alias: "agents/demo/2026-08/job-demo-0-1", spend: 100 },
      { key_alias: "agents/demo-two/2026-09/job-demo-two-1-1", spend: 100 },
      { key_alias: "agents-runner-20260929T000000Z", spend: 0 },
    ];
    const { result, seen, fake } = await gatewayRun({ fake: { keys } });
    expect(result.messages).toEqual([
      "demo has spent $5.00 of its $5 in 2026-09; a run can cost up to $0.00",
    ]);
    expect(seen).toBeUndefined();
    expect(paths(fake)).toEqual(["GET /team/info"]);
    // Just under the limit, it runs.
    const under = await gatewayRun({
      fake: {
        keys: [{ key_alias: "agents/demo/2026-09/job-demo-1-1", spend: 4.9 }],
      },
    });
    expect(under.result.ok).toBe(true);
    expect(JSON.parse(under.files.get("status.json")!).budget.spentUsd).toBe(
      4.9,
    );
  });

  it("when all jobs together have used the team's monthly budget", async () => {
    const { result, seen } = await gatewayRun({
      fake: { team: { spend: 149.999, max_budget: 150 } },
    });
    expect(result.messages).toEqual([
      "all jobs (gateway team agents) have spent $150.00 of $150 in 2026-09; a run of demo can cost up to $0.00",
    ]);
    expect(seen).toBeUndefined();
  });

  it("when the gateway does not list the team's keys", async () => {
    const { result, fake } = await gatewayRun({ fake: { noKeys: true } });
    expect(result.messages).toEqual([
      `the model gateway at ${fake.url} did not list team agents's keys, so demo's spend in 2026-09 is unknown; the job did not start`,
    ]);
  });

  it("when the run's key would pass the gateway's ceiling", async () => {
    // 2,000,000 tokens at $20 per million is $40, over the $25 ceiling.
    const big = await gatewayRun({
      files: {
        "job.yml": stringify(
          jobConfig("demo", {
            limits: { turns: 10, tokens_per_run: 2000000, usd_per_month: 50 },
          }),
        ),
      },
      extra: { model: CLAUDE },
    });
    expect(big.result.messages).toEqual([
      "a run of demo at anthropic/claude-test-1 can cost up to $40.00, over the gateway's $25 ceiling for one key (key_max_usd in gateway.yml)",
    ]);
    expect(paths(big.fake)).toEqual(["GET /team/info"]);
    expect(big.seen).toBeUndefined();
  });
});

describe("runs that call no model", () => {
  it("a stub run gives the box no key, no network and contacts nothing", async () => {
    const root = await repo();
    const dir = scratch();
    const result = await runJob({
      root,
      name: "demo",
      stub: true,
      scratch: dir,
      out: join(dir, "report"),
      env: {},
      identity: WHO,
      log: () => {},
      gateway: { baseUrl: "https://127.0.0.1:1" },
      socketBases: [scratch()],
    });
    expect(result.ok).toBe(true);
    const argv = result.report!.argv;
    expect(argv).not.toContain("--env");
    expect(argv).not.toContain("--net-policy");
    expect(argv).toContain("--no-network");
    expect(result.report!.gateway).toEqual({
      url: "https://192.168.128.1:8443",
      blocked: false,
      problems: [],
    });
  });

  it("--preflight needs no issuer key and contacts nothing", async () => {
    const root = await repo();
    const result = await runJob({
      root,
      name: "demo",
      preflight: true,
      env: {},
      log: () => {},
      gateway: { baseUrl: "https://127.0.0.1:1" },
    });
    expect(result.ok).toBe(true);
  });
});

describe("the gateway ledger", () => {
  it("sums one job's keys for one month and reads the team's spend and cap", async () => {
    const fake = await startFakeGateway({
      issuerKey: ISSUER,
      team: { spend: 12.5, max_budget: 150 },
      keys: [
        { key_alias: "agents/a/2026-09/r1", spend: 1.25 },
        { key_alias: "agents/a/2026-09/r2", spend: 0.5 },
        { key_alias: "agents/ab/2026-09/r1", spend: 7 },
        { key_alias: "agents/a/2026-10/r1", spend: 9 },
      ],
    });
    const ledger = gatewayLedger(
      new GatewayClient({
        gateway: GATEWAY,
        ca: TLS.ca,
        issuerKey: ISSUER,
        baseUrl: fake.url,
      }),
    );
    expect(ledger.durable).toBe(true);
    expect(await ledger.spentUsd("a", "2026-09")).toBeCloseTo(1.75, 10);
    expect(await ledger.spentUsd("ab", "2026-09")).toBe(7);
    expect(await ledger.sharedSpend!("2026-09")).toEqual({
      who: "all jobs (gateway team agents)",
      spentUsd: 12.5,
      limitUsd: 150,
    });
    // One read of the team serves the whole budget check.
    expect(fake.requests).toHaveLength(1);
  });
});
