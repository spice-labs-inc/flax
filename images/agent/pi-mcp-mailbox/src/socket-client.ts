import { connect, type Socket } from "node:net";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import {
  isObject,
  isRequestId,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
} from "./protocol.ts";
import { LineReader } from "./sockets.ts";

/**
 * The box end of the tools socket, as an MCP client transport: one
 * newline-delimited JSON-RPC message per line over the Unix socket the
 * runner serves in /run/agent, with the mailbox's limits (requests up to
 * 64 KB, replies up to 256 KB). Like the mailbox client, it hands on only
 * the responses to requests it sent and drops anything else.
 */
export class SocketClientTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;

  private readonly path: string;
  private readonly waiting = new Set<string | number>();
  private readonly reader = new LineReader(MAX_RESPONSE_BYTES);
  private socket: Socket | undefined;
  private closed = false;

  constructor(path: string) {
    this.path = path;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.path);
      const failed = (err: Error) =>
        reject(new Error(`no tools socket: ${this.path}: ${err.message}`));
      socket.once("error", failed);
      socket.once("connect", () => {
        socket.off("error", failed);
        socket.on("error", (err) => this.onerror?.(err));
        resolve();
      });
      socket.on("data", (chunk: Buffer) => this.receive(chunk));
      socket.on("close", () => void this.close());
      this.socket = socket;
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.socket === undefined)
      return Promise.reject(new Error("the tools socket is closed"));
    const text = JSON.stringify(message);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_REQUEST_BYTES)
      return Promise.reject(
        new Error(
          `the request is ${bytes} bytes, over the ${MAX_REQUEST_BYTES} byte limit`,
        ),
      );
    const m = message as Record<string, unknown>;
    if (typeof m.method === "string" && isRequestId(m.id)) {
      this.waiting.add(m.id);
    } else if (
      m.method === "notifications/cancelled" &&
      isObject(m.params) &&
      isRequestId(m.params.requestId)
    ) {
      this.waiting.delete(m.params.requestId);
    }
    this.socket.write(`${text}\n`);
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.waiting.clear();
    this.socket?.destroy();
    this.onclose?.();
    return Promise.resolve();
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    const read = this.reader.push(chunk);
    if ("error" in read) {
      this.onerror?.(new Error(`the tools server sent ${read.error}`));
      void this.close();
      return;
    }
    for (const line of read.lines) {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.onerror?.(
          new Error("the tools server sent a line that is not JSON"),
        );
        continue;
      }
      if (
        !isObject(message) ||
        message.jsonrpc !== "2.0" ||
        "method" in message ||
        !isRequestId(message.id) ||
        !this.waiting.has(message.id)
      )
        continue;
      this.waiting.delete(message.id);
      this.onmessage?.(message as JSONRPCMessage);
    }
  }
}
