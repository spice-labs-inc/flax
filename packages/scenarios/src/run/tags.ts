import { envConfig } from "../config.ts";
import { ENVS, type Env } from "../lib/types.ts";

/**
 * Never planned scenarios, never local ones, never the tags the env's policy excludes, fixture and
 * workflow-dispatch scenarios only when asked, and a scenario tagged with environments runs only there.
 */
export function tagExpression(
  env: Env,
  extra?: string,
  fixtures = false,
  dispatch = false,
): string {
  const envTags = ENVS.map((e) => `not @env:${e}`).join(" and ");
  return [
    "not @planned",
    "not @local",
    `((${envTags}) or @env:${env})`,
    ...envConfig(env).excludeTags.map((t) => `not ${t}`),
    ...(fixtures ? [] : ["not @fixture"]),
    ...(dispatch ? [] : ["not @dispatch"]),
    ...(extra ? [`(${extra})`] : []),
  ].join(" and ");
}

/** Why a scheduled run leaves a scenario with these tags out of an env: pinned to other envs, a tag the env excludes, or a fixture where fixtures never run. One copy; was seven. */
export type LeftOut =
  | { kind: "pinned"; envs: Env[] }
  | { kind: "excluded"; tag: string }
  | { kind: "fixture" };

export function leftOutBy(
  tags: string[],
  env: Env,
  envRunsFixtures: boolean,
): LeftOut | undefined {
  const pinned = ENVS.filter((e) => tags.includes(`@env:${e}`));
  if (pinned.length && !pinned.includes(env))
    return { kind: "pinned", envs: pinned };
  const excluded = envConfig(env).excludeTags.find((t) => tags.includes(t));
  if (excluded) return { kind: "excluded", tag: excluded };
  const fixtures = envConfig(env).fixtures;
  if (
    tags.includes("@fixture") &&
    (fixtures === "never" || (fixtures === "when-asked" && !envRunsFixtures))
  )
    return { kind: "fixture" };
  return undefined;
}

/** The envs a scheduled run runs a scenario with these tags in. */
export function envsForTags(
  tags: string[],
  runsFixtures: (env: Env) => boolean,
): Env[] {
  return ENVS.filter((e) => !leftOutBy(tags, e, runsFixtures(e)));
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
