import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { readUntrusted } from "./untrusted.ts";

export type LbxOutcome =
  "setup-failed" | "timeout" | "signal" | "exited" | "refused";

export interface LbxStatus {
  status: LbxOutcome;
  code: number;
  /** lbx could not remove everything carrying this run's label. */
  cleanupIncomplete?: true;
}

export interface LaunchRequest {
  argv: readonly string[];
  /** The environment lbx runs with; the secrets named with --env are read from it. */
  env: NodeJS.ProcessEnv;
  /** LLMBOX_STATE_DIR for this run. */
  stateDir: string;
  runName: string;
  /** Where the command writes its answer, on the host side. */
  answerPath: string;
}

export interface LaunchResult {
  exitCode: number;
  /** From lbx's status file when there is one, else its last status line. */
  status?: LbxStatus;
  statusSource: "file" | "stderr" | "stub" | "none";
}

export interface Launcher {
  readonly kind: "lbx" | "stub";
  launch(request: LaunchRequest): Promise<LaunchResult>;
}

const STATUS =
  /^status=(setup-failed|timeout|signal|exited|refused) code=(\d{1,3})( cleanup=incomplete)?$/;
const STDERR_PREFIX = "lbx-run: ";

export function parseStatus(line: string): LbxStatus | undefined {
  const m = STATUS.exec(line.trim());
  if (m === null) return undefined;
  const status: LbxStatus = { status: m[1] as LbxOutcome, code: Number(m[2]) };
  if (m[3] !== undefined) status.cleanupIncomplete = true;
  return status;
}

/** The path lbx writes the authoritative outcome to. */
export function statusFile(stateDir: string, runName: string): string {
  return join(stateDir, "runs", runName, "status");
}

/** Reads the outcome the way lbx documents: the status file first, the standard error line only as a fallback. */
export function readStatus(
  stateDir: string,
  runName: string,
  lastStderrStatus: string | undefined,
): Pick<LaunchResult, "status" | "statusSource"> {
  const file = readUntrusted(statusFile(stateDir, runName), 4096);
  if ("text" in file) {
    const status = parseStatus(file.text);
    if (status !== undefined) return { status, statusSource: "file" };
  }
  if (lastStderrStatus !== undefined) {
    const status = parseStatus(lastStderrStatus);
    if (status !== undefined) return { status, statusSource: "stderr" };
  }
  return { statusSource: "none" };
}

/** Runs lbx for real: streams its output through and waits for it to finish. */
export class LbxLauncher implements Launcher {
  readonly kind = "lbx";

  private readonly out: NodeJS.WritableStream;
  private readonly err: NodeJS.WritableStream;

  constructor(
    out: NodeJS.WritableStream = process.stdout,
    err: NodeJS.WritableStream = process.stderr,
  ) {
    this.out = out;
    this.err = err;
  }

  launch(request: LaunchRequest): Promise<LaunchResult> {
    const [command, ...args] = request.argv;
    if (command === undefined) throw new Error("empty argv");
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let lastStatusLine: string | undefined;
      let pending = "";
      child.stdout.pipe(this.out, { end: false });
      child.stderr.on("data", (chunk: Buffer) => {
        this.err.write(chunk);
        const lines = (pending + chunk.toString("utf8")).split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith(STDERR_PREFIX))
            lastStatusLine = line.slice(STDERR_PREFIX.length);
        }
      });
      // A cancelled workflow signals the runner; lbx must hear it too, so it cleans up its containers.
      const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
      const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
        (signal) => [signal, forward(signal)] as const,
      );
      for (const [signal, handler] of handlers) process.on(signal, handler);
      const done = () => {
        for (const [signal, handler] of handlers) process.off(signal, handler);
      };
      child.on("error", (err) => {
        done();
        reject(err);
      });
      child.on("close", (code, signal) => {
        done();
        if (pending.startsWith(STDERR_PREFIX))
          lastStatusLine = pending.slice(STDERR_PREFIX.length);
        const exitCode =
          code ?? 128 + (signal === null ? 0 : constants.signals[signal]);
        resolve({
          exitCode,
          ...readStatus(request.stateDir, request.runName, lastStatusLine),
        });
      });
    });
  }
}

/** The two run options the socket transport needs from lbx, and the value the probe gives the first. */
const SOCKET_FLAGS = [["--socket-dir", "/"], ["--no-network"]] as const;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Why this lbx cannot run a box with the runner's sockets, or undefined
 * when it can. It asks lbx itself: given --socket-dir or --no-network
 * without --run, an lbx that has them refuses with "ERROR: --<flag> is
 * only valid with --run." while parsing its arguments, before it reads or
 * writes anything; an older lbx calls the flag an unknown option.
 */
export async function lbxSocketProblem(
  lbx: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  for (const args of SOCKET_FLAGS) {
    const want = `ERROR: ${args[0]} is only valid with --run.`;
    const result = await new Promise<
      { code: number | null; stderr: string } | { error: string }
    >((resolve) => {
      const child = spawn(lbx, args, {
        env,
        stdio: ["ignore", "ignore", "pipe"],
        timeout: PROBE_TIMEOUT_MS,
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => resolve({ error: err.message }));
      child.on("close", (code) => resolve({ code, stderr }));
    });
    if ("error" in result)
      return `${lbx} could not be started: ${result.error}`;
    if (result.code !== 1 || !result.stderr.split("\n").includes(want))
      return `${lbx} does not offer ${args[0]}`;
  }
  return undefined;
}

/** Runs nothing: writes a fixed answer where the command would, for tests and --stub. */
export class StubLauncher implements Launcher {
  readonly kind = "stub";
  readonly requests: LaunchRequest[] = [];

  private readonly answer: string;

  constructor(answer: string) {
    this.answer = answer;
  }

  launch(request: LaunchRequest): Promise<LaunchResult> {
    this.requests.push(request);
    writeFileSync(request.answerPath, this.answer, { mode: 0o600 });
    return Promise.resolve({
      exitCode: 0,
      status: { status: "exited", code: 0 },
      statusSource: "stub",
    });
  }
}
