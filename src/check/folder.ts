import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { createAjv, describeErrors } from "../lib/ajv.ts";
import {
  MAINTAINER_NOTES_KEY,
  maintainerNotesProblems,
  notesSchemaProblem,
  splitMaintainerNotes,
} from "../lib/maintainer-notes.ts";
import { usesModel } from "../lib/job.ts";
import { jobFile, JOBS_DIR } from "../lib/paths.ts";
import { firstLine, problem, type Problem } from "../lib/problem.ts";
import { byCodePoint } from "../lib/sort.ts";
import type { Check } from "./types.ts";

type Kind = "file" | "dir";

export const JOB_ENTRIES: Readonly<
  Record<string, { kind: Kind; required: boolean }>
> = {
  "job.yml": { kind: "file", required: true },
  "prompt.md": { kind: "file", required: true },
  "output.json": { kind: "file", required: true },
  "media.ts": { kind: "file", required: false },
  "collect.ts": { kind: "file", required: false },
  "render.ts": { kind: "file", required: false },
  "publish.ts": { kind: "file", required: false },
  fixtures: { kind: "dir", required: true },
  "SHADOW_RUNS.md": { kind: "file", required: false },
};

export const FIXTURE_ENTRIES = [
  "input.json",
  "output.json",
  "media.json",
  "media",
] as const;

/** What a job with model: none has no use for: it runs no model and no job script, and the kit builds its answer. */
export const NO_MODEL_ABSENT = [
  "prompt.md",
  "output.json",
  "collect.ts",
  "render.ts",
  "publish.ts",
] as const;

function kindOf(path: string): Kind | "symlink" | "other" {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "dir";
  if (stat.isFile()) return "file";
  return "other";
}

