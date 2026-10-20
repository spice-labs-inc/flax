import { describe, expect, it } from "vitest";
import {
  readResultsIndex,
  RESULTS_INDEX as CONTRACT_RESULTS_INDEX,
  resultsArtifactName,
  resultsRunId as contractRunId,
  type ResultsIndex as ContractIndex,
} from "../../contract/src/run-artifacts.ts";
import {
  readIndex,
  RESULTS_INDEX,
  type ResultsIndex,
} from "../src/deliver/check-results.ts";
import { resultsArtifact, resultsRunId } from "../src/run-job/results-output.ts";

/** The kit writes what @flax/contract describes: the artifact name, the run id and the index shape must agree. */
describe("the results contract", () => {
  it("names the artifact as the kit does, live and shadow", () => {
    for (const job of ["checks", "scenario-checks"])
      for (const env of ["dev", "staging", "prod"])
        for (const mode of ["live", "shadow"] as const)
          expect(resultsArtifactName(job, mode, env)).toBe(
            resultsArtifact(job, mode, env),
          );
    expect(resultsArtifactName("checks", "shadow", "dev")).toBe(
      "checks-shadow-dev",
    );
  });

  it("names the run as the kit does, from the workflow run and attempt", () => {
    const cases: [string | undefined, string | undefined][] = [
      ["1234567890", "2"],
      ["1234567890", undefined],
      ["1234567890", "x"],
      [undefined, "1"],
      ["abc", "1"],
      ["", "1"],
    ];
    for (const [id, attempt] of cases)
      expect(contractRunId(id, attempt), `${id} ${attempt}`).toBe(
        resultsRunId({ GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: attempt }),
      );
    expect(contractRunId("1234567890", "2")).toBe("1234567890-2");
    expect(contractRunId(undefined, undefined)).toBe("local");
  });

  it("keeps one index file name and reads the same index on both sides", () => {
    expect(CONTRACT_RESULTS_INDEX).toBe(RESULTS_INDEX);
    const index: ResultsIndex & ContractIndex = {
      version: 1,
      job: "checks",
      env: "dev",
      shadow: false,
      run: {
        id: "1234567890-1",
        at: "2026-10-15T12:00:00Z",
        workflowRun: "https://github.com/notes-co/agents/actions/runs/1234567890",
      },
      builds: { api: "1.2.3", web: "abcdef0" },
      counts: { passed: 1, failed: 1, skipped: 0 },
      checks: {
        login: { name: "Login", status: "passed" },
        export: { name: "Export", status: "failed", detail: "timed out", step: "download" },
      },
    };
    const text = JSON.stringify(index);
    expect(readIndex(text)).toEqual(index);
    expect(readResultsIndex(text)).toEqual(index);
    for (const bad of [
      "not json",
      JSON.stringify({ ...index, version: 2 }),
      JSON.stringify({ ...index, checks: { login: { name: "Login", status: "maybe" } } }),
      JSON.stringify({ ...index, run: { at: index.run.at } }),
    ]) {
      expect(readIndex(bad)).toBeUndefined();
      expect(readResultsIndex(bad)).toBeUndefined();
    }
  });
});
