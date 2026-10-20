import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import fc from "fast-check";
import { describe, expect, it, onTestFinished } from "vitest";
import { MailboxClientTransport } from "../images/agent/pi-mcp-mailbox/src/client.ts";
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_SEQUENCE,
  messageFile,
  parseMessageFile,
  writeMessage,
} from "../images/agent/pi-mcp-mailbox/src/protocol.ts";
import {
  createMailbox,
  MailboxServerTransport,
  type MailboxEvent,
} from "../src/tools-server/mailbox.ts";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-mailbox-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function request(id: number | string, method = "tools/list"): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method });
}

/** A data directory with a mailbox and a started server transport on it. */
async function serverSide(maxFiles = 100) {
  const data = scratch();
  const mailbox = createMailbox(data);
  const received: JSONRPCMessage[] = [];
  const events: MailboxEvent[] = [];
  const transport = new MailboxServerTransport({
    dataDir: data,
    pollMs: 10,
    maxFiles,
    onEvent: (e) => events.push(e),
  });
  transport.onmessage = (m) => received.push(m);
  await transport.start();
  onTestFinished(() => transport.close());
  const inbox = join(mailbox, "to-server");
  const outbox = join(mailbox, "to-box");
  return {
    data,
    mailbox,
    inbox,
    outbox,
    transport,
    received,
    events,
    reasons: () => events.map((e) => `${e.file ?? ""}: ${e.reason}`),
    put: (seq: number, text: string) => writeMessage(inbox, seq, text),
  };
}

describe("mailbox files", () => {
  it("are named by a six-digit sequence number and nothing else", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_SEQUENCE }), (seq) => {
        expect(parseMessageFile(messageFile(seq))).toBe(seq);
      }),
    );
    for (const name of [
      "000000.json",
      "1.json",
      "0000001.json",
      "000001.json.tmp",
      ".000001.json.tmp",
      "000001.JSON",
      "00000a.json",
    ])
      expect(parseMessageFile(name)).toBeUndefined();
    expect(() => messageFile(0)).toThrow("out of range");
    expect(() => messageFile(MAX_SEQUENCE + 1)).toThrow("out of range");
  });

  it("are written whole, private, with nothing left behind", () => {
    const dir = scratch();
    writeMessage(dir, 1, '{"a":1}');
    expect(readdirSync(dir)).toEqual(["000001.json"]);
    expect(readFileSync(join(dir, "000001.json"), "utf8")).toBe('{"a":1}');
    expect(statSync(join(dir, "000001.json")).mode & 0o777).toBe(0o600);
  });

  it("are never written through a planted link", () => {
    const dir = scratch();
    const victim = join(scratch(), "victim");
    writeFileSync(victim, "untouched");
    symlinkSync(victim, join(dir, ".000001.json.tmp"));
    expect(() => writeMessage(dir, 1, "x")).toThrow(/EEXIST/);
    expect(readFileSync(victim, "utf8")).toBe("untouched");
  });
});

