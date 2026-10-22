import { lstatSync } from "node:fs";
import { join } from "node:path";
import { Client, type Tool } from "@modelcontextprotocol/client";
import { shimPort, startModelShim } from "./model-shim.ts";
import { isObject } from "./protocol.ts";
import { SocketClientTransport } from "./socket-client.ts";
import { BOX_SOCKET_DIR, MODEL_SOCKET, TOOLS_SOCKET } from "./sockets.ts";

export const CLIENT_NAME = "pi-mcp-mailbox";
export const CLIENT_VERSION = "0.3.0";

/** How long start-up waits for the tools server to answer. */
export const CONNECT_TIMEOUT_MS = 15_000;
/**
 * The tools server times each call out itself, after at most the job
 * schema's cap of 300 s; this only covers a server that stopped answering.
 */
export const CALL_TIMEOUT_MS = 330_000;
export const MAX_TOOLS = 64;

const TOOL_NAME = /^[a-z][a-z0-9-]{1,40}$/;

/** The part of Pi's ExtensionAPI this extension uses. */
export interface PiApi {
  registerTool(tool: PiTool): void;
  on(event: "session_shutdown", handler: () => unknown): unknown;
}

export interface PiTool {
  name: string;
  label: string;
  description: string;
  /** A plain JSON Schema object, which Pi validates arguments against. */
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ content: { type: "text"; text: string }[]; details: undefined }>;
}

export interface ConnectOptions {
  /** The tools socket. */
  socket: string;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isObject(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function usable(tool: Tool): boolean {
  return (
    TOOL_NAME.test(tool.name) &&
    typeof tool.description === "string" &&
    isObject(tool.inputSchema) &&
    tool.inputSchema.type === "object"
  );
}

/** Wraps one tool the server offers as a Pi tool that calls it over the tools socket. */
export function piTool(
  client: Client,
  tool: Tool,
  callTimeoutMs = CALL_TIMEOUT_MS,
): PiTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description ?? "",
    parameters: tool.inputSchema,
    async execute(_toolCallId, params, signal) {
      const result = await client.callTool(
        {
          name: tool.name,
          arguments: isObject(params) ? params : {},
        },
        { timeout: callTimeoutMs, ...(signal === undefined ? {} : { signal }) },
      );
      const text = resultText(result.content);
      // Pi turns a thrown error into a failed tool result for the model.
      if (result.isError === true)
        throw new Error(text === "" ? `${tool.name} failed` : text);
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

/**
 * Connects to the tools server over the tools socket, lists its tools and
 * registers each with Pi under the server's name, description and schema.
 * Returns the names registered.
 */
export async function connectTools(
  pi: PiApi,
  options: ConnectOptions,
): Promise<string[]> {
  const client = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    { capabilities: {} },
  );
  const timeout = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const transport = new SocketClientTransport(options.socket);
  let tools: Tool[];
  try {
    await client.connect(transport, { timeout });
    ({ tools } = await client.listTools(undefined, { timeout }));
  } catch (err) {
    // Closes the socket, which would otherwise keep Pi running.
    await client.close();
    throw err;
  }
  pi.on("session_shutdown", () => client.close());
  const names: string[] = [];
  for (const tool of tools.slice(0, MAX_TOOLS)) {
    if (!usable(tool) || names.includes(tool.name)) continue;
    pi.registerTool(piTool(client, tool, options.callTimeoutMs));
    names.push(tool.name);
  }
  return names;
}

function isSocket(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

/**
 * Starts the model shim when the runner serves the model socket, so the
 * the model provider's FLAX_AGENTS_MODEL_BASE_URL reaches the runner's forwarder. Returns
 * whether it started.
 */
export async function startModelPath(
  pi: PiApi,
  socketPath: string,
  baseUrl: string | undefined,
): Promise<boolean> {
  if (!isSocket(socketPath)) return false;
  const shim = await startModelShim({ socketPath, port: shimPort(baseUrl) });
  pi.on("session_shutdown", () => shim.close());
  return true;
}

/**
 * Pi's entry point. Pi waits for this before it builds the session, so the
 * tools exist when Pi applies its --tools allowlist and picks the active
 * tools. The job runner loads this before the model provider, so the model
 * shim listens before the provider first calls FLAX_AGENTS_MODEL_BASE_URL, and the
 * tools come over the tools socket. Without the sockets (a run whose job
 * lists no tools has no tools socket, and pi --version has neither) there is
 * nothing to connect to.
 */
export default async function piMcpMailbox(pi: PiApi): Promise<void> {
  await startModelPath(
    pi,
    join(BOX_SOCKET_DIR, MODEL_SOCKET),
    process.env.FLAX_AGENTS_MODEL_BASE_URL,
  );
  const socket = join(BOX_SOCKET_DIR, TOOLS_SOCKET);
  if (isSocket(socket)) await connectTools(pi, { socket });
}
