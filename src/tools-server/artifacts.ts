import { crc32, inflateRawSync } from "node:zlib";
import {
  MAINTAINER_NOTES_FILE,
  maintainerNotesProblems,
  notesArtifact,
  type MaintainerNote,
} from "../lib/maintainer-notes.ts";
import type { CodeReader } from "./code-reader.ts";
import type { CompareReader } from "./compare.ts";
import { errorChain } from "./errors.ts";
import {
  CODE_OPERATIONS,
  GITHUB_API,
  githubGuard,
  NATIVE_GITHUB_OPERATIONS,
} from "./github.ts";
import type { Upstream } from "./upstreams.ts";

/** The most runs one maintainer_notes_list call reads, newest first. */
export const MAX_NOTES_RUNS = 40;
export const MAX_NOTES_DAYS = 14;
/** A notes artifact is one small JSON file; anything bigger is not one. */
export const MAX_NOTES_ZIP_BYTES = 256 * 1024;
export const MAX_NOTES_FILE_BYTES = 64 * 1024;

const JOB_NAME = /^[a-z][a-z0-9-]{1,40}$/;
const DAY_MS = 24 * 3600 * 1000;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function unreadable(reason: string): Error {
  return new Error(
    `the artifact is not a zip archive this reader takes: ${reason}`,
  );
}

/**
 * One file from a zip archive in memory, by its exact name at the top of
 * the archive, or undefined when the archive has no such file. Only stored
 * and deflated files are read, never more than maxBytes, and the checksum
 * must match. Encrypted and ZIP64 archives are refused.
 */
export function readZipEntry(
  zip: Buffer,
  name: string,
  maxBytes: number,
): Buffer | undefined {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--)
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw unreadable("no end of central directory");
  const entries = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > eocd)
    throw unreadable("the directory is out of bounds");
  let at = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > eocd || zip.readUInt32LE(at) !== CENTRAL)
      throw unreadable("a directory entry is malformed");
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    if (at + 46 + nameLength > eocd)
      throw unreadable("a directory entry is malformed");
    const entryName = zip.toString("latin1", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if ((flags & 1) !== 0) throw unreadable("the file is encrypted");
    if (
      compressed === 0xffffffff ||
      size === 0xffffffff ||
      local === 0xffffffff
    )
      throw unreadable("ZIP64 is not read");
    if (size > maxBytes)
      throw new Error(
        `${name} is ${size} bytes, over the ${maxBytes} byte limit`,
      );
    if (local + 30 > cdOffset || zip.readUInt32LE(local) !== LOCAL)
      throw unreadable("a file header is malformed");
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + compressed > cdOffset)
      throw unreadable("a file is out of bounds");
    const data = zip.subarray(start, start + compressed);
    let out: Buffer;
    if (method === 0) out = Buffer.from(data);
    else if (method === 8) {
      try {
        out = inflateRawSync(data, { maxOutputLength: maxBytes });
      } catch (err) {
        throw unreadable(`${name} does not inflate (${errorChain(err)})`);
      }
    } else throw unreadable(`compression method ${method} is not read`);
    if (out.length !== size || crc32(out) !== crc)
      throw unreadable(`${name} does not match its size and checksum`);
    return out;
  }
  return undefined;
}

export interface NotesReaderOptions {
  token: string;
  apiUrl?: string;
  /** The exact hosts GitHub may send an artifact download to: those in github-log-hosts.yml. */
  downloadHosts: readonly string[];
  fetch?: typeof fetch;
  /** Takes plain http downloads; only tests set it. */
  allowHttp?: boolean;
  now?: () => Date;
}

export interface NotesRun {
  run_id: number;
  branch: string;
  created_at: string;
  notes: MaintainerNote[];
}

interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  size_in_bytes: number;
  created_at: string;
  workflow_run?: { id?: number; head_branch?: string };
}

function artifactApi(
  options: NotesReaderOptions,
  path: string,
  signal: AbortSignal,
): Promise<Response> {
  return (options.fetch ?? fetch)(`${options.apiUrl ?? GITHUB_API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${options.token}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "manual",
    signal,
  });
}

/**
 * One artifact's zip, from the host GitHub redirects the download to: only
 * a host in github-log-hosts.yml, over https, without the token, and never
 * more than maxBytes.
 */
async function downloadArtifact(
  options: NotesReaderOptions,
  repoPath: string,
  id: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const redirect = await artifactApi(
    options,
    `${repoPath}/actions/artifacts/${id}/zip`,
    signal,
  );
  await redirect.body?.cancel();
  const location = redirect.headers.get("location");
  if (redirect.status < 300 || redirect.status > 399 || location === null)
    throw new Error(`downloading the artifact returned ${redirect.status}`);
  const url = new URL(location);
  if (
    !(
      url.protocol === "https:" ||
      (options.allowHttp === true && url.protocol === "http:")
    ) ||
    !options.downloadHosts.includes(url.hostname)
  )
    throw new Error(
      `GitHub sent the download to ${url.protocol}//${url.hostname}, which is not a host in github-log-hosts.yml`,
    );
  const res = await (options.fetch ?? fetch)(url, {
    redirect: "error",
    signal,
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`the download returned ${res.status}`);
  }
  return readCapped(res, maxBytes);
}

