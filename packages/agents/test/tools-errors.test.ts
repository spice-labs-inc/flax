import { describe, expect, it } from "vitest";
import { errorChain } from "../src/tools-server/errors.ts";

describe("errorChain", () => {
  it("follows fetch's cause, with codes", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("other side closed"), {
        code: "UND_ERR_SOCKET",
      }),
    });
    expect(errorChain(err)).toBe(
      "fetch failed; cause: UND_ERR_SOCKET other side closed",
    );
  });

  it("reads WebSocket error events, and does not repeat a message", () => {
    const event = {
      type: "error",
      message: "Unexpected server response: 403",
      error: new Error("Unexpected server response: 403"),
    };
    expect(errorChain(event)).toBe("Unexpected server response: 403");
  });

  it("keeps a code already in the message once, stops at loops and depth, and takes plain values", () => {
    const loop: { message: string; cause?: unknown } = { message: "a" };
    loop.cause = loop;
    expect(errorChain(loop)).toBe("a");
    expect(
      errorChain(
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
          code: "ECONNREFUSED",
        }),
      ),
    ).toBe("connect ECONNREFUSED 127.0.0.1:1");
    let deep: unknown = "bottom";
    for (let i = 0; i < 10; i++)
      deep = new Error(`level ${i}`, { cause: deep });
    expect(errorChain(deep).split("; cause: ")).toHaveLength(5);
    expect(errorChain("just text")).toBe("just text");
    expect(errorChain(new Error("first\nsecond"))).toBe("first");
  });
});
