import {
  isJSONRPCNotification,
  isJSONRPCRequest,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import {
  isObject,
  isRequestId,
} from "../../images/agent/pi-mcp-mailbox/src/protocol.ts";

export type Incoming =
  | { message: JSONRPCMessage }
  | {
      refused: string;
      /** An error to send back, so the box does not wait for its timeout. */
      reply?: JSONRPCMessage;
    };

/**
 * The checks every message from the box passes before the MCP server sees
 * it, whichever transport carried it: a JSON-RPC request with a string or
 * integer id never used before, or a notification. The server sends no
 * requests, so it takes no responses.
 */
export class IncomingChecker {
  private readonly ids = new Set<string | number>();

  check(value: unknown): Incoming {
    const id = isObject(value) ? value.id : undefined;
    if (isJSONRPCRequest(value)) {
      if (!isRequestId(id))
        return {
          refused: "has a request id that is not a string or an integer",
        };
      if (this.ids.has(id))
        return { refused: `repeats request id ${JSON.stringify(id)}` };
      this.ids.add(id);
      return { message: value as JSONRPCMessage };
    }
    if (isJSONRPCNotification(value))
      return { message: value as JSONRPCMessage };
    const refused =
      "is not a JSON-RPC request or notification; the server sends no requests, so it takes no responses";
    if (isObject(value) && typeof value.method === "string" && isRequestId(id))
      return {
        refused,
        reply: {
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: "invalid JSON-RPC request" },
        } as JSONRPCMessage,
      };
    return { refused };
  }
}
