import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolSecretEnv } from "../src/lib/tools.ts";

/**
 * Writes an executable stand-in for lbx that behaves like a finished run:
 * it writes the answer into the data directory, the status file into the
 * state directory and the status line on standard error, and records what
 * it was given. FAKE_LBX_* variables choose the outcome. With
 * FAKE_LBX_TOOL_CALL set to a tools/call params object, it first plays Pi's
 * plugin: it opens an MCP session through the tools.sock in the
 * --socket-dir directory, makes that call and records the reply.
 * "{{reply}}" in FAKE_LBX_ANSWER stands for the reply's text, JSON-escaped.
 * With FAKE_LBX_MODEL_CALL set to a request body, it plays Pi calling the
 * model through model.sock in the --socket-dir directory and records the
 * reply.
 *
 * A launch whose run name ends in -repair (the runner's repair turn) records
 * into seen-repair.json instead, and answers FAKE_LBX_REPAIR_ANSWER when set.
 *
 * Without a command (no --) it answers the runner's probe for --socket-dir and
 * --no-network the way an lbx that has them does, or with
 * FAKE_LBX_NO_SOCKETS set the way an older lbx does, and notes each probe
 * in probes.json.
 */
export function writeFakeLbx(dir: string): string {
  const path = join(dir, "fake-lbx");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
if (!argv.includes("--")) {
  const probes = path.join(${JSON.stringify(dir)}, "probes.json");
  const seen = fs.existsSync(probes) ? JSON.parse(fs.readFileSync(probes, "utf8")) : [];
  seen.push(argv);
  fs.writeFileSync(probes, JSON.stringify(seen));
  process.stderr.write(
    process.env.FAKE_LBX_NO_SOCKETS !== undefined
      ? "ERROR: Unknown option: " + argv[0] + "\\nUsage: lbx ...\\n"
      : "ERROR: " + argv[0] + " is only valid with --run.\\n",
  );
  process.exit(1);
}
const sep = argv.indexOf("--");
const name = argv[sep - 1];
const data = argv[argv.indexOf("--data") + 1];
const socketDir = argv.includes("--socket-dir") ? argv[argv.indexOf("--socket-dir") + 1] : null;
const state = process.env.LLMBOX_STATE_DIR;
const TOOL_SECRETS = ${JSON.stringify(toolSecretEnv())};
const entries = (dir) =>
  fs.readdirSync(dir).sort().map((n) => {
    const s = fs.lstatSync(path.join(dir, n));
    return { name: n, socket: s.isSocket(), uid: s.uid };
  });
const seen = {
  argv,
  hasIssuerKey: process.env.LLM_GATEWAY_ISSUER_KEY !== undefined,
  envNames: Object.keys(process.env).sort(),
  socketDir,
  socketEntries: socketDir === null ? null : entries(socketDir),
  socketDirMode: socketDir === null ? null : fs.statSync(socketDir).mode & 0o777,
  socketExists: socketDir !== null && fs.existsSync(path.join(socketDir, "model.sock")),
  dataFiles: data !== undefined && fs.existsSync(data) ? fs.readdirSync(data).sort() : [],
  at: Date.now(),
  toolSecrets: TOOL_SECRETS.filter((n) => process.env[n] !== undefined),
  config: fs.readFileSync(process.env.LLMBOX_CONFIG, "utf8"),
};
if (process.env.FAKE_LBX_MODEL_CALL !== undefined) {
  const call = require("node:child_process").spawnSync(
    process.execPath,
    [path.join(${JSON.stringify(dir)}, "model-call.js"), path.join(socketDir, "model.sock"), process.env.FAKE_LBX_MODEL_CALL],
    { encoding: "utf8" },
  );
  seen.modelReply = JSON.parse(call.stdout || "null");
}
let replyText = "";
if (process.env.FAKE_LBX_TOOL_CALL !== undefined && socketDir !== null) {
  const call = require("node:child_process").spawnSync(
    process.execPath,
    [path.join(${JSON.stringify(dir)}, "tool-call.js"), path.join(socketDir, "tools.sock"), process.env.FAKE_LBX_TOOL_CALL],
    { encoding: "utf8" },
  );
  const got = JSON.parse(call.stdout || "{}");
  seen.initialize = got.initialize;
  seen.reply = got.reply;
  seen.toolCallError = got.error ?? null;
  replyText = ((seen.reply && seen.reply.result && seen.reply.result.content) || []).map((c) => c.text).join("\\n");
}
const repair = name.endsWith("-repair");
fs.writeFileSync(path.join(${JSON.stringify(dir)}, repair ? "seen-repair.json" : "seen.json"), JSON.stringify(seen));
const answer = (repair ? process.env.FAKE_LBX_REPAIR_ANSWER : undefined) ?? process.env.FAKE_LBX_ANSWER;
if (answer !== undefined)
  fs.writeFileSync(
    path.join(data, "answer.txt"),
    answer.replace("{{reply}}", JSON.stringify(replyText).slice(1, -1)),
  );
fs.mkdirSync(path.join(data, "session"), { recursive: true });
fs.writeFileSync(path.join(data, "session", "s.jsonl"), '{"type":"session"}\\n');
const status = process.env.FAKE_LBX_STATUS ?? "status=exited code=0";
const code = Number(/code=(\\d+)/.exec(status)[1]) || (status.includes("cleanup=incomplete") ? 125 : 0);
if (process.env.FAKE_LBX_NO_FILE === undefined) {
  fs.mkdirSync(path.join(state, "runs", name), { recursive: true });
  fs.writeFileSync(path.join(state, "runs", name, "status"), status + "\\n");
}
process.stdout.write("pi output\\n");
process.stderr.write("\\nlbx-run: " + status + "\\n");
process.exit(code);
`;
  writeFileSync(
    join(dir, "model-call.js"),
    `const http = require("node:http");
const req = http.request(
  {
    socketPath: process.argv[2],
    path: "/v1/messages",
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "box-made-this-up", "anthropic-version": "2023-06-01" },
  },
  (res) => {
    let t = "";
    res.on("data", (c) => (t += c));
    res.on("end", () => process.stdout.write(JSON.stringify({ status: res.statusCode, body: t })));
  },
);
req.on("error", (e) => process.stdout.write(JSON.stringify({ error: e.code })));
req.end(process.argv[3]);
`,
  );
  writeFileSync(
    join(dir, "tool-call.js"),
    `const net = require("node:net");
const socket = net.connect(process.argv[2]);
const out = {};
let buffer = "";
const waiting = new Map();
const send = (m) => socket.write(JSON.stringify(m) + "\\n");
const request = (id, method, params) =>
  new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
socket.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) !== -1) {
    const m = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    waiting.get(m.id)?.(m);
  }
});
socket.on("error", (e) => {
  out.error = e.code;
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
});
socket.on("connect", async () => {
  out.initialize = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-pi", version: "0" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  out.reply = await request(2, "tools/call", JSON.parse(process.argv[3]));
  process.stdout.write(JSON.stringify(out));
  socket.end();
});
`,
  );
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}