describe("the server end of the mailbox", () => {
  it("hands on a request and writes the reply as the next file in to-box/", async () => {
    const s = await serverSide();
    s.put(1, request(1));
    await waitFor(() => s.received.length === 1);
    expect(s.received[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    await s.transport.send({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(
      JSON.parse(readFileSync(join(s.outbox, "000001.json"), "utf8")),
    ).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(s.events).toEqual([]);
  });

  it("finds a new file by change notice, without waiting for the next poll", async () => {
    const data = scratch();
    const mailbox = createMailbox(data);
    const t = new MailboxServerTransport({
      dataDir: data,
      pollMs: 60_000,
      maxFiles: 10,
    });
    const received: JSONRPCMessage[] = [];
    t.onmessage = (m) => received.push(m);
    await t.start();
    onTestFinished(() => t.close());
    writeMessage(join(mailbox, "to-server"), 1, request(1, "ping"));
    await waitFor(() => received.length === 1);
  });

  it("refuses malformed JSON and files over 64 KB", async () => {
    const s = await serverSide();
    s.put(1, "{not json");
    const big = JSON.stringify({
      jsonrpc: "2.0",
      method: "x",
      params: { pad: "a".repeat(MAX_REQUEST_BYTES) },
    });
    s.put(2, big);
    s.put(3, request(3));
    await waitFor(() => s.received.length === 1);
    expect(s.reasons()).toEqual([
      expect.stringMatching(/^to-server\/000001\.json: is not JSON: /),
      `to-server/000002.json: is ${big.length} bytes, over the ${MAX_REQUEST_BYTES} byte limit`,
    ]);
    expect(s.received).toEqual([
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
    ]);
  });

  it("never follows a symbolic link, reads a hard link, a pipe or a directory", async () => {
    const s = await serverSide();
    const outside = join(scratch(), "request.json");
    writeFileSync(outside, request(1));
    symlinkSync(outside, join(s.inbox, "000001.json"));
    linkSync(outside, join(s.inbox, "000002.json"));
    execFileSync("mkfifo", [join(s.inbox, "000003.json")]);
    mkdirSync(join(s.inbox, "000004.json"));
    s.put(5, request(5));
    await waitFor(() => s.received.length === 1);
    expect(s.reasons()).toEqual([
      "to-server/000001.json: is a symbolic link",
      "to-server/000002.json: has 2 hard links; only one is allowed",
      "to-server/000003.json: is not a regular file",
      "to-server/000004.json: is not a regular file",
    ]);
    expect(s.received).toEqual([
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
    ]);
  });

  it("refuses a message that comes after a later one, and never reads a file twice", async () => {
    const s = await serverSide();
    s.put(3, request(3));
    await waitFor(() => s.received.length === 1);
    s.put(2, request(2));
    // Replacing a file already taken changes nothing.
    writeFileSync(join(s.inbox, ".x"), request(99));
    renameSync(join(s.inbox, ".x"), join(s.inbox, "000003.json"));
    s.put(4, request(4));
    await waitFor(() => s.received.length === 2);
    await settle();
    expect(s.received.map((m) => (m as { id: number }).id)).toEqual([3, 4]);
    expect(s.reasons()).toEqual([
      "to-server/000002.json: came after message 3; sequence numbers must go up",
    ]);
  });

  it("takes files that arrive together in sequence order", async () => {
    const s = await serverSide();
    s.transport.onmessage = undefined;
    await s.transport.close();
    for (const seq of [5, 2, 9, 1]) writeMessage(s.inbox, seq, request(seq));
    const t = new MailboxServerTransport({
      dataDir: s.data,
      pollMs: 10,
      maxFiles: 100,
    });
    const ids: unknown[] = [];
    t.onmessage = (m) => ids.push((m as { id: unknown }).id);
    await t.start();
    onTestFinished(() => t.close());
    expect(ids).toEqual([1, 2, 5, 9]);
  });

  it("refuses a repeated request id, a response, junk names and invalid JSON-RPC", async () => {
    const s = await serverSide();
    s.put(1, request(7));
    s.put(2, request(7, "tools/call"));
    s.put(3, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    s.put(4, JSON.stringify({ jsonrpc: "1.0", id: 8, method: "tools/list" }));
    writeFileSync(join(s.inbox, "notes.txt"), "hi");
    writeFileSync(join(s.inbox, ".000009.json.tmp"), "half");
    s.put(
      5,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    await waitFor(() => s.received.length === 2);
    await settle();
    expect(s.received).toEqual([
      { jsonrpc: "2.0", id: 7, method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(s.reasons().sort()).toEqual([
      "to-server/000002.json: repeats request id 7",
      "to-server/000003.json: is not a JSON-RPC request or notification; the server sends no requests, so it takes no responses",
      "to-server/000004.json: is not a JSON-RPC request or notification; the server sends no requests, so it takes no responses",
      "to-server/notes.txt: is not named like a message (000001.json)",
    ]);
    // The malformed request is answered, so the box does not wait for it.
    expect(
      JSON.parse(readFileSync(join(s.outbox, "000001.json"), "utf8")),
    ).toEqual({
      jsonrpc: "2.0",
      id: 8,
      error: { code: -32600, message: "invalid JSON-RPC request" },
    });
  });

  it.each(["junk-", ".junk-"])(
    "closes when the box floods to-server/ with %s names",
    async (prefix) => {
      const s = await serverSide(5);
      let closed = false;
      s.transport.onclose = () => (closed = true);
      for (let i = 1; i <= 6; i++)
        writeFileSync(join(s.inbox, `${prefix}${i}`), "");
      await waitFor(() => closed);
      expect(s.reasons().at(-1)).toBe(
        ": to-server/ holds more than 5 entries; the mailbox is closed",
      );
      await expect(
        s.transport.send({ jsonrpc: "2.0", id: 1, result: {} }),
      ).rejects.toThrow("closed");
    },
  );

  it("closes when the box keeps replacing files it has had refused", async () => {
    const s = await serverSide(5);
    let closed = false;
    s.transport.onclose = () => (closed = true);
    for (let i = 1; i <= 3; i++) writeFileSync(join(s.inbox, `junk-${i}`), "");
    await waitFor(() => s.events.length === 3);
    for (let i = 1; i <= 3; i++) rmSync(join(s.inbox, `junk-${i}`));
    for (let i = 4; i <= 6; i++) writeFileSync(join(s.inbox, `junk-${i}`), "");
    await waitFor(() => closed);
    expect(s.reasons().at(-1)).toBe(
      ": to-server/ has held more than 5 files this run; the mailbox is closed",
    );
  });

  it("keeps the event loop running while the box rewrites a file as fast as it can", async () => {
    const data = scratch();
    const mailbox = createMailbox(data);
    const inbox = join(mailbox, "to-server");
    for (let i = 0; i < 3000; i++) writeFileSync(join(inbox, `.f${i}`), "");
    const t = new MailboxServerTransport({
      dataDir: data,
      pollMs: 10,
      maxFiles: 100_000,
    });
    await t.start();
    onTestFinished(() => t.close());
    let worst = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 10);
    onTestFinished(() => clearInterval(ticker));
    const storm = spawn(
      "bash",
      [
        "-c",
        "end=$((SECONDS+2)); while [ $SECONDS -lt $end ]; do echo x > .t; done",
      ],
      { cwd: inbox, stdio: "ignore" },
    );
    await new Promise((resolve) => storm.on("exit", resolve));
    expect(worst).toBeLessThan(500);
  }, 15_000);

  it("sends an error in place of a reply over 256 KB", async () => {
    const s = await serverSide();
    const big = {
      content: [{ type: "text", text: "a".repeat(MAX_RESPONSE_BYTES) }],
    };
    await s.transport.send({ jsonrpc: "2.0", id: 4, result: big });
    const reply = JSON.parse(
      readFileSync(join(s.outbox, "000001.json"), "utf8"),
    );
    expect(reply.id).toBe(4);
    expect(reply.error.message).toMatch(
      /^a reply of \d+ bytes is over the 262144 byte limit$/,
    );
    expect(s.events.map((e) => e.kind)).toEqual(["refused"]);
  });

  it("keeps writing into the directory it opened when the box swaps it for a link", async () => {
    const s = await serverSide();
    const elsewhere = scratch();
    renameSync(s.outbox, join(s.mailbox, "moved"));
    symlinkSync(elsewhere, s.outbox);
    await s.transport.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readdirSync(join(s.mailbox, "moved"))).toEqual(["000001.json"]);
  });

  it("refuses to start on a mailbox that is a link", async () => {
    const data = scratch();
    const real = createMailbox(scratch());
    symlinkSync(real, join(data, "mcp"));
    const t = new MailboxServerTransport({ dataDir: data, maxFiles: 10 });
    await expect(t.start()).rejects.toThrow(/ENOTDIR|ELOOP/);
  });
});

describe("the box end of the mailbox", () => {
  async function clientSide() {
    const data = scratch();
    const mailbox = createMailbox(data);
    const client = new MailboxClientTransport({ dir: mailbox, pollMs: 10 });
    const received: JSONRPCMessage[] = [];
    const errors: string[] = [];
    client.onmessage = (m) => received.push(m);
    client.onerror = (e) => errors.push(e.message);
    await client.start();
    onTestFinished(() => client.close());
    return {
      mailbox,
      client,
      received,
      errors,
      inbox: join(mailbox, "to-server"),
      reply: (seq: number, value: unknown) =>
        writeMessage(join(mailbox, "to-box"), seq, JSON.stringify(value)),
    };
  }

  it("will not start without a mailbox", async () => {
    const t = new MailboxClientTransport({ dir: join(scratch(), "mcp") });
    await expect(t.start()).rejects.toThrow("no tools mailbox:");
  });

  it("writes each message as the next file and refuses one over 64 KB", async () => {
    const c = await clientSide();
    await c.client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await c.client.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    await expect(
      c.client.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { text: "a".repeat(MAX_REQUEST_BYTES) },
        },
      }),
    ).rejects.toThrow(/over the 65536 byte limit$/);
    expect(readdirSync(c.inbox)).toEqual(["000001.json", "000002.json"]);
  });

  it("hands on only replies to requests it is waiting for", async () => {
    const c = await clientSide();
    await c.client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    c.reply(1, { jsonrpc: "2.0", id: 99, result: {} });
    c.reply(2, {
      jsonrpc: "2.0",
      id: 5,
      method: "sampling/createMessage",
      params: {},
    });
    c.reply(3, { jsonrpc: "2.0", id: 1, result: { tools: [] } });
    c.reply(4, { jsonrpc: "2.0", id: 1, result: { again: true } });
    await waitFor(() => c.received.length === 1);
    await settle();
    expect(c.received).toEqual([
      { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    ]);
  });

  it("skips a reply file it cannot read and goes on to the next", async () => {
    const c = await clientSide();
    await c.client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const outside = join(scratch(), "reply.json");
    writeFileSync(
      outside,
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { forged: true } }),
    );
    symlinkSync(outside, join(c.mailbox, "to-box", "000001.json"));
    c.reply(2, { jsonrpc: "2.0", id: 1, result: {} });
    await waitFor(() => c.received.length === 1);
    expect(c.received).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect(c.errors).toEqual([
      expect.stringMatching(/000001\.json is a symbolic link$/),
    ]);
  });

  it("stops waiting for a request it cancelled", async () => {
    const c = await clientSide();
    await c.client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo" },
    });
    await c.client.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    });
    await c.client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    c.reply(1, { jsonrpc: "2.0", id: 1, result: { late: true } });
    c.reply(2, { jsonrpc: "2.0", id: 2, result: { tools: [] } });
    await waitFor(() => c.received.length === 1);
    await settle();
    expect(c.received).toEqual([
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
  });

  it("reads nothing once closed", async () => {
    const c = await clientSide();
    await c.client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await c.client.close();
    c.reply(1, { jsonrpc: "2.0", id: 1, result: {} });
    await settle();
    expect(c.received).toEqual([]);
    await expect(
      c.client.send({ jsonrpc: "2.0", id: 2, method: "ping" }),
    ).rejects.toThrow("closed");
    expect(existsSync(join(c.inbox, "000002.json"))).toBe(false);
  });
});
