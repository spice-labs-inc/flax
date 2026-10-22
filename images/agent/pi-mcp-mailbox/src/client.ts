import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import {
  isObject,
  isRequestId,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_SEQUENCE,
  messageFile,
  readMessage,
  TO_BOX,
  TO_SERVER,
  writeMessage,
} from "./protocol.ts";

export const CLIENT_POLL_MS = 100;

export interface MailboxClientOptions {
  /** The mailbox directory. */
  dir: string;
  pollMs?: number;
}

function directoryProblem(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `${path} is a symbolic link`;
    if (!stat.isDirectory()) return `${path} is not a directory`;
    return undefined;
  } catch {
    return `${path} does not exist`;
  }
}

/**
 * The client end of the mailbox, as an MCP client transport; collect.ts
 * reaches its tools server through it. Each outgoing
 * message becomes the next file in to-server/. While a request is waiting,
 * the transport polls to-box/ for the server's next file, and hands on only
 * the responses to requests it sent: anything else in to-box/ is dropped.
 */
export class MailboxClientTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;

  private readonly toServer: string;
  private readonly toBox: string;
  private readonly pollMs: number;
  private readonly waiting = new Set<string | number>();
  private sent = 0;
  private received = 0;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: MailboxClientOptions) {
    const dir = options.dir;
    this.toServer = join(dir, TO_SERVER);
    this.toBox = join(dir, TO_BOX);
    this.pollMs = options.pollMs ?? CLIENT_POLL_MS;
  }

  start(): Promise<void> {
    for (const dir of [this.toServer, this.toBox]) {
      const problem = directoryProblem(dir);
      if (problem !== undefined)
        return Promise.reject(new Error(`no tools mailbox: ${problem}`));
    }
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error("the mailbox is closed"));
    const text = JSON.stringify(message);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_REQUEST_BYTES)
      return Promise.reject(
        new Error(
          `the request is ${bytes} bytes, over the ${MAX_REQUEST_BYTES} byte limit`,
        ),
      );
    try {
      writeMessage(this.toServer, this.sent + 1, text);
    } catch (err) {
      return Promise.reject(err as Error);
    }
    this.sent += 1;
    const m = message as Record<string, unknown>;
    if (typeof m.method === "string" && isRequestId(m.id)) {
      this.waiting.add(m.id);
      this.schedule();
    } else if (
      m.method === "notifications/cancelled" &&
      isObject(m.params) &&
      isRequestId(m.params.requestId)
    ) {
      // A late answer to a request the SDK gave up on is not wanted either.
      this.waiting.delete(m.params.requestId);
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.waiting.clear();
    this.onclose?.();
    return Promise.resolve();
  }

  private schedule(): void {
    if (this.timer !== undefined || this.closed || this.waiting.size === 0)
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.poll();
      this.schedule();
    }, this.pollMs);
  }

  /** Takes every file the server has written since the last poll, in order. */
  private poll(): void {
    while (!this.closed && this.received < MAX_SEQUENCE) {
      const path = join(this.toBox, messageFile(this.received + 1));
      const file = readMessage(path, MAX_RESPONSE_BYTES);
      if ("error" in file && file.error === "does not exist") return;
      this.received += 1;
      if ("error" in file) {
        this.onerror?.(new Error(`${path} ${file.error}`));
        continue;
      }
      let message: unknown;
      try {
        message = JSON.parse(file.text);
      } catch {
        this.onerror?.(new Error(`${path} is not JSON`));
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
