import { describe, expect, it } from "vitest";
import { folderCheck, NO_MODEL_ABSENT } from "../src/check/folder.ts";
import { JOB_SCRIPTS } from "../src/lib/paths.ts";
import { checkPublished } from "../src/run-job/publish-script.ts";
import { jobFiles, makeRepo, run } from "./helpers.ts";

describe("publish.ts", () => {
  it("is a job script the runner bundles, and a job with model: none has none", () => {
    expect(JOB_SCRIPTS).toContain("publish.ts");
    expect(NO_MODEL_ABSENT).toContain("publish.ts");
  });

  it("is refused in a job whose output is not a pull request", async () => {
    const root = makeRepo({
      jobs: {
        demo: { ...jobFiles("demo"), "publish.ts": "export {};\n" },
      },
    });
    expect(await run(folderCheck, root)).toEqual([
      "jobs/demo/publish.ts: is only for a job with output kind pr: it turns the model's answer into the pull request, or into nothing",
    ]);
  });

  it("is needed by a job that sets drop_refused_changes, which rebuilds its answer without the changes the second check refused", async () => {
    const output = {
      kind: "pr",
      repos: ["notes-co/atlas"],
      paths: ["repos/*.md"],
      max_changed_lines: 40,
      untrusted_input: "open_pr",
      drop_refused_changes: true,
    };
    const without = makeRepo({ jobs: { demo: jobFiles("demo", { output }) } });
    expect(await run(folderCheck, without)).toEqual([
      "jobs/demo/job.yml: output.drop_refused_changes: needs a publish.ts to rebuild the answer without the changes the second check refused, and the job has none",
    ]);
    const withScript = makeRepo({
      jobs: {
        demo: {
          ...jobFiles("demo", { output }),
          "publish.ts": "export {};\n",
        },
      },
    });
    expect(await run(folderCheck, withScript)).toEqual([]);
  });

  it("prints publish true with the patch set, or publish false with a one-line reason", () => {
    expect(checkPublished({ publish: true, answer: { pages: [] } })).toEqual({
      publish: true,
      answer: { pages: [] },
    });
    expect(
      checkPublished({ publish: false, reason: "too little", record: [1] }),
    ).toEqual({ publish: false, reason: "too little", record: [1] });
    for (const [value, error] of [
      [[], "it is not a JSON object"],
      [{ publish: "yes" }, "publish is not true or false"],
      [{ publish: true }, "publish is true but answer is not an object"],
      [
        { publish: true, answer: {}, reason: "r" },
        "publish is true, so it takes no reason",
      ],
      [{ publish: false }, "publish is false but there is no reason"],
      [
        { publish: false, reason: "a\nb" },
        "the reason must be one line of at most 500 characters",
      ],
      [
        { publish: false, reason: "r", answer: {} },
        "publish is false, so it takes no answer",
      ],
      [{ publish: false, reason: "r", extra: 1 }, "it has the key extra"],
    ] as const)
      expect(checkPublished(value), JSON.stringify(value)).toEqual({ error });
  });
});
