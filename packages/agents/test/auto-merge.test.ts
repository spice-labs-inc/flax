import { describe, expect, it } from "vitest";
import { autoMergeGlobProblem } from "../src/check/allowlists.ts";
import {
  autoMergeDecision,
  deliverPlan,
  type DeliveryMeta,
} from "../src/deliver/deliver.ts";
import { planDelivery } from "../src/deliver/plan.ts";
import type { CheckContext, ProposedPage } from "../src/output-check/pr.ts";
import { FakeWriter } from "./fake-writer.ts";

const ATLAS = "notes-co/atlas";
const BASE = "c".repeat(40);
const NOW = new Date("2026-10-07T12:00:00Z");
const PAGE = ["---", "name: engine", "---", "", "Listens on port 8080."];

const page = (path: string): ProposedPage => ({
  repo: ATLAS,
  path,
  decision: "patch",
  reason: "engine moved to 9090.",
  patch: `--- a/${path}\n+++ b/${path}\n@@ -5 +5 @@\n-Listens on port 8080.\n+Listens on port 9090.\n`,
  changes: [
    {
      removed: ["Listens on port 8080."],
      added: ["Listens on port 9090."],
      evidence: [{ repo: "notes-co/engine", commit: "f".repeat(40) }],
    },
  ],
});

const meta: DeliveryMeta = {
  model: "none",
  runName: "job-demo-1-1",
  untrustedTools: [],
  reviewReasons: [],
};

function setup(paths: string[], autoMergePaths: string[]) {
  const policy = {
    repos: [ATLAS],
    paths: ["viz/**"],
    maxChangedLines: 40,
    autoMergePaths,
  };
  const context = {
    policy,
    pinned: paths.map((path) => ({
      repo: ATLAS,
      path,
      commit: BASE,
      lines: PAGE,
    })),
  } satisfies CheckContext;
  const plan = planDelivery("demo", { pages: paths.map(page) }, context, NOW);
  if ("error" in plan) throw new Error(plan.error);
  const w = new FakeWriter();
  for (const path of paths) w.put(ATLAS, BASE, path, `${PAGE.join("\n")}\n`);
  return { policy, plan, w };
}

describe("auto_merge", () => {
  it("merges the pull request and deletes its branch when every changed path matches", async () => {
    const { policy, plan, w } = setup(
      ["viz/data/graph.json", "viz/cache/a.json"],
      ["viz/data/**", "viz/cache/**"],
    );
    const [pull] = await deliverPlan(plan, policy, w, meta, NOW);
    expect(pull!.autoMerge).toEqual({ merged: true, sha: "f".repeat(40) });
    expect(w.merges).toEqual([
      { repo: ATLAS, number: pull!.number, head: pull!.commit },
    ]);
    expect(w.deleted).toContain(`${ATLAS}:${pull!.branch}`);
    expect(w.pulls[0]!.body).toContain("it is merged automatically");
    expect(
      w.calls.indexOf(`mergePull ${ATLAS} #${pull!.number}`),
    ).toBeGreaterThan(w.calls.findIndex((c) => c.startsWith("createCheck ")));
  });

  it("leaves the pull request open and says why when one path is outside", async () => {
    const { policy, plan, w } = setup(
      ["viz/data/graph.json", "viz/prompts/extract-wiring.md"],
      ["viz/data/**"],
    );
    const [pull] = await deliverPlan(plan, policy, w, meta, NOW);
    expect(pull!.autoMerge).toEqual({
      merged: false,
      why: "`viz/prompts/extract-wiring.md` is outside the paths it merges (`viz/data/**`)",
    });
    expect(w.merges).toEqual([]);
    expect(w.pulls[0]!.state).toBe("open");
    expect(w.pulls[0]!.body).toContain(
      "Not merged automatically: `viz/prompts/extract-wiring.md` is outside",
    );
  });

  it("leaves the pull request open with a comment when GitHub refuses the merge", async () => {
    const { policy, plan, w } = setup(["viz/data/graph.json"], ["viz/data/**"]);
    w.refuseMerge = "PUT /repos/x/pulls/1/merge returned 405";
    const [pull] = await deliverPlan(plan, policy, w, meta, NOW);
    expect(pull!.autoMerge).toEqual({
      merged: false,
      why: "the merge failed: PUT /repos/x/pulls/1/merge returned 405",
    });
    expect(w.pulls[0]!.state).toBe("open");
    expect(w.pulls[0]!.comments).toEqual([
      "Not merged automatically: the merge failed: PUT /repos/x/pulls/1/merge returned 405. It stays open for review.",
    ]);
    expect(w.deleted).toEqual([]);
  });

  it("never merges without auto_merge", async () => {
    const { plan, w } = setup(["viz/data/graph.json"], []);
    const [pull] = await deliverPlan(
      plan,
      { repos: [ATLAS], paths: ["viz/**"], maxChangedLines: 40 },
      w,
      meta,
      NOW,
    );
    expect(pull!.autoMerge).toBeUndefined();
    expect(w.merges).toEqual([]);
    expect(autoMergeDecision(undefined, ["viz/data/a"])).toBeUndefined();
  });

  it("accepts only narrow globs inside the output paths", () => {
    const out = ["viz/**", "repos/*.md"];
    for (const ok of [
      "viz/data/**",
      "viz/cache/**",
      "repos/*.md",
      "viz/data/x.json",
    ])
      expect(autoMergeGlobProblem(ok, out), ok).toBeUndefined();
    expect(autoMergeGlobProblem("**", out)).toMatch(/must start with a folder/);
    expect(autoMergeGlobProblem("*/data/**", out)).toMatch(
      /must start with a folder/,
    );
    expect(autoMergeGlobProblem("graph.json", out)).toMatch(
      /must start with a folder/,
    );
    expect(
      autoMergeGlobProblem(".github/workflows/*.yml", [".github/**"]),
    ).toMatch(/never merged without review/);
    expect(autoMergeGlobProblem("src/**", ["src/**"])).toMatch(/never merged/);
    expect(autoMergeGlobProblem("viz/prompts/**", out)).toMatch(
      /names a prompt/,
    );
    expect(autoMergeGlobProblem("docs/**", out)).toMatch(
      /outside the job's output paths/,
    );
  });
});
