import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { checkRepo } from "../src/check/index.ts";
import { UNPINNED_MESSAGE } from "../src/lib/box.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { isError } from "../src/lib/problem.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { runJob } from "../src/run-job/run.ts";
import { videoAnswer } from "../src/deliver/media.ts";
import { NO_MODEL } from "../src/lib/job.ts";
import type { MediaManifest } from "../src/lib/media.ts";
import { formatted } from "./helpers.ts";

describe("this repository", () => {
  it("passes every check", async () => {
    const problems = await checkRepo(FIXTURE_WORKSPACE);
    expect(formatted(problems.filter(isError))).toEqual([]);
    // An unpinned box is the only warning allowed.
    expect(formatted(problems.filter((p) => !isError(p)))).toEqual(
      loadRepo(FIXTURE_WORKSPACE).box?.pinned
        ? []
        : [`warning: box.yml: pinned: ${UNPINNED_MESSAGE}`],
    );
  });

  // The offline test guardrail: every job runs end to end with the stub
  // launcher, with no network, docker or model, and yields a valid report.
  describe.each(
    loadRepo(FIXTURE_WORKSPACE).jobs.map((j) => [
      j.name,
      j.config?.model === NO_MODEL,
      j.config?.output.kind,
    ]),
  )("job %s, offline", (name, noModel, kind) => {
    it("runs with --stub and produces a valid report", async () => {
      const scratch = mkdtempSync(join(tmpdir(), "agents-offline-"));
      onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
      const result = await runJob({
        root: FIXTURE_WORKSPACE,
        name,
        stub: true,
        scratch,
        out: join(scratch, "report"),
        env: { PATH: "/nonexistent" },
        log: () => {},
      });
      expect(result.messages).toEqual([
        noModel
          ? `${name}: delivered without a model.`
          : `${name}: answer accepted.`,
        `Report: ${join(scratch, "report")}`,
      ]);
      expect(result.ok).toBe(true);
      // A file job without a model has no answer: its report keeps the media stage's manifest.
      if (noModel && kind === "file") {
        expect(existsSync(join(scratch, "report", "answer.json"))).toBe(false);
        expect(existsSync(join(scratch, "report", "media", "media.json"))).toBe(
          true,
        );
        return;
      }
      // A check job has no answer either: its report keeps the index it would leave.
      if (kind === "results") {
        expect(existsSync(join(scratch, "report", "answer.json"))).toBe(false);
        expect(
          existsSync(join(scratch, "report", "delivery", "index.json")),
        ).toBe(true);
        return;
      }
      const answer = JSON.parse(
        readFileSync(join(scratch, "report", "answer.json"), "utf8"),
      );
      // A job without a model answers with what its media fixture carries:
      // a pull request job, the answer its media.ts built in data.pr.
      const media = noModel
        ? (JSON.parse(
            readFileSync(
              join(FIXTURE_WORKSPACE, "jobs", name, "fixtures", "media.json"),
              "utf8",
            ),
          ) as MediaManifest & { data?: { pr?: { answer: unknown } } })
        : undefined;
      const expected = media
        ? (media.data?.pr?.answer ?? videoAnswer(media))
        : JSON.parse(
            readFileSync(
              join(FIXTURE_WORKSPACE, "jobs", name, "fixtures", "output.json"),
              "utf8",
            ),
          );
      expect(answer).toEqual(expected);
    });
  });
});
