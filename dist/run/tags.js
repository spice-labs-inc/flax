import { envConfig } from "../config.js";
import { ENVS } from "../lib/types.js";
/**
 * Never planned scenarios, never local ones, never the tags the env's policy excludes, fixture and
 * workflow-dispatch scenarios only when asked, and a scenario tagged with environments runs only there.
 */
export function tagExpression(env, extra, fixtures = false, dispatch = false) {
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
export function leftOutBy(tags, env, envRunsFixtures) {
    const pinned = ENVS.filter((e) => tags.includes(`@env:${e}`));
    if (pinned.length && !pinned.includes(env))
        return { kind: "pinned", envs: pinned };
    const excluded = envConfig(env).excludeTags.find((t) => tags.includes(t));
    if (excluded)
        return { kind: "excluded", tag: excluded };
    const fixtures = envConfig(env).fixtures;
    if (tags.includes("@fixture") &&
        (fixtures === "never" || (fixtures === "when-asked" && !envRunsFixtures)))
        return { kind: "fixture" };
    return undefined;
}
/** The envs a scheduled run runs a scenario with these tags in. */
export function envsForTags(tags, runsFixtures) {
    return ENVS.filter((e) => !leftOutBy(tags, e, runsFixtures(e)));
}
/** Scenarios with any of these tags never run at the same time as each other in a parallel run. */
export const SERIAL_TAGS = ["@serial", "@dispatch"];
const serial = (p) => p.tags.some((t) => SERIAL_TAGS.includes(t.name));
/** cucumber's parallelCanAssign: a serial scenario waits while another serial one runs; the rest run whenever a worker is free. */
export function canRunAlongside(pickle, running) {
    return !serial(pickle) || !running.some(serial);
}
//# sourceMappingURL=tags.js.map