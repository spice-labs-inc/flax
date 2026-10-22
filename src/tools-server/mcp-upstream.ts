import type { Stream } from "node:stream";
import {
  Client,
  SdkError,
  SdkErrorCode,
  type CallToolResult,
  type Transport,
} from "@modelcontextprotocol/client";
import { SERVER_NAME, SERVER_VERSION } from "./server.ts";
import type { Upstream } from "./upstreams.ts";

/**
 * Longer than the longest per-call limit a job may set (tool_seconds, at
 * most 300), so the tools server's own limit is the one that ends a call.
 */
export const UPSTREAM_TIMEOUT_MS = 310_000;

/**
 * The largest single reply read from a stdio MCP server. A pull request
 * diff can be tens of megabytes (a committed bundle), and at the SDK's
 * default of 10 MiB one such reply stops the server. Results are cut to
 * the tool's result_max_bytes afterwards.
 */
export const STDIO_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** How many times one run starts an MCP server again after it stops. */
export const MAX_RESTARTS = 3;

/** Checks one call before it goes out; throws to stop it. */
export type CallGuard = (
  operation: string,
  args: Record<string, unknown>,
) => void;

/** One started MCP server: its transport and, for a child process, the tail of its standard error. */
export interface McpProcess {
  transport: Transport;
  stderr?: () => string;
}

/**
 * The text of a tool result: its text blocks and the text of embedded text
 * resources (get_file_contents returns a file as one), in order, or its
 * structured content when it has neither.
 */
export function resultText(result: CallToolResult): string {
  const texts = result.content.flatMap((b) => {
    if (b.type === "text") return [b.text];
    if (b.type === "resource" && "text" in b.resource) return [b.resource.text];
    return [];
  });
  if (texts.length > 0) return texts.join("\n");
  if (result.structuredContent !== undefined)
    return JSON.stringify(result.structuredContent);
  return "";
}

/** Keeps the last bytes a child process wrote to standard error, for error messages. */
export function stderrTail(
  stream: Stream | null,
  maxBytes = 4096,
): () => string {
  let tail = "";
  stream?.on("data", (chunk: Buffer | string) => {
    tail = (tail + chunk.toString()).slice(-maxBytes);
  });
  return () => tail.trim();
}

function withStderr(text: string, stderr: () => string): string {
  const tail = stderr().replace(/\s+/g, " ").trim().slice(-500);
  return tail === "" ? text : `${text} (stderr: ${tail})`;
}

function isSdkError(err: unknown, ...codes: SdkErrorCode[]): boolean {
  return err instanceof SdkError && codes.includes(err.code as SdkErrorCode);
}

interface Connection {
  client: Client;
  stderr: () => string;
  /** The last error the transport reported, such as a reply too big to read. */
  transportError?: string;
  /** Why the server stopped, once it has. */
  lost?: string;
}

/**
 * Starts an MCP server and checks that it offers every operation the tools
 * will call, so a server that changed fails the run's start rather than a
 * call halfway through.
 */
async function open(
  label: string,
  start: () => McpProcess,
  operations: readonly string[],
): Promise<Connection> {
  const { transport, stderr = () => "" } = start();
  const client = new Client({ name: SERVER_NAME, version: SERVER_VERSION });
  const conn: Connection = { client, stderr };
  transport.onerror = (err) => {
    conn.transportError = err.message;
  };
  client.onclose = () => {
    conn.lost ??= stopped(label, conn);
  };
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const offered = new Set(tools.map((t) => t.name));
    const missing = operations.filter((op) => !offered.has(op));
    if (missing.length > 0)
      throw new Error(`does not offer ${missing.join(", ")}`);
  } catch (err) {
    await client.close().catch(() => undefined);
    throw new Error(
      withStderr(
        `${label}: ${err instanceof Error ? err.message : String(err)}`,
        stderr,
      ),
    );
  }
  return conn;
}

function stopped(label: string, conn: Connection): string {
  return withStderr(
    `${label} stopped${conn.transportError === undefined ? "" : `: ${conn.transportError}`}`,
    conn.stderr,
  );
}

/**
 * An upstream reached through an MCP server. It calls only the operations
 * it was given, by name, after the guard has passed the arguments; it
 * never passes on the server's own tool list or descriptions. A result the
 * server marks as an error becomes a failed call.
 *
 * A server that stops mid-run fails the calls it had in hand, with the
 * reason and its standard error, and is started again for the next call,
 * up to MAX_RESTARTS times a run. A call that never reached the stopped
 * server goes to the new one.
 */
export class McpUpstream implements Upstream {
  readonly label: string;
  private readonly start: () => McpProcess;
  private readonly operations: ReadonlySet<string>;
  private readonly guard: CallGuard | undefined;
  private current: Connection;
  private reopening: Promise<Connection> | undefined;
  private closed = false;
  /** How many times the server was started again. */
  restarts = 0;

  constructor(
    label: string,
    start: () => McpProcess,
    first: Connection,
    operations: readonly string[],
    guard?: CallGuard,
  ) {
    this.label = label;
    this.start = start;
    this.current = first;
    this.operations = new Set(operations);
    this.guard = guard;
  }

  /** The client of the server running now. */
  get client(): Client {
    return this.current.client;
  }

  async call(
    operation: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    if (!this.operations.has(operation))
      throw new Error(`"${operation}" is not an allowed operation`);
    this.guard?.(operation, args);
    for (let attempt = 0; ; attempt++) {
      const conn = await this.connection();
      let result: CallToolResult;
      try {
        result = await conn.client.callTool(
          { name: operation, arguments: args },
          { signal, timeout: UPSTREAM_TIMEOUT_MS },
        );
      } catch (err) {
        if (isSdkError(err, SdkErrorCode.NotConnected)) {
          conn.lost ??= stopped(this.label, conn);
          if (attempt === 0) continue;
        }
        if (
          conn.lost !== undefined &&
          isSdkError(
            err,
            SdkErrorCode.ConnectionClosed,
            SdkErrorCode.NotConnected,
          )
        )
          throw new Error(conn.lost);
        throw err;
      }
      const text = resultText(result);
      if (result.isError === true) throw new Error(text || "the call failed");
      return text;
    }
  }

  private connection(): Promise<Connection> {
    if (this.closed)
      return Promise.reject(new Error(`${this.label} is closed`));
    const dead = this.current;
    if (dead.lost === undefined) return Promise.resolve(dead);
    if (this.reopening !== undefined) return this.reopening;
    if (this.restarts >= MAX_RESTARTS)
      return Promise.reject(
        new Error(
          `${dead.lost}; it was already started again ${MAX_RESTARTS} times, the most one run allows`,
        ),
      );
    this.restarts += 1;
    this.reopening = (async () => {
      await dead.client.close().catch(() => undefined);
      try {
        const conn = await open(this.label, this.start, [...this.operations]);
        if (this.closed) {
          await conn.client.close().catch(() => undefined);
          throw new Error(`${this.label} is closed`);
        }
        this.current = conn;
        return conn;
      } catch (err) {
        throw new Error(
          `${dead.lost}; starting it again failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.reopening = undefined;
      }
    })();
    return this.reopening;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.reopening?.catch(() => undefined);
    await this.current.client.close();
  }
}

/**
 * Starts an MCP server with start() and checks that it offers every
 * operation the tools will call. start() is called again for each restart,
 * so it must make a new transport every time.
 */
export async function connectMcp(
  label: string,
  start: () => McpProcess,
  operations: readonly string[],
  guard?: CallGuard,
): Promise<McpUpstream> {
  const first = await open(label, start, operations);
  return new McpUpstream(label, start, first, operations, guard);
}
