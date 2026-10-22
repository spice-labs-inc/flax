import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NOTHING_TO_DO } from "../collect/env.ts";
import { BUNDLE_ROOT } from "../lib/bundled.ts";
import { bundledJobScript, jobFile, REBUILD_DIST } from "../lib/paths.ts";
import { mediaSecretEnv } from "../lib/media.ts";
import { firstLine } from "../lib/problem.ts";
import { withoutToolSecrets } from "../lib/tools.ts";
import { RUNNER_SECRET_ENV } from "./argv.ts";

export const COLLECT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;

export interface Input {
  source: "fixture" | "collect";
  value: unknown;
}

function parseJson(label: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${firstLine(err)}`);
  }
}

/** tsx's command line script, run with this same node so PATH does not matter. */
function tsxCli(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("tsx/package.json");
  const { bin } = JSON.parse(readFileSync(pkg, "utf8")) as { bin: string };
  return join(dirname(pkg), bin);
}

/**
 * How node runs one of a job's scripts: from source through tsx, or, in
 * the bundled runner, the script's own bundle under dist/, so no
 * node_modules and no tsx are needed.
 */
export function jobScriptArgs(
  root: string,
  name: string,
  file: string,
  bundled: boolean = BUNDLE_ROOT !== undefined,
): string[] {
  if (!bundled) return [tsxCli(), join(root, jobFile(name, file))];
  const script = bundledJobScript(name, file);
  if (!existsSync(join(root, script)))
    throw new Error(
      `${script} is missing, so ${jobFile(name, file)} cannot run; ${REBUILD_DIST}`,
    );
  return [join(root, script)];
}

/** The environment without the tool credentials, the gateway issuer key, the writer app's secrets and the media secrets, which only the runner process holds: what lbx and job code (collect.ts, render.ts) get. */
export function withoutRunnerSecrets(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out = withoutToolSecrets(env);
  for (const name of RUNNER_SECRET_ENV) delete out[name];
  for (const name of mediaSecretEnv()) delete out[name];
  return out;
}

export interface JobScriptOptions {
  /** Added to the environment after the credentials are removed. */
  extraEnv?: Record<string, string>;
  /** Written to the script's standard input, which is empty otherwise. */
  stdin?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Runs one of a job's scripts outside the box, as its own process without
 * the model key or any tool credential, and parses what it prints on
 * standard output as JSON.
 */
/** Bytes of a job script's standard error kept for its failure message. */
const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * The line that says why a job script failed: the last `SomethingError: ...`
 * line Node printed, or else the last short line that is not a stack frame.
 * Node prints the source line that threw first; in a bundled script that line
 * is the whole bundle, so it is never the answer.
 */
export function failureLine(stderr: string): string | undefined {
  const all = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const error = all.findLast((l) =>
    /^(?:[A-Z][A-Za-z]*)?(?:Error|Exception)\b[^:]{0,80}: \S/.test(l),
  );
  const lines = all.filter((l) => l.length <= 2000);
  const why =
    error ??
    lines.findLast(
      (l) =>
        l.length <= 300 && !l.startsWith("at ") && !l.startsWith("file://"),
    );
  return why === undefined ? undefined : why.slice(0, 300);
}

export function runJobScript(
  root: string,
  name: string,
  file: string,
  env: NodeJS.ProcessEnv,
  options: JobScriptOptions = {},
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? MAX_INPUT_BYTES;
  let args: string[];
  try {
    args = jobScriptArgs(root, name, file);
  } catch (err) {
    return Promise.reject(err as Error);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...withoutRunnerSecrets(env), ...options.extraEnv },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: options.timeoutMs ?? COLLECT_TIMEOUT_MS,
    });
    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin);
    }
    // Standard error still reaches the workflow log; its tail also names the failure.
    let stderrTail = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(
        -STDERR_TAIL_BYTES,
      );
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const label = jobFile(name, file);
      if (size > maxBytes)
        return reject(
          new Error(`${label} printed more than ${maxBytes} bytes`),
        );
      if (code !== 0) {
        const why = failureLine(stderrTail);
        return reject(
          new Error(
            `${label} failed (${signal === null ? `exit ${code}` : signal})${why === undefined ? "" : `: ${why}`}`,
          ),
        );
      }
      try {
        resolve(
          parseJson(
            `the output of ${label}`,
            Buffer.concat(chunks).toString("utf8"),
          ),
        );
      } catch (err) {
        reject(err);
      }
    });
  });
}

export const MAX_NOTHING_TO_DO_CHARS = 500;

/**
 * Whether an input says the run has nothing to do: its top-level
 * nothing_to_do, one line of at most MAX_NOTHING_TO_DO_CHARS. undefined
 * when the input has no such field.
 */
export function nothingToDoReason(
  input: unknown,
): { reason: string } | { error: string } | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !(NOTHING_TO_DO in input)
  )
    return undefined;
  const reason = (input as Record<string, unknown>)[NOTHING_TO_DO];
  if (
    typeof reason !== "string" ||
    reason.trim() === "" ||
    reason.includes("\n") ||
    reason.length > MAX_NOTHING_TO_DO_CHARS
  )
    return {
      error: `the input's ${NOTHING_TO_DO} must be one line of at most ${MAX_NOTHING_TO_DO_CHARS} characters`,
    };
  return { reason: reason.trim() };
}

/** Runs collect.ts and parses what it prints as the input. */
export function runCollect(
  root: string,
  name: string,
  env: NodeJS.ProcessEnv,
  options: Omit<JobScriptOptions, "stdin"> = {},
): Promise<unknown> {
  return runJobScript(root, name, "collect.ts", env, options);
}

/** Whether the job gathers its input with collect.ts. */
export function hasCollect(root: string, name: string): boolean {
  return existsSync(join(root, jobFile(name, "collect.ts")));
}

/** The fixture in stub runs, which stay offline; otherwise collect.ts when the job has one. */
export async function gatherInput(
  root: string,
  name: string,
  options: {
    stub: boolean;
    env: NodeJS.ProcessEnv;
    extraEnv?: Record<string, string>;
  },
): Promise<Input> {
  if (!options.stub && hasCollect(root, name)) {
    return {
      source: "collect",
      value: await runCollect(
        root,
        name,
        options.env,
        options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv },
      ),
    };
  }
  const file = jobFile(name, "fixtures/input.json");
  return {
    source: "fixture",
    value: parseJson(file, readFileSync(join(root, file), "utf8")),
  };
}
