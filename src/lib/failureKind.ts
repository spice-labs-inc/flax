import { ENV_LABEL, formatPacific, type Env } from "./data.ts";
import type { RunInfo, ScenarioRecord } from "./scenarios.ts";

/**
 * Why a scenario fails, read from its records in one env: the runner could not reach the env, it fails now and
 * then, it broke when the api build changed, it is new and has never been verified, it failed once with nothing
 * changed, or it keeps failing.
 */
export type FailureKind =
  "unreachable" | "intermittent" | "build" | "new" | "once" | "steady";

export const KIND_LABEL: Record<FailureKind, string> = {
  unreachable: "Could not reach the environment",
  intermittent: "Intermittent",
  build: "Broke with a build change",
  new: "New scenario, never verified",
  once: "Failed once, with no build change",
  steady: "Steady failure",
};

export interface KindReading {
  kind: FailureKind;
  /** The evidence, as one or two full sentences. */
  text: string;
}

// The data build keeps this many records per scenario and env (RECORDS_PER_ENV in scripts/scenarios.ts).
export const KEPT_RECORDS = 80;

import { isUnreachable } from "./unreachable.ts";
export { isUnreachable };

/** What went wrong on the network, as a clause: "the address api.test.example did not resolve". */
export function reachClause(message: string): string {
  const host =
    /ENOTFOUND (\S+)/.exec(message)?.[1] ??
    /ERR_NAME_NOT_RESOLVED at https?:\/\/([^/\s]+)/.exec(message)?.[1];
  if (host) return `the address ${host} did not resolve`;
  if (/EAI_AGAIN|getaddrinfo|ERR_NAME_NOT_RESOLVED/.test(message))
    return "an address did not resolve";
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(message))
    return "the connection was refused";
  if (/ECONNRESET|ERR_CONNECTION_RESET|socket hang up/.test(message))
    return "the connection was dropped";
  if (/ETIMEDOUT|ERR_CONNECTION_TIMED_OUT/.test(message))
    return "the connection timed out";
  return "the request never got an answer";
}

/** Where in a scenario a failure sits: "at step 5", or "while setting up". */
export function stepPlace(at: number | undefined): string {
  if (at === undefined || at === -3) return "at a step the run could not place";
  if (at === -1) return "while setting up, before the first step";
  if (at === -2) return "while cleaning up, after the last step";
  return `at step ${at + 1}`;
}

/** The api build a run ran against, short. */
export function apiBuild(run: RunInfo | undefined): string | undefined {
  return run?.versions.find((v) => v.service === "api")?.release?.slice(0, 7);
}

/**
 * Reads the failure kind from a scenario's records in one env, oldest first, the newest a failure. `whole` says the
 * records reach back to the scenario's first run there, so one that never passed is new rather than long broken.
 */
export function failureKind(
  recs: ScenarioRecord[],
  runs: RunInfo[],
  env: Env,
  whole: boolean,
): KindReading {
  const label = ENV_LABEL[env];
  const last = recs[recs.length - 1]!;
  const message = last.failure?.message ?? "";
  if (isUnreachable(message))
    return {
      kind: "unreachable",
      text: `It could not reach ${label} ${stepPlace(last.failure?.at)}: ${reachClause(message)}.`,
    };

  // Runs that could not reach the env say nothing about the scenario, so they are left out of its history.
  const judged = recs.filter(
    (r) =>
      r.status === "p" ||
      (r.status === "f" && !isUnreachable(r.failure?.message ?? "")),
  );
  const fails = judged.filter((r) => r.status === "f");
  const passes = judged.length - fails.length;
  let streak = 0;
  while (
    streak < judged.length &&
    judged[judged.length - 1 - streak]!.status === "f"
  )
    streak++;
  const first = judged[judged.length - streak]!;
  const runAt = (r: ScenarioRecord) => runs[r.run]!.finishedAt;
  const place = stepPlace(last.failure?.at);

  if (passes === 0) {
    if (whole)
      return {
        kind: "new",
        text: `It has never been verified on ${label}: it failed in ${streak === 1 ? "its only run" : streak === 2 ? "both of its runs" : `all ${streak} of its runs`} there since ${formatPacific(runAt(judged[0]!))}, ${place}.`,
      };
    return {
      kind: "steady",
      text: `It has not been verified on ${label} in the ${judged.length} runs on record, since ${formatPacific(runAt(judged[0]!))}; it fails ${place}.`,
    };
  }

  let stretches = 0;
  for (let i = 0; i < judged.length; i++)
    if (judged[i]!.status === "f" && judged[i - 1]?.status !== "f") stretches++;
  const lastPass = judged[judged.length - streak - 1]!;
  const before = apiBuild(runs[lastPass.run]);
  const broke = apiBuild(runs[first.run]);
  const buildChanged = !!before && !!broke && before !== broke;
  const buildText = `It was last verified on api build ${before} at ${formatPacific(runAt(lastPass))} and broke on build ${broke} at ${formatPacific(runAt(first))}, ${place}.`;

  if (buildChanged && streak >= 2) return { kind: "build", text: buildText };

  if (stretches >= 2 && streak <= 3) {
    const steps = new Set(fails.map((r) => r.failure?.at));
    steps.delete(last.failure?.at);
    const others = [...steps].map(stepPlace);
    const where = others.length
      ? `${place} this time and ${others.join(" or ")} before`
      : `always ${place}`;
    const every = Math.round(judged.length / fails.length);
    const rate =
      fails.length * 2 <= judged.length
        ? `about 1 run in ${every}`
        : "in more runs than not";
    return {
      kind: "intermittent",
      text: `It failed ${fails.length} of its last ${judged.length} runs on ${label}, ${rate}, ${where}.`,
    };
  }

  if (buildChanged) return { kind: "build", text: buildText };

  const tail =
    before && before === broke
      ? `${place}, on api build ${before}, the same build it was last verified on, at ${formatPacific(runAt(lastPass))}.`
      : `${place}; it was last verified at ${formatPacific(runAt(lastPass))}.`;
  if (streak === 1)
    return {
      kind: "once",
      text: `It failed for the first time in its last ${judged.length} runs on ${label}, ${tail}`,
    };
  return {
    kind: "steady",
    text: `It has failed in each of its last ${streak} runs on ${label} since ${formatPacific(runAt(first))}, ${tail}`,
  };
}
