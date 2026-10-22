import { createReadStream } from "node:fs";
import { Worker } from "node:worker_threads";
import { createGunzip } from "node:zlib";
import { tarFiles } from "./tar.ts";

/** The longest pattern and path filter commit_grep takes. */
export const MAX_GREP_PATTERN = 200;
export const MAX_GREP_GLOB = 200;

/** The most matches one commit_grep call returns. */
export const MAX_GREP_MATCHES = 200;
export const DEFAULT_GREP_MATCHES = 100;

/** What one commit_grep result may take, below gh-grep's result cap. */
export const GREP_RESULT_BYTES = 60_000;

/** A matched line longer than this is cut around the match. */
export const GREP_LINE_CHARS = 240;

/** Files bigger than this are not searched. */
export const GREP_FILE_BYTES = 1024 * 1024;

/** How long the pattern may run over one batch of files before the search is stopped. */
export const GREP_BATCH_MS = 10_000;

/** The archive limits: what a repository may unpack to, and how many entries it may hold. */
export const MAX_TAR_BYTES = 1024 * 1024 * 1024;
export const MAX_TAR_ENTRIES = 300_000;

/** How much text goes to the pattern worker at a time. */
const BATCH_CHARS = 4 * 1024 * 1024;

/** git's own test for a binary file: a NUL byte in its first 8000 bytes. */
const BINARY_PROBE = 8000;

const UNBOUNDED_REPEAT = 10;

/**
 * Why a commit_grep pattern is refused, or undefined when it may run. A
 * pattern is a JavaScript regular expression of at most 200 characters,
 * without back references or lookarounds, without a repeated group that
 * holds a repetition or an alternation (the shapes that backtrack without
 * end), and must not match an empty line.
 */
export function grepPatternProblem(
  pattern: string,
  ignoreCase = false,
): string | undefined {
  if (pattern.length === 0 || pattern.length > MAX_GREP_PATTERN)
    return `the pattern must be 1 to ${MAX_GREP_PATTERN} characters`;
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? "ui" : "u");
  } catch (err) {
    return `the pattern is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (/\\[1-9]|\\k</.test(pattern))
    return "the pattern may not use back references";
  if (/\(\?<?[=!]/.test(pattern)) return "the pattern may not use lookarounds";
  const nested = nestedRepeat(pattern);
  if (nested !== undefined) return nested;
  if (re.test("")) return "the pattern matches every line";
  return undefined;
}

interface Frame {
  /** The group holds a quantifier or an alternation, directly or deeper. */
  risky: boolean;
}

function unboundedAt(pattern: string, i: number): number {
  const c = pattern[i];
  if (c === "*" || c === "+") return 1;
  if (c !== "{") return 0;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
  if (m === null) return 0;
  if (m[2] === undefined) return 0;
  if (m[3] === "" || Number(m[3]) > UNBOUNDED_REPEAT) return m[0].length;
  return 0;
}

/** A repeated group that holds a repetition or an alternation, such as (a+)+ or (a|aa)*. */
function nestedRepeat(pattern: string): string | undefined {
  const stack: Frame[] = [{ risky: false }];
  let closed: Frame | undefined;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const next = pattern[i + 1];
      if (
        (next === "p" || next === "P" || next === "u") &&
        pattern[i + 2] === "{"
      ) {
        const end = pattern.indexOf("}", i + 2);
        i = end === -1 ? pattern.length : end;
      } else i += 1;
      closed = undefined;
      continue;
    }
    if (c === "[") {
      for (i += 1; i < pattern.length && pattern[i] !== "]"; i++)
        if (pattern[i] === "\\") i += 1;
      closed = undefined;
      continue;
    }
    if (c === "(") {
      stack.push({ risky: false });
      if (pattern[i + 1] === "?") {
        const name = /^\?(?::|<[A-Za-z_$][\w$]*>)/.exec(pattern.slice(i + 1));
        if (name !== null) i += name[0].length;
      }
      closed = undefined;
      continue;
    }
    if (c === ")") {
      const frame = stack.length > 1 ? stack.pop()! : stack[0]!;
      if (frame.risky) stack.at(-1)!.risky = true;
      closed = frame;
      continue;
    }
    if (c === "|") {
      stack.at(-1)!.risky = true;
      closed = undefined;
      continue;
    }
    const quantifier =
      c === "*" ||
      c === "+" ||
      c === "?" ||
      /^\{\d+(,\d*)?\}/.test(pattern.slice(i));
    if (quantifier) {
      if (closed?.risky === true && unboundedAt(pattern, i) > 0)
        return "the pattern repeats a group that itself repeats or has alternatives, which can run without end; repeat a character class instead";
      stack.at(-1)!.risky = true;
      if (c === "{") i = pattern.indexOf("}", i);
      if (pattern[i + 1] === "?") i += 1;
      closed = undefined;
      continue;
    }
    closed = undefined;
  }
  return undefined;
}

/**
 * A path filter as a regular expression: * is any run of characters
 * other than /, ** any run including /, ? one character other than /.
 * A filter without / matches the file name in any directory.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return glob.includes("/")
    ? new RegExp(`^${out}$`)
    : new RegExp(`(?:^|/)${out}$`);
}

/** The search was stopped: its pattern ran too long, or the call ended. The archive is not at fault. */
export class SearchStopped extends Error {
  override name = "SearchStopped";
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

// The pattern runs in a worker thread, so a pattern that backtracks for
// long can be stopped by ending the thread; the tools server's own event
// loop never runs it.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const re = new RegExp(workerData.source, workerData.flags);
const clip = workerData.lineChars;
parentPort.on("message", (msg) => {
  const out = [];
  outer: for (const f of msg.files) {
    const lines = f.text.split("\\n");
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (line.endsWith("\\r")) line = line.slice(0, -1);
      const m = re.exec(line);
      if (m === null) continue;
      let text = line;
      if (line.length > clip) {
        const from = Math.max(0, Math.min(m.index - 40, line.length - clip));
        text = (from > 0 ? "..." : "") + line.slice(from, from + clip) + (from + clip < line.length ? "..." : "");
      }
      out.push({ path: f.path, line: i + 1, text });
      if (out.length >= msg.limit) break outer;
    }
  }
  parentPort.postMessage(out);
});
`;

/** Runs one pattern over batches of files in a worker thread, each batch within a time limit. */
export class PatternRunner {
  private readonly worker: Worker;
  private readonly batchMs: number;
  private failed: Error | undefined;

  constructor(source: string, flags: string, batchMs = GREP_BATCH_MS) {
    this.batchMs = batchMs;
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source, flags, lineChars: GREP_LINE_CHARS },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    this.worker.on("error", (err) => {
      this.failed = err;
    });
  }

  search(
    files: { path: string; text: string }[],
    limit: number,
    signal: AbortSignal,
  ): Promise<GrepMatch[]> {
    if (this.failed !== undefined) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const done = (fn: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
        fn();
      };
      const onMessage = (matches: GrepMatch[]) => done(() => resolve(matches));
      const onError = (err: Error) => done(() => reject(err));
      const onAbort = () =>
        done(() => {
          void this.worker.terminate();
          reject(new SearchStopped("the search was stopped"));
        });
      const timer = setTimeout(
        () =>
          done(() => {
            void this.worker.terminate();
            reject(
              new SearchStopped(
                `the pattern ran for more than ${this.batchMs / 1000} seconds over one batch of files and was stopped; use a simpler pattern or fixed_string`,
              ),
            );
          }),
        this.batchMs,
      );
      signal.addEventListener("abort", onAbort, { once: true });
      this.worker.on("message", onMessage);
      this.worker.on("error", onError);
      this.worker.postMessage({ files, limit });
    });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }
}

