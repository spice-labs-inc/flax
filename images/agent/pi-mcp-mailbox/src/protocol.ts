import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The mailbox between collect.ts and the tools server the runner starts for
 * it: two directories in a run directory outside the data directory, one
 * MCP (JSON-RPC) message per file, named by a sequence number that each
 * writer counts up from 1. Both ends import this file, so the layout and
 * limits cannot drift apart. The box never uses it: Pi's plugin reaches its
 * tools over the tools socket, which shares the limits below. "Box" in the
 * names below means the client side.
 */
export const MAILBOX_DIR = "mcp";
export const TO_SERVER = "to-server";
export const TO_BOX = "to-box";

/** Largest message file the client may write. */
export const MAX_REQUEST_BYTES = 64 * 1024;
/** Largest message file the tools server writes. */
export const MAX_RESPONSE_BYTES = 256 * 1024;

const DIGITS = 6;
export const MAX_SEQUENCE = 10 ** DIGITS - 1;
const MESSAGE_FILE = new RegExp(`^(\\d{${DIGITS}})\\.json$`);

export function messageFile(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_SEQUENCE)
    throw new Error(`message sequence ${seq} is out of range`);
  return `${String(seq).padStart(DIGITS, "0")}.json`;
}

/** The sequence number a message file carries, or undefined for any other name. */
export function parseMessageFile(name: string): number | undefined {
  const m = MESSAGE_FILE.exec(name);
  if (m === null) return undefined;
  const seq = Number(m[1]);
  return seq >= 1 ? seq : undefined;
}

/** In-progress writes start with a dot, so a reader never takes one for a message. */
export function isInProgress(name: string): boolean {
  return name.startsWith(".");
}

/**
 * Writes one message so a reader sees all of it or nothing: a new file
 * that must not exist yet (which also refuses a planted link), then a
 * rename to its final name.
 */
export function writeMessage(dir: string, seq: number, text: string): void {
  const name = messageFile(seq);
  const tmp = join(dir, `.${name}.tmp`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const data = Buffer.from(text, "utf8");
    let written = 0;
    while (written < data.length)
      written += writeSync(fd, data, written, data.length - written);
  } catch (err) {
    closeSync(fd);
    unlinkSync(tmp);
    throw err;
  }
  closeSync(fd);
  renameSync(tmp, join(dir, name));
}

/**
 * Reads one message file: never through a link, only a regular file with a
 * single name, and at most maxBytes. The same rules as the kit's
 * readUntrusted (src/run-job/untrusted.ts), which the box cannot import.
 */
export function readMessage(
  path: string,
  maxBytes: number,
): { text: string } | { error: string } {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { error: "does not exist" };
    if (code === "ELOOP") return { error: "is a symbolic link" };
    return { error: `cannot be opened (${code ?? "unknown error"})` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { error: "is not a regular file" };
    if (stat.nlink !== 1)
      return { error: `has ${stat.nlink} hard links; only one is allowed` };
    if (stat.size > maxBytes)
      return {
        error: `is ${stat.size} bytes, over the ${maxBytes} byte limit`,
      };
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buffer, read, stat.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return { text: buffer.subarray(0, read).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON-RPC id the SDK can produce: a string or a whole number. */
export function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || Number.isSafeInteger(value);
}
