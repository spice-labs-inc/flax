import { chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import {
  isRequestId,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
} from "../../images/agent/pi-mcp-mailbox/src/protocol.ts";
import { LineReader } from "../../images/agent/pi-mcp-mailbox/src/sockets.ts";
import { firstLine } from "../lib/problem.ts";
import { IncomingChecker } from "./incoming.ts";

export interface SocketEvent {
  at: string;
  /** The message's number in the order the box sent them, when there is one. */
  message?: number;
  kind: "refused" | "error";
  reason: string;
}

/** Every message that went over the socket, in order, for the run report. */
export interface SocketRecord {
  /** Lines the box sent, whether or not they were accepted. */
  in: string[];
  /** Replies the server sent. */
  out: string[];
}

export interface SocketServerOptions {
  /** Where to listen: a Unix socket in the run's socket directory. */
  socketPath: string;
  /**
   * The most messages the box may send over a run. Past it the session
   * closes, so a box cannot keep the server busy with an endless stream.
   */
  maxMessages: number;
  /**
   * The record of the session before, for a later box of the same run:
   * this session's messages go on in it, and count against the same
   * maxMessages.
   */
  record?: SocketRecord;
  onEvent?: (event: SocketEvent) => void;
  now?: () => Date;
}

/**
 * The runner end of the tools socket, as an MCP server transport: one
 * session, over the first connection, of newline-delimited JSON-RPC
 * messages. The limits are the mailbox's: at most 64 KB per message from
 * the box (a longer line ends the session before it is buffered whole),
 * 256 KB per reply, and a message count over the run. Every message passes
 * the same checks as the mailbox's (IncomingChecker) before the MCP server
 * sees it; anything else is refused and recorded. A second connection is
 * refused while the first is open and after it closes.
 */
export class SocketServerTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;

  readonly record: SocketRecord;

  private readonly options: SocketServerOptions;
  private readonly checker = new IncomingChecker();
  private readonly reader = new LineReader(MAX_REQUEST_BYTES);
  private server: Server | undefined;
  private session: Socket | undefined;
  private sessionUsed = false;
  private received: number;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(options: SocketServerOptions) {
    this.options = options;
    this.record = options.record ?? { in: [], out: [] };
    this.received = this.record.in.length;
  }

  /** Whether a box has connected; its session is over once it disconnects. */
  get used(): boolean {
    return this.sessionUsed;
  }

  async start(): Promise<void> {
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(this.options.socketPath, 0o600);
    server.on("error", (err) =>
      this.event("error", `the tools socket failed: ${firstLine(err)}`),
    );
    this.server = server;
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.session === undefined)
      return Promise.reject(new Error("the tools socket is closed"));
    let text = JSON.stringify(message);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_RESPONSE_BYTES) {
      const id = (message as { id?: unknown }).id;
      const reason = `a reply of ${bytes} bytes is over the ${MAX_RESPONSE_BYTES} byte limit`;
      this.event("refused", reason);
      if (!isRequestId(id)) return Promise.resolve();
      text = JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: reason },
      });
    }
    this.record.out.push(text);
    this.session.write(`${text}\n`);
    return Promise.resolve();
  }

  /** Ends the session and stops listening, which removes the socket; resolves once both are done. */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.session?.destroy();
    const server = this.server;
    this.server = undefined;
    this.closing = new Promise<void>((resolve) => {
      if (server === undefined) resolve();
      else server.close(() => resolve());
    }).then(() => this.onclose?.());
    return this.closing;
  }

  private accept(socket: Socket): void {
    if (this.closed || this.sessionUsed) {
      this.event(
        "refused",
        "a second connection was refused; the tools socket serves one session per box",
      );
      socket.destroy();
      return;
    }
    this.sessionUsed = true;
    this.session = socket;
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (err) =>
      this.event("error", `the session failed: ${firstLine(err)}`),
    );
    socket.on("close", () => void this.close());
  }

  private event(kind: SocketEvent["kind"], reason: string, n?: number): void {
    this.options.onEvent?.({
      at: (this.options.now?.() ?? new Date()).toISOString(),
      ...(n === undefined ? {} : { message: n }),
      kind,
      reason,
    });
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    const read = this.reader.push(chunk);
    if ("error" in read) {
      this.event(
        "refused",
        `the box sent ${read.error}; the session is closed`,
      );
      void this.close();
      return;
    }
    for (const line of read.lines) {
      if (this.closed) return;
      this.received += 1;
      const n = this.received;
      if (n > this.options.maxMessages) {
        this.event(
          "refused",
          `the box sent more than ${this.options.maxMessages} messages this run; the session is closed`,
          n,
        );
        void this.close();
        return;
      }
      this.record.in.push(line);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (err) {
        this.event("refused", `is not JSON: ${firstLine(err)}`, n);
        continue;
      }
      const incoming = this.checker.check(value);
      if ("refused" in incoming) {
        this.event("refused", incoming.refused, n);
        if (incoming.reply !== undefined) void this.send(incoming.reply);
        continue;
      }
      this.onmessage?.(incoming.message);
    }
  }
}