function readJson(root: string, file: string, problems: Problem[]): unknown {
  try {
    return JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch (err) {
    problems.push(problem(file, `is not valid JSON: ${firstLine(err)}`));
    return undefined;
  }
}

/** Checks that an entry exists with the right kind. Symlinks never count: they could point anywhere. */
function expectEntry(
  root: string,
  file: string,
  kind: Kind,
  problems: Problem[],
): boolean {
  const path = join(root, file);
  if (!existsSync(path) && !isSymlink(path)) {
    problems.push(problem(file, "is missing"));
    return false;
  }
  const actual = kindOf(path);
  if (actual !== kind) {
    problems.push(
      problem(
        file,
        actual === "symlink"
          ? "must not be a symlink"
          : `must be a ${kind === "dir" ? "directory" : "file"}`,
      ),
    );
    return false;
  }
  return true;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function checkOutputSchema(
  root: string,
  name: string,
  problems: Problem[],
): ValidateFunction | undefined {
  const file = jobFile(name, "output.json");
  const schema = readJson(root, file, problems);
  if (schema === undefined) return undefined;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    problems.push(problem(file, "must be a JSON Schema object"));
    return undefined;
  }
  let validate: ValidateFunction;
  try {
    validate = createAjv().compile(schema);
  } catch (err) {
    problems.push(
      problem(file, `is not a valid JSON Schema: ${firstLine(err)}`),
    );
    return undefined;
  }
  const notesProblem = notesSchemaProblem(schema);
  if (notesProblem !== undefined) problems.push(problem(file, notesProblem));
  return validate;
}

export function checkJobFolder(
  root: string,
  name: string,
  noModel = false,
): Problem[] {
  const problems: Problem[] = [];
  const dir = join(root, JOBS_DIR, name);
  const entries = readdirSync(dir).sort(byCodePoint);
  for (const entry of entries) {
    if (!(entry in JOB_ENTRIES)) {
      problems.push(
        problem(
          jobFile(name, entry),
          `is not allowed in a job folder (allowed: ${Object.keys(JOB_ENTRIES).join(", ")})`,
        ),
      );
    }
  }
  const present = new Set<string>();
  for (const [entry, spec] of Object.entries(JOB_ENTRIES)) {
    const file = jobFile(name, entry);
    if (noModel && (NO_MODEL_ABSENT as readonly string[]).includes(entry)) {
      if (existsSync(join(root, file)) || isSymlink(join(root, file)))
        problems.push(
          problem(
            file,
            "is not taken by a job with model: none, which runs no model and no job script",
          ),
        );
      continue;
    }
    if (
      (!spec.required || (noModel && entry === "fixtures")) &&
      !existsSync(join(root, file)) &&
      !isSymlink(join(root, file))
    )
      continue;
    if (expectEntry(root, file, spec.kind, problems)) present.add(entry);
  }

  if (
    present.has("prompt.md") &&
    readFileSync(join(root, jobFile(name, "prompt.md")), "utf8").trim() === ""
  ) {
    problems.push(problem(jobFile(name, "prompt.md"), "is empty"));
  }

  let validateOutput: ValidateFunction | undefined;
  if (present.has("output.json"))
    validateOutput = checkOutputSchema(root, name, problems);

  if (present.has("fixtures")) {
    for (const entry of readdirSync(join(dir, "fixtures")).sort(byCodePoint)) {
      if (!(FIXTURE_ENTRIES as readonly string[]).includes(entry)) {
        problems.push(
          problem(
            jobFile(name, `fixtures/${entry}`),
            `is not allowed in fixtures/ (allowed: ${FIXTURE_ENTRIES.join(", ")})`,
          ),
        );
      }
    }
    // A job with model: none has no input or answer to give a stub run.
    const input = jobFile(name, "fixtures/input.json");
    if (!noModel && expectEntry(root, input, "file", problems))
      readJson(root, input, problems);
    const output = jobFile(name, "fixtures/output.json");
    if (!noModel && expectEntry(root, output, "file", problems)) {
      const read = readJson(root, output, problems);
      // A fixture may carry maintainer notes, which the runner takes off before the job's schema sees the answer.
      const split = splitMaintainerNotes(read);
      if (split.warning !== undefined)
        for (const p of maintainerNotesProblems(
          (read as Record<string, unknown>)[MAINTAINER_NOTES_KEY],
        ))
          problems.push(
            problem(
              output,
              `does not match the maintainer notes schema: ${p}`,
              MAINTAINER_NOTES_KEY,
            ),
          );
      const sample = split.answer;
      if (
        sample !== undefined &&
        validateOutput !== undefined &&
        !validateOutput(sample)
      ) {
        for (const e of describeErrors(validateOutput.errors)) {
          problems.push(
            problem(
              output,
              `does not match output.json: ${e.message}`,
              e.field,
            ),
          );
        }
      }
    }
  }
  return problems;
}

/** Job folders hold only the allowed files, and the fixtures match output.json. */
export const folderCheck: Check = {
  id: "folder",
  title: "job folders hold only the allowed files",
  run: (repo) => [
    ...repo.strayEntries.map((entry) =>
      problem(
        `${JOBS_DIR}/${entry}`,
        "is not allowed in jobs/; each job is a directory",
      ),
    ),
    ...repo.jobs.flatMap((job) =>
      checkJobFolder(
        repo.root,
        job.name,
        job.config !== undefined && !usesModel(job.config),
      ),
    ),
    ...repo.jobs.flatMap((job) =>
      (job.config?.collect_tools ?? []).length > 0 &&
      !existsSync(join(repo.root, jobFile(job.name, "collect.ts")))
        ? [
            problem(
              jobFile(job.name, "job.yml"),
              "names tools for collect.ts, but the job has no collect.ts",
              "collect_tools",
            ),
          ]
        : [],
    ),
    ...repo.jobs.flatMap((job) =>
      job.config?.output.kind === "pr" &&
      job.config.output.drop_refused_changes === true &&
      !existsSync(join(repo.root, jobFile(job.name, "publish.ts")))
        ? [
            problem(
              jobFile(job.name, "job.yml"),
              "needs a publish.ts to rebuild the answer without the changes the second check refused, and the job has none",
              "output.drop_refused_changes",
            ),
          ]
        : [],
    ),
    ...repo.jobs.flatMap((job) =>
      job.config !== undefined &&
      job.config.output.kind !== "pr" &&
      existsSync(join(repo.root, jobFile(job.name, "publish.ts")))
        ? [
            problem(
              jobFile(job.name, "publish.ts"),
              "is only for a job with output kind pr: it turns the model's answer into the pull request, or into nothing",
            ),
          ]
        : [],
    ),
  ],
};
