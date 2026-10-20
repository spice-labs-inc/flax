import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkCitations,
  findCitations,
  MIN_QUOTE_CHARS,
} from "../src/run-job/evidence.ts";

const TOOLS = ["k8s-pods", "logs-streams", "slack-history"];

describe("citations in an answer", () => {
  it("finds every object with a string tool and quote, wherever it sits", () => {
    expect(
      findCitations({
        pods: { answer: "6", tool: "k8s-pods", quote: "a row" },
        list: [
          { tool: "logs-streams", quote: "q1" },
          { nested: { tool: "slack-history", quote: "q2", extra: 1 } },
        ],
        notACitation: { tool: "k8s-pods" },
        alsoNot: { tool: 3, quote: "x" },
      }),
    ).toEqual([
      { path: "pods", tool: "k8s-pods", quote: "a row" },
      { path: "list[0]", tool: "logs-streams", quote: "q1" },
      { path: "list[1].nested", tool: "slack-history", quote: "q2" },
    ]);
    expect(findCitations({ tool: "k8s-pods", quote: "top" })).toEqual([
      { path: "(answer)", tool: "k8s-pods", quote: "top" },
    ]);
    expect(findCitations("just text")).toEqual([]);
  });
});

describe("checking citations against tool results", () => {
  const results = [
    {
      tool: "k8s-pods",
      text: "NAMESPACE     NAME                 READY   STATUS\nflux-system   source-controller-1   1/1     Running",
    },
    { tool: "logs-streams", text: '{"total":142,"streams":[]}' },
    {
      tool: "slack-history",
      text: JSON.stringify({
        messages: [{ text: 'Deploy "engine" failed\non prod' }],
      }),
    },
  ];
  const check = (tool: string, quote: string) =>
    checkCitations({ a: { tool, quote } }, results, TOOLS)[0]!;

  it("accepts a quote that appears in a result of that tool, ignoring whitespace", () => {
    expect(
      check("k8s-pods", "flux-system source-controller-1 1/1 Running").found,
    ).toBe(true);
    expect(check("logs-streams", '"total": 142').found).toBe(true);
  });

  it("accepts a quote of a JSON string value without its escapes", () => {
    expect(check("slack-history", 'Deploy "engine" failed on prod').found).toBe(
      true,
    );
  });

  it("refuses a quote that is not there, or is in another tool's result", () => {
    expect(check("k8s-pods", '"total":142')).toEqual({
      path: "a",
      tool: "k8s-pods",
      quote: '"total":142',
      found: false,
      reason: "the quote is not in any result k8s-pods returned",
    });
    expect(check("logs-streams", '"total":143').found).toBe(false);
  });

  it("refuses a tool the job does not list or did not get a result from", () => {
    expect(check("gh-job-log", "some log line").reason).toBe(
      "gh-job-log is not one of the job's tools",
    );
    expect(
      checkCitations(
        { a: { tool: "slack-history", quote: "anything at all" } },
        [],
        TOOLS,
      )[0]!.reason,
    ).toBe("no call to slack-history returned a result in this run");
  });

  it("refuses a quote too short to prove anything", () => {
    expect(check("logs-streams", " 1 4 ").reason).toBe(
      `the quote is shorter than ${MIN_QUOTE_CHARS} characters besides spaces`,
    );
  });

  it("finds any long enough piece of any result, spaced any way", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 20, maxLength: 200 }),
        fc.nat(),
        fc.integer({ min: MIN_QUOTE_CHARS, max: 20 }),
        (text, start, length) => {
          const squashed = text.replace(/\s+/g, "");
          fc.pre(squashed.length >= length);
          const from = start % (squashed.length - length + 1);
          const quote = squashed
            .slice(from, from + length)
            .split("")
            .join(" ");
          const [c] = checkCitations(
            { tool: "k8s-pods", quote },
            [{ tool: "k8s-pods", text }],
            TOOLS,
          );
          expect(c?.found).toBe(true);
        },
      ),
    );
  });
});
