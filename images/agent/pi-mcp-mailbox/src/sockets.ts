/**
 * The socket transport between the box and the runner: lbx --socket-dir
 * mounts a directory the runner owns, read-only, at /run/agent in a box
 * that has no network. The runner serves two sockets there: the model
 * forwarder and the tools server. Both ends import this file, so the
 * names, the port and the framing cannot drift apart.
 */
export const BOX_SOCKET_DIR = "/run/agent";
export const MODEL_SOCKET = "model.sock";
export const TOOLS_SOCKET = "tools.sock";

/**
 * Pi's model provider reaches the model with fetch() on FLAX_AGENTS_MODEL_BASE_URL, and
 * fetch() cannot dial a Unix socket. So in the box a shim listens on this
 * loopback port and passes every connection through to the model socket
 * unchanged. The box has its own network namespace, so the port is free.
 */
export const MODEL_SHIM_HOST = "127.0.0.1";
export const MODEL_SHIM_PORT = 18080;
export const MODEL_SHIM_URL = `http://${MODEL_SHIM_HOST}:${MODEL_SHIM_PORT}`;

const NEWLINE = 0x0a;

/**
 * Splits a byte stream into newline-delimited messages (the framing MCP's
 * stdio transport uses), refusing any message longer than maxBytes before
 * it is buffered whole, so a peer cannot grow the buffer without end.
 */
export class LineReader {
  private readonly maxBytes: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer): { lines: string[] } | { error: string } {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(NEWLINE, start);
      if (end === -1) break;
      const bytes = this.pendingBytes + end - start;
      if (bytes > this.maxBytes) return this.tooLong(bytes);
      lines.push(
        Buffer.concat([...this.pending, chunk.subarray(start, end)]).toString(
          "utf8",
        ),
      );
      this.pending = [];
      this.pendingBytes = 0;
      start = end + 1;
    }
    if (start < chunk.length) {
      this.pendingBytes += chunk.length - start;
      if (this.pendingBytes > this.maxBytes)
        return this.tooLong(this.pendingBytes);
      this.pending.push(chunk.subarray(start));
    }
    return { lines };
  }

  private tooLong(bytes: number): { error: string } {
    this.pending = [];
    this.pendingBytes = 0;
    return {
      error: `a message of more than ${this.maxBytes} bytes (${bytes} so far) is over the limit`,
    };
  }
}
