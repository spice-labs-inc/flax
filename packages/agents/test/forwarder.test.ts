import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  MAX_FORWARD_BYTES,
  RECORD_TEXT_BYTES,
  startModelForwarder,
  type ModelForwarder,
} from "../src/run-job/forwarder.ts";
import { blockRunKey, GatewayClient, keyId } from "../src/run-job/gateway.ts";
import {
  startFakeGateway,
  TLS,
  type FakeGateway,
  type FakeGatewayConfig,
} from "./fake-gateway.ts";
import { GATEWAY } from "./helpers.ts";

// Built at runtime so no key-shaped literal sits in the source.
const ISSUER = ["issuer", "fwd", "key", "4c3b2a19"].join("-");
const RUN_KEY = ["sk", "run", "key", "8d7c6b5a"].join("-");

interface Reply {
  status: number;
  type: string | undefined;
  body: string;
}

function call(
  socketPath: string,
  method: string,
  path: string,
  body?: string | Buffer,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          type: res.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function setup(
  fakeConfig: Partial<FakeGatewayConfig> = {},
  unreachable = false,
): Promise<{
  fake: FakeGateway;
  forwarder: ModelForwarder;
  client: GatewayClient;
  socket: string;
}> {
  const fake = await startFakeGateway({
    issuerKey: ISSUER,
    keys: [
      { key_alias: "agents/demo/2026-09/r", spend: 0, token: keyId(RUN_KEY) },
    ],
    ...fakeConfig,
  });
  const client = new GatewayClient({
    gateway: GATEWAY,
    ca: TLS.ca,
    issuerKey: ISSUER,
    baseUrl: unreachable ? "https://127.0.0.1:1" : fake.url,
  });
  const dir = mkdtempSync(join(tmpdir(), "agents-fwd-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const socket = join(dir, "model.sock");
  const forwarder = await startModelForwarder({
    socketPath: socket,
    client,
    key: RUN_KEY,
    model: "test-model",
    maxTokens: 4096,
    now: () => new Date("2026-09-25T12:00:00Z"),
  });
  onTestFinished(() => forwarder.stop());
  return { fake, forwarder, client, socket };
}

const message = (extra: object = {}) =>
  JSON.stringify({
    model: "whatever-the-box-says",
    max_tokens: 100000,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });

describe("the model forwarder", () => {
  it("passes a messages call on with the run's key, the run's model and a capped max_tokens, dropping the box's own headers", async () => {
    const { fake, forwarder, socket } = await setup();
    const reply = await call(socket, "POST", "/v1/messages", message(), {
      "content-type": "text/plain",
      "x-api-key": "box-made-this-up",
      authorization: "Bearer box-made-this-up",
      cookie: "session=1",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "some-beta",
    });
    expect(reply.status).toBe(200);
    const got = JSON.parse(reply.body);
    expect(got.got).toEqual({
      model: "test-model",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(got.headers).toEqual({
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "some-beta",
      cookie: null,
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.authorization).toBe(`Bearer ${RUN_KEY}`);
    expect(forwarder.counts).toEqual({
      forwarded: 1,
      refused: 0,
      failed: 0,
      polls: 0,
    });
    expect(forwarder.records[0]).toMatchObject({
      at: "2026-09-25T12:00:00.000Z",
      method: "POST",
      path: "/v1/messages",
      outcome: "forwarded",
      status: 200,
      model: { asked: "whatever-the-box-says", sent: "test-model" },
      maxTokens: { asked: 100000, sent: 4096 },
    });
    expect(JSON.parse(forwarder.records[0]!.request!).model).toBe("test-model");
    expect(JSON.stringify(forwarder.records).includes(RUN_KEY)).toBe(false);
  });

  it("passes Pi's thinking and effort fields on unchanged", async () => {
    const { socket } = await setup();
    const thinking = {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    };
    const reply = await call(socket, "POST", "/v1/messages", message(thinking));
    expect(JSON.parse(reply.body).got).toMatchObject(thinking);
    const off = { thinking: { type: "disabled" } };
    const replyOff = await call(socket, "POST", "/v1/messages", message(off));
    expect(JSON.parse(replyOff.body).got).toMatchObject(off);
  });

  it("keeps a smaller max_tokens, and sets the cap when there is none or it is not a count", async () => {
    const { socket } = await setup();
    for (const [asked, sent] of [
      [10, 10],
      [undefined, 4096],
      [-3, 4096],
      [1.5, 4096],
      ["9", 4096],
    ] as const) {
      const reply = await call(
        socket,
        "POST",
        "/v1/messages?beta=true",
        message({ max_tokens: asked }),
      );
      expect(JSON.parse(reply.body).got.max_tokens).toBe(sent);
    }
  });

  it("streams an event stream back as it comes and records it", async () => {
    const { forwarder, socket } = await setup();
    const reply = await call(
      socket,
      "POST",
      "/v1/messages",
      message({ stream: true }),
    );
    expect(reply.status).toBe(200);
    expect(reply.type).toBe("text/event-stream");
    expect(reply.body).toContain('data: {"model":"test-model"}');
    expect(forwarder.records[0]!.reply).toBe(reply.body);
    expect(forwarder.records[0]!.replyBytes).toBe(reply.body.length);
  });

  it.each([
    ["GET", "/v1/messages"],
    ["POST", "/key/generate"],
    ["POST", "/key/update"],
    ["POST", "/v1/messages?beta=false"],
    ["POST", "/v1/messages/count_tokens"],
    ["POST", "/v1/chat/completions"],
    ["GET", "/team/info?team_id=agents"],
  ])("refuses %s %s and sends nothing to the gateway", async (method, path) => {
    const { fake, forwarder, socket } = await setup();
    const reply = await call(
      socket,
      method,
      path,
      method === "POST" ? message() : undefined,
    );
    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.body)).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message:
          "only POST /v1/messages and GET /v1/models/info are served here",
      },
    });
    expect(fake.requests).toEqual([]);
    expect(forwarder.counts).toEqual({
      forwarded: 0,
      refused: 1,
      failed: 0,
      polls: 0,
    });
    expect(forwarder.records[0]).toMatchObject({ method, path, status: 404 });
  });

  it("declines the client's usage polls with the same 404, counted apart and not recorded", async () => {
    const { fake, forwarder, socket } = await setup();
    for (const path of ["/v1/usage", "/v1/usage?window=1h"]) {
      const reply = await call(socket, "GET", path);
      expect(reply.status).toBe(404);
    }
    expect(fake.requests).toEqual([]);
    expect(forwarder.counts).toEqual({
      forwarded: 0,
      refused: 0,
      failed: 0,
      polls: 2,
    });
    expect(forwarder.records).toEqual([]);
  });

  it.each([["not json"], ["[1,2]"], ["null"], ['"text"']])(
    "refuses a body that is not a JSON object: %s",
    async (body) => {
      const { fake, socket } = await setup();
      const reply = await call(socket, "POST", "/v1/messages", body);
      expect(reply.status).toBe(400);
      expect(fake.requests).toEqual([]);
    },
  );

  it("refuses a body over the size limit", async () => {
    const { fake, forwarder, socket } = await setup();
    const reply = await call(
      socket,
      "POST",
      "/v1/messages",
      Buffer.alloc(MAX_FORWARD_BYTES + 1, 0x20),
    );
    expect(reply.status).toBe(413);
    expect(fake.requests).toEqual([]);
    expect(forwarder.records[0]!.outcome).toBe("refused");
  });

  it("serves the catalog entry of the run's model only, asking the gateway without any key", async () => {
    const { fake, socket } = await setup({
      catalog: {
        "test-model": { name: "test-model" },
        "acme-glm-5.3": { name: "acme-glm-5.3" },
      },
    });
    const reply = await call(socket, "GET", "/v1/models/info");
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({
      "test-model": { name: "test-model" },
    });
    expect(fake.requests[0]!.authorization).toBeUndefined();
  });

  it("passes the gateway's refusal of a blocked key back to the box", async () => {
    const { client, forwarder, socket } = await setup();
    await blockRunKey(
      new GatewayClient({
        gateway: GATEWAY,
        ca: TLS.ca,
        issuerKey: ISSUER,
        baseUrl: client.url,
      }),
      RUN_KEY,
    );
    const reply = await call(socket, "POST", "/v1/messages", message());
    expect(reply.status).toBe(401);
    expect(forwarder.records[0]).toMatchObject({
      outcome: "forwarded",
      status: 401,
    });
  });

  it("answers 502 and records the failure when the gateway cannot be reached", async () => {
    const { forwarder, socket } = await setup({}, true);
    const reply = await call(socket, "POST", "/v1/messages", message());
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body).error.message).toBe(
      "the model gateway could not be reached",
    );
    expect(forwarder.counts.failed).toBe(1);
    expect(forwarder.records[0]!.reason).toBe(
      "the model gateway at https://127.0.0.1:1 is unreachable (ECONNREFUSED) calling /v1/messages",
    );
  });

  it("keeps only the start of a long request in the record", async () => {
    const { forwarder, socket } = await setup();
    await call(
      socket,
      "POST",
      "/v1/messages",
      message({ messages: [{ role: "user", content: "x".repeat(200000) }] }),
    );
    const kept = forwarder.records[0]!.request!;
    expect(kept.length).toBeLessThan(RECORD_TEXT_BYTES + 100);
    expect(kept).toMatch(/\[cut at 65536 bytes of \d+\]$/);
  });

  it("listens on a socket only its owner can open, and never over an existing file", async () => {
    const { socket, client } = await setup();
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    const dir = mkdtempSync(join(tmpdir(), "agents-fwd-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "taken"), "");
    await expect(
      startModelForwarder({
        socketPath: join(dir, "taken"),
        client,
        key: RUN_KEY,
        model: "test-model",
        maxTokens: 1,
      }),
    ).rejects.toThrow(`${join(dir, "taken")} already exists`);
  });
});
