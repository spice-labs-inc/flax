import { execFileSync } from "node:child_process";
import type { Envelope } from "@cucumber/messages";
import type { Env } from "../lib/types.ts";
import type { PlannedScenario, RunResult } from "./results.ts";

export const INGEST_TOKEN_VARIABLE = "EXPLORER_INGEST_TOKEN";
export const EXPLORER_URL_VARIABLE = "EXPLORER_URL";

export interface LiveLimits {
  tickMs: number;
  requestMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  giveUpMs: number;
  finalMs: number;
  maxEnvelopes: number;
  maxBytes: number;
  batchBytes: number;
  attachmentBytes: number;
}

export const LIVE_LIMITS: LiveLimits = {
  tickMs: 1_000,
  requestMs: 3_000,
  backoffMinMs: 5_000,
  backoffMaxMs: 60_000,
  giveUpMs: 5 * 60_000,
  finalMs: 10_000,
  maxEnvelopes: 20_000,
  maxBytes: 16 * 1024 * 1024,
  batchBytes: 1024 * 1024,
  attachmentBytes: 256 * 1024,
};

/** What the explorer learns when a run starts. */
export interface RunStart {
  env: Env;
  runId: string;
  startedAt: string;
  workers: number;
  scenariosCommit?: string;
  github?: { runId: string; attempt?: string; repository: string };
  planned: PlannedScenario[];
}

export interface LiveOptions {
  url: URL;
  token: string;
  runId: string;
  fetch?: typeof fetch;
  warn?: (line: string) => void;
  limits?: Partial<LiveLimits>;
}

class Refused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`the explorer answered ${status}`);
    this.status = status;
  }
}

interface Request {
  path: string;
  body: string;
  contentType: string;
  done: () => void;
}

/**
 * Pushes a run's cucumber messages to the explorer as they arrive, so open pages follow the run.
 * Fire and forget: nothing here waits on the run, throws into it, or changes its results or exit code.
 */
