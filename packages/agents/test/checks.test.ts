import { describe, expect, it } from "vitest";
import {
  checkName,
  clampSummary,
  clampTitle,
  deliveryCheck,
  MAX_CHECK_SUMMARY,
  MAX_CHECK_TITLE,
  writeCheck,
} from "../src/deliver/checks.ts";
import {
  endedCheck,
  inProgressCheck,
  queuedCheck,
} from "../src/revise/check.ts";
import { FakeWriter } from "./fake-writer.ts";

const BASE_FACTS = {
  pages: [{ path: "repos/engine.md", changedLines: 2 }],
  leftOut: [],
  stamped: 0,
  media: 0,
  changes: 1,
  citations: 2,
  builtByCode: false,
};

describe("Notes Agent check runs", () => {
  it("are named Notes Agent / <job>", () => {
    expect(checkName("internal-docs-watch")).toBe(
      "Notes Agent / internal-docs-watch",
    );
  });

  it("keep titles to one line and summaries under GitHub's cap", () => {
    expect(clampTitle("two\nlines   here")).toBe("two lines here");
    expect(clampTitle("x".repeat(500))).toHaveLength(MAX_CHECK_TITLE);
    expect(
      clampSummary("y".repeat(MAX_CHECK_SUMMARY + 10)).length,
    ).toBeLessThanOrEqual(MAX_CHECK_SUMMARY);
  });

  it("say what a code-built pull request is, with no model cost", () => {
    const c = deliveryCheck({
      ...BASE_FACTS,
      pages: [],
      media: 11,
      stamped: 0,
      changes: 0,
      citations: 0,
      builtByCode: true,
    });
    expect(c.title).toBe(
      "0 pages changed, 11 media files, built by the job's code",
    );
    expect(c.summary).toContain("**Second check:** none, no model ran");
    expect(c.summary).toContain("**Model cost:** none");
    expect(c.conclusion).toBe("success");
  });

  it("follow a revision from queued to how it ended", () => {
    expect(queuedCheck("dani", 2)).toMatchObject({
      status: "queued",
      title: "Revision requested by @dani",
    });
    expect(inProgressCheck(2, 1, "https://example.test/run")).toMatchObject({
      status: "in_progress",
      title: "Revision round 2 of 5 in progress",
      detailsUrl: "https://example.test/run",
    });
    expect(endedCheck({ kind: "answered", round: 2 })).toMatchObject({
      conclusion: "success",
      title: "Answered, no change, round 2 of 5",
    });
    expect(
      endedCheck({ kind: "failed", reason: "the branch moved\nmore" }),
    ).toMatchObject({
      conclusion: "failure",
      title: "Revision failed: the branch moved",
    });
    expect(endedCheck({ kind: "nothing", reason: "no request" })).toMatchObject(
      {
        conclusion: "neutral",
      },
    );
  });

  it("never throw when GitHub refuses one; the record says why", async () => {
    const w = new FakeWriter();
    w.refuseChecks = "POST /repos/x/y/check-runs returned 403";
    const record = await writeCheck(
      w,
      {
        repo: "notes-co/atlas",
        job: "demo",
        branch: "agent/demo/2026-10-06",
        head: "a".repeat(40),
      },
      deliveryCheck(BASE_FACTS),
    );
    expect(record).toMatchObject({
      name: "Notes Agent / demo",
      refused: "POST /repos/x/y/check-runs returned 403",
    });
    expect(record.id).toBeUndefined();
  });
});
