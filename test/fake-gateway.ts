import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { KIT_ROOT } from "../src/lib/paths.ts";

const TLS_DIR = join(KIT_ROOT, "test", "fixtures", "gateway-tls");

/** Test certificates: a CA, a leaf for localhost it signed, and CAs that must not be trusted. */
export const TLS = {
  ca: readFileSync(join(TLS_DIR, "ca.pem"), "utf8"),
  otherCa: readFileSync(join(TLS_DIR, "other-ca.pem"), "utf8"),
  expiredCa: readFileSync(join(TLS_DIR, "expired-ca.pem"), "utf8"),
  leaf: readFileSync(join(TLS_DIR, "leaf.pem"), "utf8"),
  leafKey: readFileSync(join(TLS_DIR, "leaf-key.pem"), "utf8"),
};

export interface FakeKey {
  key_alias: string;
  spend: number;
  token?: string;
  blocked?: boolean;
}

export interface FakeRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
  at: number;
}

export interface FakeGatewayConfig {
  /** The only bearer the fake accepts. */
  issuerKey: string;
  /** Keys of the team that exist before the run. */
  keys?: FakeKey[];
  team?: { spend: number; max_budget?: number };
  /** Leave the keys out of /team/info. */
  noKeys?: boolean;
  /** Answer this path (without the query) with a status and an error body instead. */
  failures?: Record<string, { status: number; message: string }>;
  /** What a key issued in this test has spent when /key/info is asked. */
  spendOfIssued?: number;
  /** The catalog GET /v1/models/info serves, without a key. */
  catalog?: Record<string, unknown>;
}

export interface FakeGateway {
  url: string;
  requests: FakeRequest[];
  keys: FakeKey[];
  /** The raw keys issued, for asserting where they went. */
  issued: string[];
}

/** A stand-in for LiteLLM behind Caddy: the four routes the runner calls, over TLS with the test CA. */
export async function startFakeGateway(
  config: FakeGatewayConfig,
): Promise<FakeGateway> {
  const keys: FakeKey[] = [...(config.keys ?? [])];
  const requests: FakeRequest[] = [];
  const issued: string[] = [];
  const server: Server = createServer(
    { key: TLS.leafKey, cert: TLS.leaf },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "https://localhost");
        const text = Buffer.concat(chunks).toString("utf8");
        const body = text === "" ? undefined : (JSON.parse(text) as unknown);
        requests.push({
          method: req.method ?? "",
          path: `${url.pathname}${url.search}`,
          authorization: req.headers.authorization,
          body,
          at: Date.now(),
        });
        const send = (status: number, value: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        if (req.method === "GET" && url.pathname === "/v1/models/info")
          return send(200, config.catalog ?? {});
        if (req.method === "POST" && url.pathname === "/v1/messages") {
          const bearer = req.headers.authorization?.replace(/^Bearer /, "");
          const key = keys.find(
            (k) =>
              k.token ===
              createHash("sha256")
                .update(bearer ?? "")
                .digest("hex"),
          );
          if (
            key === undefined ||
            key.blocked ||
            bearer !== req.headers["x-api-key"]
          )
            return send(401, { error: { message: "invalid or blocked key" } });
          const m = body as { model?: string; stream?: boolean };
          if (m.stream === true) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`event: message_start\ndata: {"model":"${m.model}"}\n\n`);
            res.end(`event: message_stop\ndata: {}\n\n`);
            return;
          }
          return send(200, {
            type: "message",
            got: body,
            headers: {
              "anthropic-version": req.headers["anthropic-version"] ?? null,
              "anthropic-beta": req.headers["anthropic-beta"] ?? null,
              cookie: req.headers.cookie ?? null,
            },
          });
        }
        if (req.headers.authorization !== `Bearer ${config.issuerKey}`)
          return send(401, {
            error: { message: "Authentication Error, invalid key" },
          });
        const failure = config.failures?.[url.pathname];
        if (failure !== undefined)
          return send(failure.status, { error: { message: failure.message } });
        const b = body as Record<string, unknown> | undefined;
        if (req.method === "GET" && url.pathname === "/team/info") {
          return send(200, {
            team_id: url.searchParams.get("team_id"),
            team_info: config.team ?? { spend: 0, max_budget: 150 },
            ...(config.noKeys ? {} : { keys }),
          });
        }
        if (req.method === "POST" && url.pathname === "/key/generate") {
          const key = [
            "sk",
            "fakegw",
            String(issued.length + 1),
            "x9y8z7",
          ].join("-");
          issued.push(key);
          const token = createHash("sha256").update(key).digest("hex");
          keys.push({
            key_alias: String(b?.key_alias),
            spend: 0,
            token,
          });
          return send(200, {
            key,
            token,
            key_alias: b?.key_alias,
            expires: "2026-09-25T13:00:00Z",
          });
        }
        if (req.method === "POST" && url.pathname === "/key/update") {
          const token = createHash("sha256")
            .update(String(b?.key))
            .digest("hex");
          const found = keys.find((k) => k.token === token);
          if (found === undefined)
            return send(404, { error: { message: "key not found" } });
          found.blocked = b?.blocked === true;
          return send(200, { key: "updated" });
        }
        if (req.method === "GET" && url.pathname === "/key/info") {
          const found = keys.find(
            (k) => k.token === url.searchParams.get("key"),
          );
          if (found === undefined)
            return send(404, { error: { message: "key not found" } });
          return send(200, {
            key: url.searchParams.get("key"),
            info: {
              key_alias: found.key_alias,
              spend: config.spendOfIssued ?? found.spend,
              blocked: found.blocked ?? false,
            },
          });
        }
        send(404, { error: { message: "not served" } });
      });
    },
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  // By address: the runner checks the certificate against gateway.yml's server_name instead.
  return { url: `https://127.0.0.1:${port}`, requests, keys, issued };
}

// Built at runtime so no key-shaped literal sits in the source.
/** The issuer key the gateway from testGateway accepts. */
export const TEST_ISSUER_KEY = ["issuer", "test", "key", "7c6b5a49"].join("-");

/**
 * A fake gateway for a real run in a test: the gateway run option that
 * points the runner at it, and the issuer key the run's environment needs.
 */
export async function testGateway(config: Partial<FakeGatewayConfig> = {}) {
  const fake = await startFakeGateway({
    issuerKey: TEST_ISSUER_KEY,
    ...config,
  });
  return {
    fake,
    gateway: { baseUrl: fake.url, settleMs: 0, timeoutMs: 5000 },
    env: { LLM_GATEWAY_ISSUER_KEY: TEST_ISSUER_KEY },
  };
}
