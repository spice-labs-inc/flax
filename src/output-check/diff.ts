/** One line of a hunk body: context, removed or added. */
export interface HunkLine {
  op: " " | "-" | "+";
  text: string;
}

export interface Hunk {
  /** 1-based start line on the old side, from the @@ header. */
  oldStart: number;
  header: string;
  lines: HunkLine[];
}

export interface FileDiff {
  /** The old path with any a/ prefix removed; null for /dev/null. */
  oldPath: string | null;
  /** The new path with any b/ prefix removed; null for /dev/null. */
  newPath: string | null;
  hunks: Hunk[];
  /** Git extended headers that change the file itself: new, deleted, renamed, copied, mode, binary. */
  fileOps: string[];
}

export type ParsedDiff = { files: FileDiff[] } | { error: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const FILE_OPS = [
  "new file mode",
  "deleted file mode",
  "rename from",
  "rename to",
  "copy from",
  "copy to",
  "old mode",
  "new mode",
  "similarity index",
  "dissimilarity index",
  "Binary files",
  "GIT binary patch",
];

function headerPath(line: string, prefix: "--- " | "+++ "): string | null {
  let path = line.slice(prefix.length);
  const tab = path.indexOf("\t");
  if (tab >= 0) path = path.slice(0, tab);
  path = path.trim();
  if (path === "/dev/null") return null;
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  return path;
}

function isFileStart(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  if (line.startsWith("diff --git ")) return true;
  return line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ");
}

/**
 * Parses a unified diff. Hunk line counts in the @@ headers are not
 * trusted: each hunk runs until the next hunk or file header, the way
 * `git apply --recount` reads a patch. An empty line inside a hunk is
 * read as an empty context line.
 */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const files: FileDiff[] = [];
  let pendingOps: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      pendingOps = [];
      i++;
      continue;
    }
    const op = FILE_OPS.find((p) => line.startsWith(p));
    if (op !== undefined) {
      pendingOps.push(op);
      i++;
      continue;
    }
    if (line.startsWith("index ") || line.trim() === "") {
      i++;
      continue;
    }
    if (!(line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")))
      return {
        error: `line ${i + 1} is not part of a unified diff: ${JSON.stringify(line.slice(0, 80))}`,
      };
    const file: FileDiff = {
      oldPath: headerPath(line, "--- "),
      newPath: headerPath(lines[i + 1]!, "+++ "),
      hunks: [],
      fileOps: pendingOps,
    };
    pendingOps = [];
    files.push(file);
    i += 2;
    while (i < lines.length && lines[i]!.startsWith("@@")) {
      const header = lines[i]!;
      const m = HUNK_HEADER.exec(header);
      if (m === null)
        return {
          error: `line ${i + 1} is not a valid hunk header: ${JSON.stringify(header.slice(0, 80))}`,
        };
      const hunk: Hunk = { oldStart: Number(m[1]), header, lines: [] };
      i++;
      while (
        i < lines.length &&
        !lines[i]!.startsWith("@@") &&
        !isFileStart(lines, i)
      ) {
        const body = lines[i]!;
        if (body.startsWith("\\")) {
          i++;
          continue;
        }
        const c = body[0];
        if (body === "") hunk.lines.push({ op: " ", text: "" });
        else if (c === " " || c === "-" || c === "+")
          hunk.lines.push({ op: c, text: body.slice(1) });
        else
          return {
            error: `line ${i + 1} in a hunk starts with neither a space, - nor +: ${JSON.stringify(body.slice(0, 80))}`,
          };
        i++;
      }
      file.hunks.push(hunk);
    }
  }
  if (files.length === 0) return { error: "the patch holds no file diff" };
  return { files };
}

export interface Applied {
  lines: string[];
  /** For each hunk, the 0-based line in the old file where it matched. */
  at: number[];
}

/**
 * Applies the hunks of one file diff to the old file's lines. Each hunk's
 * context and removed lines must match the file exactly; when they match
 * in more than one place, the one nearest the header's line wins, as with
 * `git apply`. Hunks must apply in order without overlapping.
 */
export function applyHunks(
  old: readonly string[],
  hunks: readonly Hunk[],
): Applied | { error: string } {
  const out: string[] = [];
  const at: number[] = [];
  let cursor = 0;
  for (const [n, hunk] of hunks.entries()) {
    const before = hunk.lines.filter((l) => l.op !== "+").map((l) => l.text);
    const after = hunk.lines.filter((l) => l.op !== "-").map((l) => l.text);
    const hint = before.length === 0 ? hunk.oldStart : hunk.oldStart - 1;
    let pos = -1;
    if (before.length === 0) {
      if (hint >= cursor && hint <= old.length) pos = hint;
    } else {
      let best = Number.POSITIVE_INFINITY;
      for (let p = cursor; p + before.length <= old.length; p++) {
        let same = true;
        for (let k = 0; k < before.length; k++) {
          if (old[p + k] !== before[k]) {
            same = false;
            break;
          }
        }
        if (same && Math.abs(p - hint) < best) {
          best = Math.abs(p - hint);
          pos = p;
        }
      }
    }
    if (pos < 0)
      return {
        error: `hunk ${n + 1} (${hunk.header.slice(0, 40)}) does not apply: its context and removed lines are not in the file${cursor > 0 ? " after the previous hunk" : ""}`,
      };
    out.push(...old.slice(cursor, pos), ...after);
    at.push(pos);
    cursor = pos + before.length;
  }
  out.push(...old.slice(cursor));
  return { lines: out, at };
}
