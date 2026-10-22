import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import {
  isInProgress,
  isRequestId,
  MAILBOX_DIR,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  parseMessageFile,
  TO_BOX,
  TO_SERVER,
  writeMessage,
} from "../../images/agent/pi-mcp-mailbox/src/protocol.ts";
import { firstLine } from "../lib/problem.ts";
import { readUntrusted } from "../run-job/untrusted.ts";
import { IncomingChecker } from "./incoming.ts";

/** How often to-server/ is listed when no change notice arrives. */
export const SERVER_POLL_MS = 250;

export interface MailboxEvent {
  at: string;
  /** The message file, relative to the mailbox directory, when there is one. */
  file?: string;
  kind: "refused" | "error";
  reason: string;
}

/**
 * Creates the mailbox in the data directory, before the box starts: the
 * directory the box writes requests into and the one it reads replies from.
 */
export function createMailbox(dataDir: string): string {
  const root = join(dataDir, MAILBOX_DIR);
  for (const dir of [root, join(root, TO_SERVER), join(root, TO_BOX)]) {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return root;
}

function openDir(path: string): number {
  return openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
}

/**
 * A path through an open directory descriptor. The box can rename or
 * replace anything in the data directory, including the mailbox
 * directories themselves; going through the descriptor keeps every read
 * and write in the directory that was opened, never somewhere a link
 * planted later points to.
 */
export function viaFd(fd: number, name?: string): string {
  return name === undefined
    ? `/proc/self/fd/${fd}`
    : `/proc/self/fd/${fd}/${name}`;
}

/**
 * Opens to-server/ and to-box/ one level at a time from the data
 * directory, refusing a link at every level. The caller closes both.
 */
export function openMailbox(dataDir: string): {
  toServer: number;
  toBox: number;
} {
  const data = openDir(dataDir);
  let mcp: number;
  try {
    mcp = openDir(viaFd(data, MAILBOX_DIR));
  } finally {
    closeSync(data);
  }
  let toServer: number | undefined;
  try {
    toServer = openDir(viaFd(mcp, TO_SERVER));
    return { toServer, toBox: openDir(viaFd(mcp, TO_BOX)) };
  } catch (err) {
    if (toServer !== undefined) closeSync(toServer);
    throw err;
  } finally {
    closeSync(mcp);
  }
}

export interface MailboxServerOptions {
  /** The run's data directory on the runner; the box sees it as /data. */
  dataDir: string;
  pollMs?: number;
  /**
   * The most files to-server/ may hold over a run. Past it the mailbox
   * closes, so a box cannot keep the server busy with an endless stream.
   */
  maxFiles: number;
  onEvent?: (event: MailboxEvent) => void;
  now?: () => Date;
}

/**
 * The runner end of the mailbox, as an MCP server transport. Every file in
 * to-server/ is written by the box and read as untrusted: no links, regular
 * files with one name only, at most 64 KB, valid JSON-RPC, sequence numbers
 * that only go up and request ids that never repeat. Anything else is
 * refused and recorded, and never reaches the MCP server. Replies go to
 * to-box/, at most 256 KB each.
 */
export class MailboxServerTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;

  private readonly options: MailboxServerOptions;
  private inFd: number | undefined;
  private outFd: number | undefined;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastSeq = 0;
  private sent = 0;
  private readonly seen = new Set<string>();
  private readonly checker = new IncomingChecker();
  private closed = false;
  private scanQueued = false;

  constructor(options: MailboxServerOptions) {
    this.options = options;
  }

  // async, so a mailbox that cannot be opened rejects rather than throws.
  async start(): Promise<void> {
    const { toServer, toBox } = openMailbox(this.options.dataDir);
    this.inFd = toServer;
    this.outFd = toBox;
    try {
      // A burst of change notices becomes one scan, so timers and replies still get their turn.
      this.watcher = watch(viaFd(this.inFd), () => this.scanSoon());
      this.watcher.on("error", () => this.stopWatching());
    } catch {
      // Polling alone still finds every file, a little later.
    }
    this.timer = setInterval(
      () => this.scan(),
      this.options.pollMs ?? SERVER_POLL_MS,
    );
    this.scan();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.outFd === undefined)
      return Promise.reject(new Error("the mailbox is closed"));
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
    try {
      writeMessage(viaFd(this.outFd), this.sent + 1, text);
    } catch (err) {
      this.event(
        "error",
        `cannot write reply ${this.sent + 1}: ${firstLine(err)}`,
      );
      return Promise.reject(err as Error);
    }
    this.sent += 1;
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.stopWatching();
    for (const fd of [this.inFd, this.outFd])
      if (fd !== undefined) closeSync(fd);
    this.inFd = undefined;
    this.outFd = undefined;
    this.onclose?.();
    return Promise.resolve();
  }

  private stopWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private event(
    kind: MailboxEvent["kind"],
    reason: string,
    name?: string,
  ): void {
    this.options.onEvent?.({
      at: (this.options.now?.() ?? new Date()).toISOString(),
      ...(name === undefined ? {} : { file: `${TO_SERVER}/${name}` }),
      kind,
      reason,
    });
  }

  /** Takes each new file in to-server/ once, in sequence order. */
  private scanSoon(): void {
    if (this.scanQueued) return;
    this.scanQueued = true;
    setImmediate(() => {
      this.scanQueued = false;
      this.scan();
    });
  }

  private scan(): void {
    if (this.closed || this.inFd === undefined) return;
    let names: string[];
    try {
      names = readdirSync(viaFd(this.inFd));
    } catch (err) {
      this.event("error", `cannot list ${TO_SERVER}/: ${firstLine(err)}`);
      return;
    }
    // Every entry counts, in-progress names too, so no kind of name makes a scan slow.
    if (names.length > this.options.maxFiles) {
      this.event(
        "refused",
        `${TO_SERVER}/ holds more than ${this.options.maxFiles} entries; the mailbox is closed`,
      );
      void this.close();
      return;
    }
    const fresh: { seq: number; name: string }[] = [];
    for (const name of names) {
      if (isInProgress(name) || this.seen.has(name)) continue;
      this.seen.add(name);
      if (this.seen.size > this.options.maxFiles) {
        this.event(
          "refused",
          `${TO_SERVER}/ has held more than ${this.options.maxFiles} files this run; the mailbox is closed`,
        );
        void this.close();
        return;
      }
      const seq = parseMessageFile(name);
      if (seq === undefined) {
        this.event(
          "refused",
          "is not named like a message (000001.json)",
          name,
        );
      } else if (seq <= this.lastSeq) {
        this.event(
          "refused",
          `came after message ${this.lastSeq}; sequence numbers must go up`,
          name,
        );
      } else {
        fresh.push({ seq, name });
      }
    }
    fresh.sort((a, b) => a.seq - b.seq);
    for (const { seq, name } of fresh) {
      if (this.closed) return;
      this.lastSeq = seq;
      this.receive(name);
    }
  }

  private receive(name: string): void {
    const file = readUntrusted(viaFd(this.inFd!, name), MAX_REQUEST_BYTES, {
      singleLink: true,
    });
    if ("error" in file) return this.event("refused", file.error, name);
    let value: unknown;
    try {
      value = JSON.parse(file.text);
    } catch (err) {
      return this.event("refused", `is not JSON: ${firstLine(err)}`, name);
    }
    const incoming = this.checker.check(value);
    if ("refused" in incoming) {
      this.event("refused", incoming.refused, name);
      if (incoming.reply !== undefined) void this.send(incoming.reply);
      return;
    }
    this.onmessage?.(incoming.message);
  }
}
