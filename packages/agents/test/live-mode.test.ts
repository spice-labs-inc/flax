import { describe, expect, it } from "vitest";
import { liveModeCheck } from "../src/check/live-mode.ts";
import { jobFiles, makeRepo, run } from "./helpers.ts";

const link = (id: number) =>
  `- https://github.com/notes-co/agents/actions/runs/${id}`;

function liveRepo(shadowRuns?: string): string {
  const files: Record<string, string> = jobFiles("demo", { mode: "live" });
  if (shadowRuns !== undefined) files["SHADOW_RUNS.md"] = shadowRuns;
  return makeRepo({ jobs: { demo: files } });
}

describe("live mode", () => {
  it("does not ask shadow jobs for shadow runs", async () => {
    expect(
      await run(liveModeCheck, makeRepo({ jobs: { demo: jobFiles("demo") } })),
    ).toEqual([]);
  });

  it("accepts a live job with four distinct shadow run links", async () => {
    const links = Array.from({ length: 4 }, (_, i) => link(1000 + i)).join(
      "\n",
    );
    expect(await run(liveModeCheck, liveRepo(links))).toEqual([]);
  });

  it("rejects a live job without SHADOW_RUNS.md", async () => {
    expect(await run(liveModeCheck, liveRepo())).toEqual([
      "jobs/demo/job.yml: mode: live mode needs jobs/demo/SHADOW_RUNS.md listing at least 4 shadow run links",
    ]);
  });

  it("counts each run once and ignores other repositories", async () => {
    const text = [
      ...Array.from({ length: 3 }, (_, i) => link(1000 + i)),
      link(1000),
      "- https://github.com/someone/else/actions/runs/5",
    ].join("\n");
    expect(await run(liveModeCheck, liveRepo(text))).toEqual([
      "jobs/demo/SHADOW_RUNS.md: lists 3 distinct shadow run links; live mode needs at least 4",
    ]);
  });

  it("asks a job on any schedule for four shadow runs, including runs started by hand", async () => {
    const files: Record<string, string> = jobFiles("demo", {
      mode: "live",
      trigger: { schedule: "0 1,13 * * *" },
    });
    files["SHADOW_RUNS.md"] = Array.from({ length: 4 }, (_, i) =>
      link(2000 + i),
    ).join("\n");
    expect(
      await run(liveModeCheck, makeRepo({ jobs: { demo: files } })),
    ).toEqual([]);
  });
});