/**
 * maintainer_notes_list: the maintainer notes of one job's runs in the last
 * days, read from each run's job-<name>-maintainer-notes artifact with the
 * run's read-only token. It lists the artifacts by their exact name,
 * downloads each small zip from the host GitHub redirects to (only a host
 * in github-log-hosts.yml, over https, without the token), and returns only
 * notes that match the notes schema.
 */
export class MaintainerNotesReader {
  private readonly options: NotesReaderOptions;

  constructor(options: NotesReaderOptions) {
    this.options = options;
  }

  private api(path: string, signal: AbortSignal): Promise<Response> {
    return artifactApi(this.options, path, signal);
  }

  async list(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const extra = Object.keys(args).filter(
      (k) => !["owner", "repo", "job", "days"].includes(k),
    );
    if (extra.length > 0)
      throw new Error(`maintainer_notes_list takes no ${extra.join(", ")}`);
    const { owner, repo, job, days } = args;
    if (typeof job !== "string" || !JOB_NAME.test(job))
      throw new Error(`"${String(job)}" is not a job name`);
    if (
      typeof days !== "number" ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > MAX_NOTES_DAYS
    )
      throw new Error(
        `days must be a whole number from 1 to ${MAX_NOTES_DAYS}`,
      );
    const repoPath = `/repos/${encodeURIComponent(String(owner))}/${encodeURIComponent(String(repo))}`;
    const name = notesArtifact(job);
    const since = new Date(
      (this.options.now ?? (() => new Date()))().getTime() - days * DAY_MS,
    );

    const res = await this.api(
      `${repoPath}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
      signal,
    );
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`listing the artifacts returned ${res.status}`);
    }
    const listed = ((await res.json()) as { artifacts?: unknown }).artifacts;
    const artifacts = (Array.isArray(listed) ? (listed as Artifact[]) : [])
      .filter(
        (a) =>
          a.name === name &&
          a.expired !== true &&
          typeof a.id === "number" &&
          Date.parse(a.created_at) >= since.getTime(),
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    const runs: NotesRun[] = [];
    const skipped: { run_id: number | null; reason: string }[] = [];
    for (const artifact of artifacts.slice(0, MAX_NOTES_RUNS)) {
      const runId = artifact.workflow_run?.id ?? null;
      try {
        if (artifact.size_in_bytes > MAX_NOTES_ZIP_BYTES)
          throw new Error(
            `the artifact is ${artifact.size_in_bytes} bytes, over the ${MAX_NOTES_ZIP_BYTES} byte limit`,
          );
        const notes = await this.readNotes(repoPath, artifact.id, signal);
        runs.push({
          run_id: runId ?? 0,
          branch: artifact.workflow_run?.head_branch ?? "",
          created_at: artifact.created_at,
          notes,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        skipped.push({ run_id: runId, reason: errorChain(err) });
      }
    }
    return JSON.stringify({
      job,
      since: since.toISOString(),
      runs,
      skipped,
      left_out: Math.max(0, artifacts.length - MAX_NOTES_RUNS),
    });
  }

  private async readNotes(
    repoPath: string,
    id: number,
    signal: AbortSignal,
  ): Promise<MaintainerNote[]> {
    const zip = await downloadArtifact(
      this.options,
      repoPath,
      id,
      MAX_NOTES_ZIP_BYTES,
      signal,
    );
    const file = readZipEntry(zip, MAINTAINER_NOTES_FILE, MAX_NOTES_FILE_BYTES);
    if (file === undefined)
      throw new Error(`the artifact has no ${MAINTAINER_NOTES_FILE}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.toString("utf8"));
    } catch {
      throw new Error(`${MAINTAINER_NOTES_FILE} is not JSON`);
    }
    const notes = (parsed as { notes?: unknown } | null)?.notes;
    if (maintainerNotesProblems(notes).length > 0)
      throw new Error(`${MAINTAINER_NOTES_FILE} does not hold valid notes`);
    return notes as MaintainerNote[];
  }
}

