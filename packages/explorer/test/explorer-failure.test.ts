import { describe, expect, it } from "vitest";
import { failedStep, shortMessage } from "../src/lib/failure.ts";

describe("shortMessage", () => {
  it("keeps what went wrong and drops the call log heading and stack", () => {
    const m = [
      "locator.waitFor: Timeout 60000ms exceeded.",
      "Call log:",
      "  - waiting for getByTestId('completeness-panel').first() to be visible",
      "",
      "    at shows (src/steps/dashboard-data.ts:92:12)",
    ].join("\n");
    expect(shortMessage(m)).toBe(
      "locator.waitFor: Timeout 60000ms exceeded.\nwaiting for getByTestId('completeness-panel').first() to be visible",
    );
  });

  it("cuts a long message", () => {
    const out = shortMessage("x".repeat(500));
    expect(out).toHaveLength(240);
    expect(out.endsWith("…")).toBe(true);
  });

  it("is empty without a message", () => {
    expect(shortMessage("")).toBe("");
  });
});

describe("failedStep", () => {
  it("names the step as written", () => {
    expect(failedStep(2, { k: "Then ", t: "the panel shows" })).toBe(
      "Then the panel shows",
    );
  });

  it("names hooks and steps the run could not place", () => {
    expect(failedStep(-1)).toBe("Setting up, before the first step");
    expect(failedStep(-2)).toBe("Cleaning up, after the last step");
    expect(failedStep(-3, undefined, "When it loads")).toBe("When it loads");
    expect(failedStep(-3)).toBe("A step this run could not place");
  });
});
