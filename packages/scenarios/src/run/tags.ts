import type {
  CadenceConfig,
  EnvConfig,
  ScenariosConfig,
} from "@flax/contract/config";
import { config, envConfig, envNames } from "../config.ts";
import type { Env } from "../lib/types.ts";

/**
 * Never planned scenarios, never local ones, never the tags the env's policy excludes (unless the scenario
 * carries one of the env's allowTags), fixture and workflow-dispatch scenarios only when asked, and a
 * scenario tagged with environments runs only there. A run for a cadence takes only the scenarios with its
 * tag; any other run leaves out every cadence's.
 */
export function tagExpression(
  env: Env,
  extra?: string,
  fixtures = false,
  dispatch = false,
  cadence?: string,
  c: ScenariosConfig = config(),
): string {
  const envTags = envNames(c)
    .map((e) => `not @env:${e}`)
    .join(" and ");
  const only = cadence === undefined ? undefined : cadenceNamed(cadence, c);
  return [
    "not @planned",
    "not @local",
    `((${envTags}) or @env:${env})`,
    ...policyClause(envConfig(env, c)),
    ...(only ? [only.tag] : c.cadences.map((k) => `not ${k.tag}`)),
    ...(fixtures ? [] : ["not @fixture"]),
    ...(dispatch ? [] : ["not @dispatch"]),
    ...(extra ? [`(${extra})`] : []),
  ].join(" and ");
}

/** The env's excluded tags as clauses; with allowTags, one clause that an allowed tag satisfies instead. */
function policyClause({ excludeTags, allowTags }: EnvConfig): string[] {
  const out = excludeTags.map((t) => `not ${t}`);
  if (out.length === 0 || allowTags.length === 0) return out;
  return [`((${out.join(" and ")}) or ${allowTags.join(" or ")})`];
}

/** Whether the env's allowTags let a scenario with these tags past its excludeTags. */
const allowedOn = (tags: string[], e: EnvConfig): boolean =>
  e.allowTags.some((t) => tags.includes(t));

/** The configured cadence by name, or an error that lists the names flax.yml gives. */
export function cadenceNamed(
  name: string,
  c: ScenariosConfig = config(),
): CadenceConfig {
  const found = c.cadences.find((k) => k.name === name);
  if (found) return found;
  const names = c.cadences.map((k) => k.name);
  throw new Error(
    `unknown cadence ${name}: ${names.length ? `flax.yml names ${names.join(", ")}` : "flax.yml names no cadences (scenarios.cadences)"}`,
  );
}

/** Whether a run on this cadence runs in this env. */
export const cadenceRunsIn = (k: CadenceConfig, env: Env): boolean =>
  k.envs.length === 0 || k.envs.includes(env);

/** What is wrong with `--cadence <name>` for a run in this env, if anything. */
export function cadenceProblem(
  name: string,
  env: Env,
  c: ScenariosConfig = config(),
): string | undefined {
  let k: CadenceConfig;
  try {
    k = cadenceNamed(name, c);
  } catch (e) {
    return `--cadence: ${(e as Error).message}`;
  }
  return cadenceRunsIn(k, env)
    ? undefined
    : `--cadence ${name} runs only on ${k.envs.join(", ")}`;
}

/**
 * Why a scheduled run leaves a scenario with these tags out of an env: pinned to other envs (by its own tags or
 * by the envs its cadence runs in), a tag the env excludes and no tag it allows, a fixture where fixtures never
 * run, or a cadence whose own runs take it there.
 */
export type LeftOut =
  | { kind: "pinned"; envs: Env[] }
  | { kind: "excluded"; tag: string }
  | { kind: "fixture" }
  | { kind: "cadence"; cadence: string };

export function leftOutBy(
  tags: string[],
  env: Env,
  envRunsFixtures: boolean,
  c: ScenariosConfig = config(),
): LeftOut | undefined {
  const pinned = envNames(c).filter((e) => tags.includes(`@env:${e}`));
  if (pinned.length && !pinned.includes(env))
    return { kind: "pinned", envs: pinned };
  const policy = envConfig(env, c);
  const excluded = allowedOn(tags, policy)
    ? undefined
    : policy.excludeTags.find((t) => tags.includes(t));
  if (excluded) return { kind: "excluded", tag: excluded };
  const fixtures = policy.fixtures;
  if (
    tags.includes("@fixture") &&
    (fixtures === "never" || (fixtures === "when-asked" && !envRunsFixtures))
  )
    return { kind: "fixture" };
  const cadences = c.cadences.filter((k) => tags.includes(k.tag));
  if (cadences.length === 0) return undefined;
  const here = cadences.find((k) => cadenceRunsIn(k, env));
  if (here) return { kind: "cadence", cadence: here.name };
  return {
    kind: "pinned",
    envs: envNames(c).filter((e) => cadences.some((k) => cadenceRunsIn(k, e))),
  };
}

/** The envs some scheduled run runs a scenario with these tags in, its cadence's runs included. */
export function envsForTags(
  tags: string[],
  runsFixtures: (env: Env) => boolean,
  c: ScenariosConfig = config(),
): Env[] {
  return envNames(c).filter((e) => {
    const out = leftOutBy(tags, e, runsFixtures(e), c);
    return !out || out.kind === "cadence";
  });
}

/** Scenarios with any of these tags never run at the same time as each other in a parallel run. */
export const SERIAL_TAGS = ["@serial", "@dispatch"] as const;

const serial = (p: { tags: readonly { name: string }[] }): boolean =>
  p.tags.some((t) => (SERIAL_TAGS as readonly string[]).includes(t.name));

/** cucumber's parallelCanAssign: a serial scenario waits while another serial one runs; the rest run whenever a worker is free. */
export function canRunAlongside(
  pickle: { tags: readonly { name: string }[] },
  running: readonly { tags: readonly { name: string }[] }[],
): boolean {
  return !serial(pickle) || !running.some(serial);
}