export interface GrepOptions {
  pattern: string;
  fixedString: boolean;
  ignoreCase: boolean;
  glob: string | undefined;
  maxMatches: number;
  signal: AbortSignal;
  batchMs?: number;
  maxResultBytes?: number;
}

export interface GrepSummary {
  matches: GrepMatch[];
  files_matched: number;
  files_searched: number;
  binary_skipped: number;
  large_skipped: number;
  /** Why the search stopped early: the match limit or the size limit. */
  stopped?: "matches" | "bytes";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchLine(m: GrepMatch): string {
  return `${m.path}:${m.line}:${m.text}`;
}

/**
 * Searches the text files of a GitHub tarball on disk for one pattern, as
 * git grep does at a commit: files over 1 MiB and binary files (a NUL
 * byte near the start) are skipped, and the matches stop at maxMatches or
 * when their lines reach the result's size.
 */
export async function grepTarball(
  file: string,
  options: GrepOptions,
): Promise<GrepSummary> {
  const source = options.fixedString
    ? escapeRegExp(options.pattern)
    : options.pattern;
  const flags = options.ignoreCase ? "ui" : "u";
  const glob =
    options.glob === undefined ? undefined : globToRegExp(options.glob);
  const maxBytes = options.maxResultBytes ?? GREP_RESULT_BYTES;
  const summary: GrepSummary = {
    matches: [],
    files_matched: 0,
    files_searched: 0,
    binary_skipped: 0,
    large_skipped: 0,
  };
  const runner = new PatternRunner(source, flags, options.batchMs);
  const stream = createReadStream(file);
  const gunzip = createGunzip();
  stream.on("error", (err) => gunzip.destroy(err));
  stream.pipe(gunzip);
  let bytes = 0;
  let batch: { path: string; text: string }[] = [];
  let batchChars = 0;
  const flush = async (): Promise<boolean> => {
    if (batch.length === 0) return true;
    const found = await runner.search(
      batch,
      options.maxMatches - summary.matches.length,
      options.signal,
    );
    batch = [];
    batchChars = 0;
    const paths = new Set(summary.matches.map((m) => m.path));
    for (const m of found) {
      const size = Buffer.byteLength(matchLine(m)) + 1;
      if (bytes + size > maxBytes) {
        summary.stopped = "bytes";
        break;
      }
      bytes += size;
      summary.matches.push(m);
      paths.add(m.path);
    }
    summary.files_matched = paths.size;
    if (
      summary.stopped === undefined &&
      summary.matches.length >= options.maxMatches
    )
      summary.stopped = "matches";
    return summary.stopped === undefined;
  };
  try {
    for await (const entry of tarFiles(
      gunzip,
      (path, size) =>
        size <= GREP_FILE_BYTES && (glob === undefined || glob.test(path)),
      { maxBytes: MAX_TAR_BYTES, maxEntries: MAX_TAR_ENTRIES },
    )) {
      if (options.signal.aborted)
        throw new SearchStopped("the search was stopped");
      if (glob !== undefined && !glob.test(entry.path)) continue;
      if (entry.data === undefined) {
        summary.large_skipped += 1;
        continue;
      }
      if (entry.data.subarray(0, BINARY_PROBE).includes(0)) {
        summary.binary_skipped += 1;
        continue;
      }
      summary.files_searched += 1;
      const text = entry.data.toString("utf8");
      batch.push({ path: entry.path, text });
      batchChars += text.length;
      if (batchChars >= BATCH_CHARS && !(await flush())) break;
    }
    if (summary.stopped === undefined) await flush();
  } finally {
    stream.destroy();
    gunzip.destroy();
    await runner.close();
  }
  return summary;
}
