import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  collectTools,
  connectCollectTools,
  ToolCallError,
  unwrapToolResult,
  type ToolClient,
} from "../src/collect/tools.ts";
import { fitResult, wrapUntrusted } from "../src/tools-server/server.ts";

function client(
  reply: (
    name: string,
    args: Record<string, unknown>,
  ) => {
    content?: unknown;
    isError?: boolean;
  },
): ToolClient & { closed: boolean } {
  const c = {
    closed: false,
    callTool: (params: { name: string; arguments: Record<string, unknown> }) =>
      Promise.resolve(reply(params.name, params.arguments)),
    close: () => {
      c.closed = true;
      return Promise.resolve();
    },
  };
  return c;
}

const text = (t: string) => ({ content: [{ type: "text", text: t }] });

describe("the tools client of collect.ts", () => {
  it("takes the data out of whatever the tools server wraps", () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ maxLength: 40 }), (data, tool) => {
        expect(unwrapToolResult(wrapUntrusted(tool, data))).toEqual({
          text: data,
          truncated: false,
        });
      }),
    );
  });

  it("says when the tools server cut a result", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 20, maxLength: 400 }), (data) => {
        const fitted = fitResult("t", data, 10);
        const got = unwrapToolResult(fitted.text);
        expect(got.text).toBe(fitted.data);
        expect(got.truncated).toBe(fitted.truncated);
      }),
    );
  });

  it("passes text in any other shape through unchanged", () => {
    expect(unwrapToolResult("plain text")).toEqual({
      text: "plain text",
      truncated: false,
    });
  });

  it("turns a refusal or an upstream failure into a ToolCallError with the reason", async () => {
    const tools = collectTools(
      client((name) =>
        name === "refused"
          ? {
              ...text('"refused" is not a tool this job can use'),
              isError: true,
            }
          : {
              ...text(`broken failed:\n${wrapUntrusted("broken", "HTTP 500")}`),
              isError: true,
            },
      ),
      [],
    );
    await expect(tools.call("refused")).rejects.toThrow(
      new ToolCallError(
        "refused",
        'refused: "refused" is not a tool this job can use',
      ),
    );
    await expect(tools.call("broken")).rejects.toThrow(
      "broken: broken failed: HTTP 500",
    );
  });

  it("parses JSON results and refuses a cut or non-JSON one", async () => {
    const tools = collectTools(
      client((name) => {
        if (name === "whole") return text(wrapUntrusted(name, '{"n":7}'));
        if (name === "cut")
          return text(fitResult(name, '{"n":"a long value"}', 5).text);
        return text(wrapUntrusted(name, "not json"));
      }),
      ["whole", "cut", "other"],
    );
    expect(await tools.json("whole")).toEqual({ n: 7 });
    await expect(tools.json("cut")).rejects.toThrow(
      "the result was cut to the tool's size limit",
    );
    await expect(tools.json("other")).rejects.toThrow("the result is not JSON");
  });

  it("needs the mailbox the runner names", async () => {
    await expect(connectCollectTools({})).rejects.toThrow(
      "FLAX_AGENTS_COLLECT_MAILBOX is not set",
    );
  });
});
