import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import type * as Extension from "../images/agent/pi-mcp-mailbox/src/extension.ts";
import {
  shimPort,
  startModelShim,
} from "../images/agent/pi-mcp-mailbox/src/model-shim.ts";
import {
  MODEL_SHIM_PORT,
  MODEL_SHIM_URL,
} from "../images/agent/pi-mcp-mailbox/src/sockets.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { bundlePiPlugin } from "../src/pi-plugin/bundle.ts";
import { startModelForwarder } from "../src/run-job/forwarder.ts";
import { GatewayClient, keyId } from "../src/run-job/gateway.ts";
import { startFakeGateway, TLS, type FakeGateway } from "./fake-gateway.ts";
import { GATEWAY } from "./helpers.ts";

// Built at runtime so no key-shaped literal sits in the source.
const RUN_KEY = ["run", "key", "1b2c3d4e"].join("-");

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-shim-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** The runner's forwarder on a socket, sending to a stand-in for the model gateway. */
async function forwarderTo(baseUrl?: string): Promise<{
  socketPath: string;
  fake: FakeGateway;
}> {
  const fake = await startFakeGateway({
    issuerKey: ["unused", "issuer", "5c6d"].join("-"),
    keys: [{ key_alias: "run", spend: 0, token: keyId(RUN_KEY) }],
    catalog: {
      "test-model": { display_name: "Test" },
      "other-model": { display_name: "Other" },
    },
  });
  const socketPath = join(scratch(), "model.sock");
  const forwarder = await startModelForwarder({
    socketPath,
    client: new GatewayClient({
      gateway: GATEWAY,
      ca: TLS.ca,
      issuerKey: ["unused", "issuer", "5c6d"].join("-"),
      baseUrl: baseUrl ?? fake.url,
    }),
    key: RUN_KEY,
    model: "test-model",
    maxTokens: 1000,
  });
  onTestFinished(() => forwarder.stop());
  return { socketPath, fake };
}

/** What Pi's Acme provider sends: its own idea of the key and the model. */
function piCall(base: string) {
  return fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "held-by-the-runner",
      authorization: "Bearer held-by-the-runner",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "acme-whatever",
      max_tokens: 5000,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

describe("the model shim's address", () => {
  it("is the loopback URL the runner gives the Acme provider", () => {
    expect(MODEL_SHIM_URL).toBe("http://127.0.0.1:18080");
    expect(shimPort(MODEL_SHIM_URL)).toBe(MODEL_SHIM_PORT);
    expect(shimPort(`${MODEL_SHIM_URL}/`)).toBe(MODEL_SHIM_PORT);
  });

  it.each([
    undefined,
    "",
    "https://127.0.0.1:18080",
    "http://localhost:18080",
    "http://127.0.0.2:18080",
    "http://127.0.0.1",
    "http://127.0.0.1:18080/v1",
    "http://127.0.0.1:18080?x=1",
    "http://u:p@127.0.0.1:18080",
    "https://api.code.acme.ai",
  ])("refuses %s", (value) => {
    expect(() => shimPort(value)).toThrow(
      "with the model socket mounted it must be http://127.0.0.1:<port>",
    );
  });
});

describe("the model path from the box", () => {
  it("reaches the runner's forwarder through the shim, which adds the key the box never has", async () => {
    const { socketPath, fake } = await forwarderTo();
    const shim = await startModelShim({ socketPath, port: 0 });
    onTestFinished(() => shim.close());
    const base = `http://127.0.0.1:${shim.port}`;

    const reply = await piCall(base);
    expect(reply.status).toBe(200);
    const body = (await reply.json()) as { got: unknown };
    expect(body.got).toEqual({
      model: "test-model",
      max_tokens: 1000,
      messages: [{ role: "user", content: "hello" }],
    });
    const sent = fake.requests.find((r) => r.path === "/v1/messages")!;
    expect(sent.authorization).toBe(`Bearer ${RUN_KEY}`);

    const catalog = await fetch(`${base}/v1/models/info`);
    expect(await catalog.json()).toEqual({
      "test-model": { display_name: "Test" },
    });
    expect((await fetch(`${base}/v1/usage`)).status).toBe(404);
  });

  it("gives the box a plain error when the gateway cannot be reached", async () => {
    const { socketPath } = await forwarderTo("https://127.0.0.1:1");
    const shim = await startModelShim({ socketPath, port: 0 });
    onTestFinished(() => shim.close());
    const reply = await piCall(`http://127.0.0.1:${shim.port}`);
    expect(reply.status).toBe(502);
    expect(await reply.json()).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "the model gateway could not be reached",
      },
    });
  });

  it("works the same from the bundled plugin, which starts the shim only when the model socket is there", async () => {
    const dir = scratch();
    const bundle = await bundlePiPlugin(KIT_ROOT, join(dir, "plugin.mjs"));
    const plugin = (await import(
      pathToFileURL(bundle.path).href
    )) as typeof Extension;
    const shutdown: (() => unknown)[] = [];
    const pi = {
      registerTool: () => undefined,
      on: (_event: "session_shutdown", handler: () => unknown) =>
        shutdown.push(handler),
    };
    expect(
      await plugin.startModelPath(pi, join(dir, "missing.sock"), undefined),
    ).toBe(false);
    expect(shutdown).toEqual([]);

    const { socketPath, fake } = await forwarderTo();
    const port = await freePort();
    await expect(
      plugin.startModelPath(pi, socketPath, "https://api.code.acme.ai"),
    ).rejects.toThrow("must be http://127.0.0.1:<port>");
    expect(
      await plugin.startModelPath(pi, socketPath, `http://127.0.0.1:${port}`),
    ).toBe(true);
    const reply = await piCall(`http://127.0.0.1:${port}`);
    expect(reply.status).toBe(200);
    expect(
      fake.requests.find((r) => r.path === "/v1/messages")!.authorization,
    ).toBe(`Bearer ${RUN_KEY}`);
    for (const handler of shutdown) await handler();
    await expect(piCall(`http://127.0.0.1:${port}`)).rejects.toThrow();
  });
});