/** A run report artifact holds transcripts too; only status.json and input.json are read from it. */
export const MAX_REPORT_ZIP_BYTES = 64 * 1024 * 1024;
export const MAX_REPORT_STATUS_BYTES = 1024 * 1024;
export const MAX_REPORT_INPUT_BYTES = 16 * 1024 * 1024;
/** The most entries each list of a run report digest keeps. */
export const MAX_REPORT_ITEMS = 100;
const MAX_REPORT_TEXT = 300;

export interface ReportPage {
  repo: string;
  path: string;
}

/** What run_report_read returns: counts and names from a run's report, never page text, answers or transcripts. */
export interface RunReportDigest {
  job: string;
  run_id: number;
  created_at: string;
  status:
    | {
        ok: boolean | null;
        mode: string | null;
        input_source: string | null;
        delivery: {
          outcome: string;
          review_verdict: string | null;
          pages: ReportPage[];
          dropped: (ReportPage & { by: string })[];
          pulls: {
            repo: string;
            number: number;
            url: string;
            auto_merged: boolean | null;
          }[];
        } | null;
      }
    | { unreadable: string };
  input:
    | {
        pages: ReportPage[];
        deferred: (ReportPage & { reason: string })[] | null;
        waiting: boolean;
      }
    | { unreadable: string };
}

function reportObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function reportList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.slice(0, MAX_REPORT_ITEMS).map(reportObject)
    : [];
}

function reportText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_REPORT_TEXT) : "";
}

function reportTextOrNull(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, MAX_REPORT_TEXT) : null;
}

function reportPage(value: Record<string, unknown>): ReportPage {
  return { repo: reportText(value.repo), path: reportText(value.path) };
}

/** The digest of a run's status.json: whether it passed, and what its pull request delivery did. */
export function statusDigest(status: unknown): RunReportDigest["status"] {
  const s = reportObject(status);
  const d = s.delivery;
  const delivery = reportObject(d);
  return {
    ok: typeof s.ok === "boolean" ? s.ok : null,
    mode: reportTextOrNull(s.mode),
    input_source: reportTextOrNull(s.inputSource),
    delivery:
      typeof d !== "object" || d === null
        ? null
        : {
            outcome: reportText(delivery.outcome),
            review_verdict: reportTextOrNull(
              reportObject(delivery.review).verdict,
            ),
            pages: reportList(delivery.pages).map(reportPage),
            dropped: reportList(delivery.dropped).map((p) => ({
              ...reportPage(p),
              by: reportText(p.by),
            })),
            pulls: reportList(delivery.pulls).map((p) => {
              const merged = reportObject(p.autoMerge).merged;
              return {
                repo: reportText(p.repo),
                number: Number.isSafeInteger(p.number) ? Number(p.number) : 0,
                url: reportText(p.url),
                auto_merged: typeof merged === "boolean" ? merged : null,
              };
            }),
          },
  };
}

/** The digest of a run's input.json: the pages it worked on, the pages it deferred and why, and whether it waited on its own pull request. */
export function inputDigest(input: unknown): RunReportDigest["input"] {
  const i = reportObject(input);
  return {
    pages: reportList(i.pages).map(reportPage),
    deferred: Array.isArray(i.deferred)
      ? reportList(i.deferred).map((p) => ({
          ...reportPage(p),
          reason: reportText(p.reason),
        }))
      : null,
    waiting: typeof i.waiting === "object" && i.waiting !== null,
  };
}

function reportFile<T>(
  zip: Buffer,
  name: string,
  maxBytes: number,
  digest: (parsed: unknown) => T,
): T | { unreadable: string } {
  try {
    const file = readZipEntry(zip, name, maxBytes);
    if (file === undefined) return { unreadable: `the report has no ${name}` };
    return digest(JSON.parse(file.toString("utf8")));
  } catch (err) {
    return {
      unreadable:
        err instanceof SyntaxError ? `${name} is not JSON` : errorChain(err),
    };
  }
}

/**
 * run_report_read: one run's job-<name>-report artifact, read with the
 * run's read-only token, reduced to a digest (statusDigest, inputDigest).
 * The artifact is found by the run id and its exact name; the download
 * goes only to a host in github-log-hosts.yml, over https, without the
 * token, and only status.json and input.json are unpacked.
 */
export class RunReportReader {
  private readonly options: NotesReaderOptions;

  constructor(options: NotesReaderOptions) {
    this.options = options;
  }

