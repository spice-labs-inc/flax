import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { folderCheck } from "../src/check/folder.ts";
import { jobFiles, makeRepo, run } from "./helpers.ts";

function repoWith(
  files: Record<string, string | null>,
  extra: Parameters<typeof makeRepo>[0] = {},
): string {
  return makeRepo({
    ...extra,
    jobs: { demo: { ...jobFiles("demo"), ...files } },
  });
}

describe("job folder contents", () => {
  it("accepts the required files plus the optional collect.ts and SHADOW_RUNS.md", async () => {
    const root = repoWith({
      "collect.ts": "export {};\n",
      "SHADOW_RUNS.md": "none yet\n",
    });
    expect(await run(folderCheck, root)).toEqual([]);
  });

  it("rejects anything else in a job folder", async () => {
    const problems = await run(
      folderCheck,
      repoWith({ Dockerfile: "FROM scratch\n", "run.yml": "x: 1\n" }),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(
      /^jobs\/demo\/Dockerfile: is not allowed in a job folder/,
    );
    expect(problems[1]).toMatch(
      /^jobs\/demo\/run\.yml: is not allowed in a job folder/,
    );
  });

  it("reports missing required files", async () => {
    expect(await run(folderCheck, repoWith({ "prompt.md": null }))).toEqual([
      "jobs/demo/prompt.md: is missing",
    ]);
    expect(
      await run(folderCheck, repoWith({ "fixtures/input.json": null })),
    ).toEqual(["jobs/demo/fixtures/input.json: is missing"]);
  });

  it("rejects an empty prompt", async () => {
    expect(await run(folderCheck, repoWith({ "prompt.md": "  \n" }))).toEqual([
      "jobs/demo/prompt.md: is empty",
    ]);
  });

  it("rejects extra files in fixtures/", async () => {
    const problems = await run(
      folderCheck,
      repoWith({ "fixtures/secret.env": "A=1\n" }),
    );
    expect(problems).toEqual([
      "jobs/demo/fixtures/secret.env: is not allowed in fixtures/ (allowed: input.json, output.json, media.json, media)",
    ]);
  });

  it("requires output.json to be a JSON Schema that compiles", async () => {
    const bad = await run(
      folderCheck,
      repoWith({ "output.json": JSON.stringify({ type: "nope" }) }),
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(
      /^jobs\/demo\/output\.json: is not a valid JSON Schema: /,
    );
    const typo = await run(
      folderCheck,
      repoWith({
        "output.json": JSON.stringify({ type: "object", requried: [] }),
      }),
    );
    expect(typo[0]).toMatch(
      /^jobs\/demo\/output\.json: is not a valid JSON Schema: .*requried/,
    );
    expect(await run(folderCheck, repoWith({ "output.json": "{" }))).toEqual([
      expect.stringMatching(/^jobs\/demo\/output\.json: is not valid JSON: /),
    ]);
  });

  it("requires fixtures/output.json to match output.json", async () => {
    const problems = await run(
      folderCheck,
      repoWith({ "fixtures/output.json": JSON.stringify({ sumary: "x" }) }),
    );
    expect(problems).toEqual([
      "jobs/demo/fixtures/output.json: summary: does not match output.json: is required",
      "jobs/demo/fixtures/output.json: sumary: does not match output.json: is not an allowed key",
    ]);
  });

  it("leaves room for the maintainer notes: an object at the top of output.json, the key free, and notes in a fixture valid", async () => {
    expect(
      await run(
        folderCheck,
        repoWith({
          "output.json": JSON.stringify({ type: "array" }),
          "fixtures/output.json": "[]",
        }),
      ),
    ).toEqual([
      "jobs/demo/output.json: must have type: object at the top, so the runner can add maintainer_notes to it",
    ]);
    expect(
      await run(
        folderCheck,
        repoWith({
          "output.json": JSON.stringify({
            type: "object",
            properties: { maintainer_notes: { type: "string" } },
          }),
        }),
      ),
    ).toEqual([
      "jobs/demo/output.json: maintainer_notes is reserved for the runner's maintainer notes",
    ]);
    const note = { kind: "limit_hit", text: "Ran out of turns." };
    expect(
      await run(
        folderCheck,
        repoWith({
          "fixtures/output.json": JSON.stringify({
            summary: "x",
            maintainer_notes: [note],
          }),
        }),
      ),
    ).toEqual([]);
    expect(
      await run(
        folderCheck,
        repoWith({
          "fixtures/output.json": JSON.stringify({
            summary: "x",
            maintainer_notes: [{ ...note, kind: "gripe" }],
          }),
        }),
      ),
    ).toEqual([
      "jobs/demo/fixtures/output.json: maintainer_notes: does not match the maintainer notes schema: [0].kind: must be one of missing_data, missing_tool, unclear_prompt, limit_hit",
    ]);
  });

  it("requires fixtures/input.json to be JSON", async () => {
    expect(
      await run(folderCheck, repoWith({ "fixtures/input.json": "not json" })),
    ).toEqual([
      expect.stringMatching(
        /^jobs\/demo\/fixtures\/input\.json: is not valid JSON: /,
      ),
    ]);
  });

  it("rejects symlinks, which could point outside the job", async () => {
    const root = repoWith({ "prompt.md": null });
    symlinkSync("/etc/hostname", join(root, "jobs/demo/prompt.md"));
    expect(await run(folderCheck, root)).toEqual([
      "jobs/demo/prompt.md: must not be a symlink",
    ]);
  });

  it("rejects files directly under jobs/", async () => {
    const root = makeRepo({ files: { "jobs/notes.txt": "hi\n" } });
    expect(await run(folderCheck, root)).toEqual([
      "jobs/notes.txt: is not allowed in jobs/; each job is a directory",
    ]);
  });
});
