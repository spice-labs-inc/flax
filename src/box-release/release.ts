import { execFile } from "node:child_process";
import { BOX_RELEASE_PATTERN, LBX_BINARY } from "../lib/box.ts";
import { boxRepository } from "../generate/render.ts";

/** The block lbx's release workflow writes into the release notes (its docs/releasing.md). */
export const NOTES_BEGIN = "<!-- llm-in-a-box release: begin -->";
export const NOTES_END = "<!-- llm-in-a-box release: end -->";

// With or without backticks: the workflow writes none, a person editing the notes may add them.
const COMMIT_LINE = /^- Commit: `?([0-9a-f]{40})`?$/;
const BINARY_LINE = /^- Binary: `?([A-Za-z0-9._-]+)`?(?: \(.*\))?$/;
const SHA256_FILE_LINE = /^([0-9a-f]{64})\s+\*?(\S+)/;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ReleaseArtifacts {
  commit: string;
  /** The launcher asset the notes name; LBX_BINARY when the block has no Binary line. */
  binary: string;
}

export interface ResolvedRelease extends ReleaseArtifacts {
  /** The sha256 of the binary, from the release's .sha256 asset. */
  sha256: string;
  /** The whole release notes text, carriage returns removed. */
  notes: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  file: string,
  args: readonly string[],
) => Promise<ExecResult>;

export function releaseTagProblem(tag: string): string | undefined {
  return BOX_RELEASE_PATTERN.test(tag)
    ? undefined
    : `${JSON.stringify(tag)} is not a sandbox (lbx) release tag vX.Y.Z`;
}

/** The commit and the binary name from the release notes block. */
export function parseReleaseNotes(body: string): Result<ReleaseArtifacts> {
  const lines = body.replaceAll("\r", "").split("\n");
  const begins = lines.flatMap((l, i) => (l === NOTES_BEGIN ? [i] : []));
  if (begins.length === 0)
    return {
      ok: false,
      error: `the release notes have no ${NOTES_BEGIN} line`,
    };
  if (begins.length > 1)
    return {
      ok: false,
      error: `the release notes have ${begins.length} ${NOTES_BEGIN} lines`,
    };
  const begin = begins[0]!;
  const end = lines.indexOf(NOTES_END, begin + 1);
  if (end === -1)
    return {
      ok: false,
      error: `the release notes block has no ${NOTES_END} line`,
    };
  const block = lines.slice(begin + 1, end);
  const matches = (line: RegExp) =>
    block.flatMap((l) => {
      const m = line.exec(l);
      return m === null ? [] : [m[1]!];
    });
  const commits = matches(COMMIT_LINE);
  if (commits.length !== 1)
    return {
      ok: false,
      error: `the release notes block needs exactly one "- Commit: \`<40 hex>\`" line, found ${commits.length}`,
    };
  const binaries = matches(BINARY_LINE);
  if (binaries.length > 1)
    return {
      ok: false,
      error: `the release notes block has ${binaries.length} "- Binary:" lines`,
    };
  return { ok: true, value: { commit: commits[0]!, binary: binaries[0] ?? LBX_BINARY } };
}

/** The sha256 from a `sha256sum` line for the binary. */
export function parseSha256File(text: string, binary: string): Result<string> {
  for (const line of text.replaceAll("\r", "").split("\n")) {
    const m = SHA256_FILE_LINE.exec(line.trim());
    if (m !== null && m[2] === binary) return { ok: true, value: m[1]! };
  }
  return { ok: false, error: `the release's ${binary}.sha256 names no sha256 for ${binary}` };
}

function failure(what: string, result: ExecResult): string {
  const detail = (result.stderr.trim() || result.stdout.trim()).split("\n")[0];
  return `${what} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`;
}

/**
 * Reads a sandbox (lbx) release: its notes, the commit and binary they name,
 * and the binary's sha256 from the release's .sha256 asset; when a checked
 * out commit is given, the notes must name it.
 */
export async function resolveRelease(options: {
  tag: string;
  checkoutCommit?: string;
  exec: Exec;
}): Promise<Result<ResolvedRelease>> {
  const { tag, checkoutCommit, exec } = options;
  const badTag = releaseTagProblem(tag);
  if (badTag !== undefined) return { ok: false, error: badTag };
  const view = await exec("gh", [
    "release",
    "view",
    tag,
    "--repo",
    boxRepository(),
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
  if (view.code !== 0)
    return {
      ok: false,
      error: failure(
        `reading the notes of ${boxRepository()} release ${tag}`,
        view,
      ),
    };
  const notes = view.stdout.replaceAll("\r", "");
  const parsed = parseReleaseNotes(notes);
  if (!parsed.ok) return parsed;
  const { commit, binary } = parsed.value;
  if (checkoutCommit !== undefined && commit !== checkoutCommit)
    return {
      ok: false,
      error: `the release notes name commit ${commit}, but tag ${tag} checks out ${checkoutCommit}`,
    };
  const sums = await exec("gh", [
    "release",
    "download",
    tag,
    "--repo",
    boxRepository(),
    "--pattern",
    `${binary}.sha256`,
    "--output",
    "-",
  ]);
  if (sums.code !== 0)
    return {
      ok: false,
      error: failure(`downloading ${binary}.sha256 of ${boxRepository()} release ${tag}`, sums),
    };
  const sha256 = parseSha256File(sums.stdout, binary);
  if (!sha256.ok) return sha256;
  return { ok: true, value: { commit, binary, sha256: sha256.value, notes } };
}

export const execCommand: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err === null ? 0 : typeof err.code === "number" ? err.code : 127;
        resolve({
          code,
          stdout,
          stderr: err !== null && stderr === "" ? err.message : stderr,
        });
      },
    );
  });