export class LivePush {
  readonly #base: URL;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #warn: (line: string) => void;
  readonly #limits: LiveLimits;
  #queue: { seq: number; line: string; bytes: number }[] = [];
  #queuedBytes = 0;
  #seq = 0;
  #dropped = 0;
  #gapPending = false;
  #start: string | undefined;
  #inFlight: Promise<void> | undefined;
  #failingSince: number | undefined;
  #failures = 0;
  #nextAt = 0;
  #stopped = false;
  #warned = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: LiveOptions) {
    const runPath = `ingest/runs/${encodeURIComponent(options.runId)}/`;
    const base = options.url.href.endsWith("/")
      ? options.url.href
      : `${options.url.href}/`;
    this.#base = new URL(runPath, base);
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#warn = options.warn ?? ((line) => console.error(line));
    this.#limits = { ...LIVE_LIMITS, ...options.limits };
    this.#timer = setInterval(() => this.#tick(), this.#limits.tickMs);
    this.#timer.unref();
  }

  /** How many envelopes were left out because the queue was full. */
  get dropped(): number {
    return this.#dropped;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  start(info: RunStart): void {
    try {
      this.#start = JSON.stringify(info);
    } catch {
      this.#start = undefined;
    }
  }

  /** Called for every envelope; only queues it. */
  message(envelope: Envelope): void {
    if (this.#stopped) return;
    try {
      if (
        envelope.attachment &&
        envelope.attachment.body.length > this.#limits.attachmentBytes
      )
        return;
      const line = JSON.stringify(envelope);
      const bytes = Buffer.byteLength(line);
      if (
        this.#queue.length >= this.#limits.maxEnvelopes ||
        this.#queuedBytes + bytes > this.#limits.maxBytes
      ) {
        this.#dropped++;
        this.#gapPending = true;
        return;
      }
      this.#queue.push({ seq: this.#seq++, line, bytes });
      this.#queuedBytes += bytes;
    } catch {
      this.#dropped++;
      this.#gapPending = true;
    }
  }

  /** The last messages and the run's results, in at most finalMs in all; never throws. */
  async finish(run: RunResult, planned: PlannedScenario[]): Promise<void> {
    clearInterval(this.#timer);
    const deadline = Date.now() + this.#limits.finalMs;
    const left = () => deadline - Date.now();
    try {
      if (this.#inFlight) await this.#inFlight;
      // The finish call carries run.json, so it keeps one request's time for itself.
      while (!this.#stopped && left() > this.#limits.requestMs) {
        const req = this.#next();
        if (!req) break;
        try {
          await this.#send(req, this.#limits.requestMs);
          req.done();
        } catch (e) {
          this.#failed(e);
          return;
        }
      }
      if (this.#stopped || this.#start !== undefined || left() <= 0) return;
      const body = JSON.stringify({
        run,
        planned,
        dropped: this.#dropped,
        unsent: this.#queue.length,
      });
      await this.#send(
        {
          path: "finish",
          body,
          contentType: "application/json",
          done: () => undefined,
        },
        Math.min(this.#limits.requestMs, left()),
      );
    } catch (e) {
      this.#failed(e);
    } finally {
      this.#stop();
    }
  }

  #tick(): void {
    if (this.#stopped || this.#inFlight || Date.now() < this.#nextAt) return;
    const req = this.#next();
    if (!req) return;
    this.#inFlight = this.#send(req, this.#limits.requestMs)
      .then(
        () => {
          req.done();
          this.#failingSince = undefined;
          this.#failures = 0;
        },
        (e: unknown) => this.#failed(e),
      )
      .finally(() => {
        this.#inFlight = undefined;
      });
  }

  #next(): Request | undefined {
    if (this.#start !== undefined)
      return {
        path: "start",
        body: this.#start,
        contentType: "application/json",
        done: () => {
          this.#start = undefined;
        },
      };
    if (this.#queue.length === 0) return undefined;
    let n = 0;
    let bytes = 0;
    while (n < this.#queue.length) {
      const b = this.#queue[n]!.bytes + 1;
      if (n > 0 && bytes + b > this.#limits.batchBytes) break;
      bytes += b;
      n++;
    }
    const batch = this.#queue.slice(0, n);
    const gap = this.#gapPending;
    return {
      path: `messages?first=${batch[0]!.seq}${gap ? "&gap=1" : ""}`,
      body: batch.map((q) => q.line).join("\n") + "\n",
      contentType: "application/x-ndjson",
      done: () => {
        // The queue only grows at its end while a batch is out, so the batch is still its head.
        this.#queue.splice(0, n);
        this.#queuedBytes -= bytes - n;
        if (gap) this.#gapPending = false;
      },
    };
  }

  async #send(req: Request, timeoutMs: number): Promise<void> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    timer.unref();
    try {
      const res = await this.#fetch(new URL(req.path, this.#base), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": req.contentType,
        },
        body: req.body,
        signal: abort.signal,
      });
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) throw new Refused(res.status);
    } finally {
      clearTimeout(timer);
    }
  }

  #failed(e: unknown): void {
    if (this.#stopped) return;
    const why =
      e instanceof Refused
        ? e.message
        : e instanceof Error && e.name === "AbortError"
          ? `no answer within ${this.#limits.requestMs / 1000} s`
          : e instanceof Error
            ? (e.cause instanceof Error ? e.cause.message : e.message) || e.name
            : "unknown error";
    const now = Date.now();
    this.#failingSince ??= now;
    this.#failures++;
    if (
      e instanceof Refused &&
      e.status >= 400 &&
      e.status < 500 &&
      e.status !== 408 &&
      e.status !== 429
    ) {
      this.#warn(
        `live updates: ${e.message}, so not pushing for the rest of this run; the run itself is unaffected`,
      );
      this.#stop();
      return;
    }
    if (now - this.#failingSince >= this.#limits.giveUpMs) {
      this.#warn(
        `live updates: gave up after ${Math.round((now - this.#failingSince) / 60_000)} minutes of failures (${why}); the run itself is unaffected`,
      );
      this.#stop();
      return;
    }
    if (!this.#warned) {
      this.#warned = true;
      this.#warn(
        `live updates: pushing to the explorer failed (${why}); retrying in the background, the run itself is unaffected`,
      );
    }
    this.#nextAt =
      now +
      Math.min(
        this.#limits.backoffMaxMs,
        this.#limits.backoffMinMs * 2 ** (this.#failures - 1),
      );
  }

  #stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#queue = [];
    this.#queuedBytes = 0;
  }
}

/** A push for this run when the explorer's URL and ingest token are both set; otherwise none. */
export function livePushFromEnv(
  env: NodeJS.ProcessEnv,
  runId: string,
  warn: (line: string) => void = (line) => console.error(line),
): LivePush | undefined {
  const token = env[INGEST_TOKEN_VARIABLE]?.trim();
  const raw = env[EXPLORER_URL_VARIABLE]?.trim();
  if (!token || !raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    warn(`live updates off: ${EXPLORER_URL_VARIABLE} is not a URL`);
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    warn(`live updates off: ${EXPLORER_URL_VARIABLE} is not an http(s) URL`);
    return undefined;
  }
  return new LivePush({ url, token, runId, warn });
}

/** The workspace commit this checkout is at, when git can say. */
export function scenariosCommit(): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The workflow run this run is part of, from the variables GitHub Actions sets. */
export function githubRun(
  env: NodeJS.ProcessEnv,
): RunStart["github"] | undefined {
  const runId = env["GITHUB_RUN_ID"];
  const repository = env["GITHUB_REPOSITORY"];
  if (!runId || !/^\d+$/.test(runId) || !repository) return undefined;
  const attempt = env["GITHUB_RUN_ATTEMPT"];
  return {
    runId,
    repository,
    ...(attempt && /^\d+$/.test(attempt) ? { attempt } : {}),
  };
}