  async read(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const extra = Object.keys(args).filter(
      (k) => !["owner", "repo", "job", "run_id"].includes(k),
    );
    if (extra.length > 0)
      throw new Error(`run_report_read takes no ${extra.join(", ")}`);
    const { owner, repo, job } = args;
    const runId = args.run_id;
    if (typeof job !== "string" || !JOB_NAME.test(job))
      throw new Error(`"${String(job)}" is not a job name`);
    if (typeof runId !== "number" || !Number.isSafeInteger(runId) || runId < 1)
      throw new Error("run_id must be a workflow run id");
    const repoPath = `/repos/${encodeURIComponent(String(owner))}/${encodeURIComponent(String(repo))}`;
    const name = `job-${job}-report`;
    const res = await artifactApi(
      this.options,
      `${repoPath}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}&per_page=10`,
      signal,
    );
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`listing the run's artifacts returned ${res.status}`);
    }
    const listed = ((await res.json()) as { artifacts?: unknown }).artifacts;
    const artifact = (Array.isArray(listed) ? (listed as Artifact[]) : []).find(
      (a) => a.name === name && typeof a.id === "number",
    );
    if (artifact === undefined)
      throw new Error(`run ${runId} has no ${name} artifact`);
    if (artifact.expired === true)
      throw new Error(`the ${name} artifact of run ${runId} has expired`);
    if (artifact.size_in_bytes > MAX_REPORT_ZIP_BYTES)
      throw new Error(
        `the artifact is ${artifact.size_in_bytes} bytes, over the ${MAX_REPORT_ZIP_BYTES} byte limit`,
      );
    const zip = await downloadArtifact(
      this.options,
      repoPath,
      artifact.id,
      MAX_REPORT_ZIP_BYTES,
      signal,
    );
    const digest: RunReportDigest = {
      job,
      run_id: runId,
      created_at: reportText(artifact.created_at),
      status: reportFile(
        zip,
        "status.json",
        MAX_REPORT_STATUS_BYTES,
        statusDigest,
      ),
      input: reportFile(zip, "input.json", MAX_REPORT_INPUT_BYTES, inputDigest),
    };
    return JSON.stringify(digest);
  }
}

export async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new Error(
      `the download is ${declared} bytes, over the ${maxBytes} byte limit`,
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (res.body !== null)
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes)
        throw new Error(`the download is over the ${maxBytes} byte limit`);
      chunks.push(Buffer.from(chunk));
    }
  return Buffer.concat(chunks);
}

/**
 * The github upstream: github-mcp-server for its operations, and the tools
 * server itself for maintainer_notes_list, compare_commits,
 * run_report_read and the code reads (commit_grep, path_history,
 * commit_blame, commit_tree), under the same guard.
 */
export class GithubUpstream implements Upstream {
  /** github-mcp-server, for every operation but the native ones. */
  readonly mcp: Upstream;
  private readonly notes: MaintainerNotesReader;
  private readonly comparer: CompareReader | undefined;
  private readonly reports: RunReportReader | undefined;
  private readonly code: CodeReader | undefined;

  constructor(
    mcp: Upstream,
    notes: MaintainerNotesReader,
    comparer?: CompareReader,
    reports?: RunReportReader,
    code?: CodeReader,
  ) {
    this.mcp = mcp;
    this.notes = notes;
    this.comparer = comparer;
    this.reports = reports;
    this.code = code;
  }

  call(
    operation: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    if (!(NATIVE_GITHUB_OPERATIONS as readonly string[]).includes(operation))
      return this.mcp.call(operation, args, signal);
    try {
      githubGuard(operation, args);
    } catch (err) {
      return Promise.reject(err as Error);
    }
    if (operation === "compare_commits") {
      if (this.comparer === undefined)
        return Promise.reject(new Error("compare_commits is not set up"));
      return this.comparer.compare(args, signal);
    }
    if (operation === "run_report_read") {
      if (this.reports === undefined)
        return Promise.reject(new Error("run_report_read is not set up"));
      return this.reports.read(args, signal);
    }
    if (CODE_OPERATIONS.includes(operation)) {
      if (this.code === undefined)
        return Promise.reject(new Error(`${operation} is not set up`));
      if (operation === "commit_grep") return this.code.grep(args, signal);
      if (operation === "path_history")
        return this.code.pathHistory(args, signal);
      if (operation === "commit_blame") return this.code.blame(args, signal);
      return this.code.tree(args, signal);
    }
    return this.notes.list(args, signal);
  }

  async close(): Promise<void> {
    await this.mcp.close?.();
  }
}
