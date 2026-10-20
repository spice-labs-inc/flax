import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Model } from "../src/lib/allowlists.ts";
import { loadGateway, STATIC_KEY_MAX_MINUTES } from "../src/lib/gateway.ts";
import { loadWorkspace, type Provider } from "../src/lib/workspace.ts";
import { startModelForwarder } from "../src/run-job/forwarder.ts";
import {
  blockRunKey,
  GatewayClient,
  gatewayLedger,
  issueRunKey,
  keyId,
  keySpendUsd,
} from "../src/run-job/gateway.ts";
import { startFakeGateway, TLS } from "./fake-gateway.ts";
import { FLAX_TEXT, makeRepo, MODEL } from "./helpers.ts";

// Built at runtime so no key-shaped literal sits in the source.
const STATIC_KEY = ["k", "static", "5e4d3c2b"].join("-");
const NOW = new Date("2026-10-15T12:00:00Z");
const STATIC: Provider = {
  name: "anthropic",
  baseUrl: "https://api.example",
  keyMode: "static",
};
const LITELLM: Provider = { name: "acme", keyMode: "litellm" };
const TEST_MODEL: Model = {
  id: MODEL,
  provider: "acme",
  usd_per_million_input: 1,
  usd_per_million_output: 2,
};

describe("a static provider's gateway", () => {
  it("stands in for gateway.yml: the provider's base URL, no CA, the month budget as the key cap", () => {
    const root = makeRepo({ gateway: null });
    expect(loadGateway(root, NOW, STATIC, 100)).toEqual({
      gateway: {
        mode: "static",
        url: "https://api.example",
        server_name: "api.example",
        team: "static",
        key_max_usd: 100,
        key_max_minutes: STATIC_KEY_MAX_MINUTES,
      },
      problems: [],
    });
  });

  it("is a problem, not a gateway, without a base URL", () => {
    const root = makeRepo({ gateway: null });
    const { baseUrl: _, ...noUrl } = STATIC;
    const loaded = loadGateway(root, NOW, noUrl, 100);
    expect(loaded.gateway).toBeUndefined();
    expect(loaded.problems.map((p) => `${p.file}: ${p.field}: ${p.message}`)).toEqual([
      "flax.yml: agents.provider.baseUrl: agents.provider.baseUrl must be an https URL for a static provider",
    ]);
  });

  it("leaves a litellm workspace to gateway.yml, which must be there", () => {
    const root = makeRepo({ gateway: null });
    const loaded = loadGateway(root, NOW, LITELLM, 100);
    expect(loaded.gateway).toBeUndefined();
    expect(loaded.problems.map((p) => `${p.file}: ${p.message}`)).toEqual([
      "gateway.yml: is missing",
    ]);
  });

  it("is refused by the workspace loader when flax.yml names no base URL", () => {
    const root = makeRepo({
      flax: FLAX_TEXT.replace(
        /provider: \{[^}]*\}/,
        "provider: { name: anthropic, keyMode: static }",
      ),
    });
    const { workspace, problems } = loadWorkspace(root);
    expect(workspace.provider).toEqual({ name: "anthropic", keyMode: "static" });
    expect(problems).toEqual([
      "flax.yml: agents.provider.baseUrl must be an https URL when keyMode is static",
    ]);
    const withUrl = makeRepo({
      flax: FLAX_TEXT.replace(
        /provider: \{[^}]*\}/,
        "provider: { name: anthropic, keyMode: static, baseUrl: https://api.example }",
      ),
    });
    expect(loadWorkspace(withUrl).problems).toEqual([]);
  });
});

/** A static client pointed at the fake gateway, which must see no key traffic. */
async function staticClient() {
  const fake = await startFakeGateway({
    issuerKey: ["issuer", "never", "used", "1a2b3c4d"].join("-"),
    keys: [{ key_alias: "static/demo/2026-10/r", spend: 0, token: keyId(STATIC_KEY) }],
  });
  const client = new GatewayClient({
    gateway: {
      mode: "static",
      url: fake.url,
      server_name: "localhost",
      team: "static",
      key_max_usd: 100,
      key_max_minutes: STATIC_KEY_MAX_MINUTES,
    },
    ca: TLS.ca,
    issuerKey: STATIC_KEY,
  });
  return { fake, client };
}

describe("a static provider's client", () => {
  it("issues, blocks and reads no key: the run's key is the provider key, with an alias like an issued one", async () => {
    const { fake, client } = await staticClient();
    expect(client.mode).toBe("static");
    expect(client.label).toBe("the model provider");
    const key = await issueRunKey(client, {
      job: "demo",
      model: TEST_MODEL,
      month: "2026-10",
      runName: "job-demo-7-1",
      maxBudgetUsd: 5,
      minutes: 30,
    });
    expect(key).toEqual({
      key: STATIC_KEY,
      id: keyId(STATIC_KEY),
      alias: "static/demo/2026-10/job-demo-7-1",
    });
    await blockRunKey(client, key.key);
    expect(await keySpendUsd(client, key.id)).toBeUndefined();
    const ledger = gatewayLedger(client);
    expect(ledger.durable).toBe(false);
    expect(await ledger.spentUsd("demo", "2026-10")).toBe(0);
    expect(fake.requests).toEqual([]);
    expect(fake.issued).toEqual([]);
  });

  it("relays a messages call to the provider with the static key as x-api-key and bearer", async () => {
    const { fake, client } = await staticClient();
    const dir = mkdtempSync(join(tmpdir(), "agents-static-fwd-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, "model.sock");
    const forwarder = await startModelForwarder({
      socketPath,
      client,
      key: STATIC_KEY,
      model: "test-model",
      maxTokens: 4096,
      now: () => NOW,
    });
    onTestFinished(() => forwarder.stop());
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          method: "POST",
          path: "/v1/messages",
          headers: { "content-type": "application/json", "x-api-key": "box-made-this-up" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ model: "whatever", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).got).toEqual({
      model: "test-model",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    // The fake takes a messages call only with the key as both bearer and x-api-key.
    expect(fake.requests.map((r) => [r.method, r.path, r.authorization])).toEqual([
      ["POST", "/v1/messages", `Bearer ${STATIC_KEY}`],
    ]);
    expect(forwarder.records.map((r) => r.outcome)).toEqual(["forwarded"]);
  });
});
