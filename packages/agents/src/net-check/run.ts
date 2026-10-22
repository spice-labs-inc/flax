import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { loadBox } from "../lib/box.ts";
import { BOX_FILE, KIT_ROOT } from "../lib/paths.ts";
import { buildLbxArgv, DATA_MOUNT, runName } from "../run-job/argv.ts";
import {
  createRunDirs,
  currentIdentity,
  type Identity,
} from "../run-job/data-dir.ts";
import {
  LbxLauncher,
  lbxSocketProblem,
  type LaunchResult,
  type Launcher,
} from "../run-job/launcher.ts";
import { writeLbxConfig } from "../run-job/lbx-files.ts";
import { withoutRunnerSecrets } from "../run-job/input.ts";
import { redact, secretValues } from "../run-job/report.ts";
import { readUntrusted } from "../run-job/untrusted.ts";
import type { ProbePlan, ProbeResult, Target } from "./probe.ts";
import { fixedTargets, targetsFrom, withAddresses } from "./targets.ts";
import { formatVerdict, judge, type CheckVerdict } from "./verdict.ts";

export const PROBE_ENTRY = "src/net-check/probe-main.ts";
export const PROBE_FILE = "probe.mjs";
export const PLAN_FILE = "plan.json";
export const RESULT_FILE = "result.json";
const TIMEOUT_SECONDS = 180;
const ATTEMPT_MS = 6000;
const MAX_RESULT_BYTES = 1024 * 1024;

export interface NetCheckOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  /** Where the run directory goes, outside the home directory (see scratchBase). */
  scratch: string;
  lbx?: string;
  launcher?: Launcher;
  identity?: Identity;
  lookup?: (host: string) => Promise<string[]>;
  /** The targets besides the clusters; fixedTargets() unless a test keeps them off the network. */
  fixedTargets?: readonly Omit<Target, "addresses">[];
  /** Name servers for the probe's direct DNS query; the box's own unless a test keeps them local. */
  dnsServers?: string[];
  now?: () => Date;
}

export interface NetCheckResult {
  verdict: CheckVerdict;
  text: string;
  launch?: LaunchResult;
}

/** Bundles the probe into one ES module that imports only Node's own modules. */
export async function bundleProbe(outFile: string): Promise<void> {
  await build({
    absWorkingDir: KIT_ROOT,
    entryPoints: [PROBE_ENTRY],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
  });
}

/**
 * Starts the pinned box the way a job run does (the same data directory
 * rules, lbx configuration and command line builder, lbx --no-network after
 * asking lbx whether it has the flag) and runs the probe in it instead of
 * Pi. It gets no socket directory: the sockets lead to the runner's own
 * servers, not to the network. The box gets the target host names and the
 * addresses the runner resolved for them, never a credential: kubeconfigs
 * stay in this process, and lbx never gets them.
 */
export async function runNetCheck(
  options: NetCheckOptions,
): Promise<NetCheckResult> {
  const { root, env } = options;
  const { box, problems } = loadBox(root);
  if (box === undefined || !box.pinned)
    throw new Error(
      `${BOX_FILE} is not pinned: ${problems.map((p) => p.message).join("; ")}`,
    );
  const { targets: named, notes } = targetsFrom(
    env,
    options.fixedTargets ?? fixedTargets(),
  );
  const targets = await withAddresses(named, options.lookup);
  const lbx = options.lbx ?? "lbx";
  const lbxEnv = withoutRunnerSecrets(env);
  if ((options.launcher?.kind ?? "lbx") === "lbx") {
    const problem = await lbxSocketProblem(lbx, lbxEnv);
    if (problem !== undefined)
      throw new Error(
        `the box starts with no network, but ${problem}; pin a sandbox (lbx) release whose lbx has --socket-dir and --no-network in ${BOX_FILE}`,
      );
  }
  const plan: ProbePlan = {
    targets,
    timeoutMs: ATTEMPT_MS,
    ...(options.dnsServers === undefined
      ? {}
      : { dnsServers: options.dnsServers }),
  };

  const dirs = createRunDirs(
    options.scratch,
    "net-check",
    options.identity ?? currentIdentity(),
  );
  await bundleProbe(join(dirs.data, PROBE_FILE));
  writeFileSync(
    join(dirs.data, PLAN_FILE),
    `${JSON.stringify(plan, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  const config = writeLbxConfig(dirs.lbx, box.image);
  const name = runName("net-check", env, (options.now ?? (() => new Date()))());
  const argv = buildLbxArgv({
    lbx,
    network: { noNetwork: true },
    dataDir: dirs.data,
    timeoutSeconds: TIMEOUT_SECONDS,
    runName: name,
    command: [
      "sh",
      "-c",
      `exec node ${DATA_MOUNT}/${PROBE_FILE} ${DATA_MOUNT}/${PLAN_FILE} > ${DATA_MOUNT}/${RESULT_FILE}`,
    ],
  });
  const launcher = options.launcher ?? new LbxLauncher();
  const launch = await launcher.launch({
    argv,
    env: { ...lbxEnv, LLMBOX_CONFIG: config, LLMBOX_STATE_DIR: dirs.state },
    stateDir: dirs.state,
    runName: name,
    answerPath: join(dirs.data, RESULT_FILE),
  });

  const raw = readUntrusted(join(dirs.data, RESULT_FILE), MAX_RESULT_BYTES);
  let result: ProbeResult | undefined;
  if ("text" in raw) {
    try {
      result = JSON.parse(raw.text) as ProbeResult;
    } catch {
      result = undefined;
    }
  }
  const verdict = judge(targets, result);
  const status = launch.status;
  if (status === undefined || status.status !== "exited" || status.code !== 0) {
    verdict.problems.push(
      `lbx reported ${status === undefined ? `exit code ${launch.exitCode} and no status` : `status=${status.status} code=${status.code}`}`,
    );
    verdict.pass = false;
  }
  verdict.problems.push(...notes);
  const scrubbed = redact(formatVerdict(verdict), secretValues(env));
  if (scrubbed.hits > 0) {
    verdict.pass = false;
    verdict.problems.push(
      "a secret value appeared in the output; it was replaced with [redacted]",
    );
  }
  return {
    verdict,
    text:
      scrubbed.hits > 0
        ? redact(formatVerdict(verdict), secretValues(env)).text
        : scrubbed.text,
    launch,
  };
}
