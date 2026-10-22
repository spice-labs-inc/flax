import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { MailboxClientTransport } from "../../images/agent/pi-mcp-mailbox/src/client.ts";
import { COLLECT_MAILBOX_ENV } from "./env.ts";

export const COLLECT_CLIENT_NAME = "agents-collect";
const CONNECT_TIMEOUT_MS = 15_000;
// The tools server cuts a call off after the job's tool_seconds, at most 300 s.
const CALL_TIMEOUT_MS = 330_000;
const POLL_MS = 25;

/** A tool result without the data markers the tools server puts around it. */
export interface ToolText {
  text: string;
  /** The tools server cut the result to the tool's result_max_bytes. */
  truncated: boolean;
}

/** A call the tools server refused or that failed upstream. */
export class ToolCallError extends Error {
  readonly tool: string;

  constructor(tool: string, message: string) {
    super(message);
    this.name = "ToolCallError";
    this.tool = tool;
  }
}

const WRAPPED =
  /^[^\n]*\n<data-([0-9a-f]+)>\n([\s\S]*)\n<\/data-\1>(\nThe data was cut to its first \d+ bytes\.)?$/;

/**
 * Takes the data out of a result the tools server wrapped as untrusted
 * data (wrapUntrusted in src/tools-server/server.ts). Text in any other
 * shape is returned as it is.
 */
export function unwrapToolResult(text: string): ToolText {
  const m = WRAPPED.exec(text);
  if (m === null) return { text, truncated: false };
  return { text: m[2]!, truncated: m[3] !== undefined };
}

/** Error text from the tools server, with any wrapped upstream text unwrapped. */
function errorText(text: string): string {
  const cut = text.indexOf("\n");
  if (cut === -1) return text;
  const head = text.slice(0, cut);
  const rest = unwrapToolResult(text.slice(cut + 1));
  return rest.text === text.slice(cut + 1) ? text : `${head} ${rest.text}`;
}

/** What collect.ts gets: calls to the tools listed in the job's collect_tools, through the run's tools server. */
export interface CollectTools {
  /** The tools the tools server offers this collect.ts. */
  readonly names: readonly string[];
  /** Calls a tool; throws ToolCallError when it is refused or fails. */
  call(tool: string, args?: Record<string, unknown>): Promise<ToolText>;
  /** Calls a tool whose result is JSON and parses it; a cut result is refused rather than parsed. */
  json(tool: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** The client side of any MCP client; tests stand in for it. */
export interface ToolClient {
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    options?: { timeout?: number },
  ): Promise<{ content?: unknown; isError?: boolean | undefined }>;
  close(): Promise<void>;
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

/** Wraps an MCP client as the calls collect.ts makes. */
export function collectTools(
  client: ToolClient,
  names: readonly string[],
): CollectTools {
  const call = async (
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolText> => {
    const result = await client.callTool(
      { name: tool, arguments: args },
      { timeout: CALL_TIMEOUT_MS },
    );
    const text = resultText(result.content);
    if (result.isError === true)
      throw new ToolCallError(
        tool,
        `${tool}: ${errorText(text) || "the call failed"}`,
      );
    return unwrapToolResult(text);
  };
  return {
    names,
    call,
    async json(tool, args = {}) {
      const result = await call(tool, args);
      if (result.truncated)
        throw new ToolCallError(
          tool,
          `${tool}: the result was cut to the tool's size limit, so it is not whole JSON; ask for less`,
        );
      try {
        return JSON.parse(result.text) as unknown;
      } catch {
        throw new ToolCallError(tool, `${tool}: the result is not JSON`);
      }
    },
    close: () => client.close(),
  };
}

/**
 * Connects collect.ts to the tools server the runner started for it. The
 * runner names the mailbox in FLAX_AGENTS_COLLECT_MAILBOX when the job
 * lists collect_tools; collect.ts never holds a credential.
 */
export async function connectCollectTools(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CollectTools> {
  const dir = env[COLLECT_MAILBOX_ENV];
  if (dir === undefined || dir === "")
    throw new Error(
      `${COLLECT_MAILBOX_ENV} is not set: the runner sets it for a collect.ts whose job lists collect_tools`,
    );
  const client = new Client(
    { name: COLLECT_CLIENT_NAME, version: "0.1.0" },
    { capabilities: {} },
  );
  let names: string[];
  try {
    await client.connect(new MailboxClientTransport({ dir, pollMs: POLL_MS }), {
      timeout: CONNECT_TIMEOUT_MS,
    });
    const { tools } = await client.listTools(undefined, {
      timeout: CONNECT_TIMEOUT_MS,
    });
    names = tools.map((t) => t.name);
  } catch (err) {
    await client.close();
    throw err;
  }
  return collectTools(client, names);
}

/** Whether the module at this import.meta.url is the script node was started with. */
/**
 * Runs a job script's main when the file Node started is this job's script,
 * and on a failure prints one short line, `Name: message`, then exits 1.
 * The job name matters in a bundle: a job that imports another job's script
 * carries that script's runMain call too, with the same import.meta.url, and
 * only the job whose folder the started file is in may run. Left to Node, an
 * uncaught error first prints the source line that threw, which in a bundled
 * script is a whole bundled library, and the message after it is lost in the
 * workflow log.
 */
export async function runMain(
  importMetaUrl: string,
  job: string,
  main: () => Promise<void>,
): Promise<void> {
  if (!isMain(importMetaUrl) || !startedFromJob(job)) return;
  try {
    await main();
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const message = e.message.replace(/\s+/g, " ").slice(0, 1000);
    const frames = (e.stack ?? "")
      .split("\n")
      .filter((l) => l.trim().startsWith("at "))
      .slice(0, 5)
      .map((l) => l.trim().slice(0, 200));
    process.stderr.write(
      [`${e.name}: ${message}`, ...frames.map((l) => `    ${l}`)].join("\n") +
        "\n",
    );
    process.exit(1);
  }
}

/** Whether the script Node started is in jobs/<job>/ (source) or dist/jobs/<job>/ (bundle). */
export function startedFromJob(job: string): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script)
      .split(sep)
      .some((part, i, parts) => part === job && parts[i - 1] === "jobs");
  } catch {
    return false;
  }
}

export function isMain(importMetaUrl: string): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
