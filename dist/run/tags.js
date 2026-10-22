import { config, envConfig, envNames } from "../config.js";
/**
 * Never planned scenarios, never local ones, never the tags the env's policy excludes, fixture and
 * workflow-dispatch scenarios only when asked, and a scenario tagged with environments runs only there.
 * A run for a cadence takes only the scenarios with its tag; any other run leaves out every cadence's.
 */
export function tagExpression(env, extra, fixtures = false, dispatch = false, cadence, c = config()) {
    const envTags = envNames(c)
        .map((e) => `not @env:${e}`)
        .join(" and ");
    const only = cadence === undefined ? undefined : cadenceNamed(cadence, c);
    return [
        "not @planned",
        "not @local",
        `((${envTags}) or @env:${env})`,
        ...envConfig(env, c).excludeTags.map((t) => `not ${t}`),
        ...(only ? [only.tag] : c.cadences.map((k) => `not ${k.tag}`)),
        ...(fixtures ? [] : ["not @fixture"]),
        ...(dispatch ? [] : ["not @dispatch"]),
        ...(extra ? [`(${extra})`] : []),
    ].join(" and ");
}
/** The configured cadence by name, or an error that lists the names flax.yml gives. */
export function cadenceNamed(name, c = config()) {
    const found = c.cadences.find((k) => k.name === name);
    if (found)
        return found;
    const names = c.cadences.map((k) => k.name);
    throw new Error(`unknown cadence ${name}: ${names.length ? `flax.yml names ${names.join(", ")}` : "flax.yml names no cadences (scenarios.cadences)"}`);
}
/** Whether a run on this cadence runs in this env. */
export const cadenceRunsIn = (k, env) => k.envs.length === 0 || k.envs.includes(env);
/** What is wrong with `--cadence <name>` for a run in this env, if anything. */
export function cadenceProblem(name, env, c = config()) {
    let k;
    try {
        k = cadenceNamed(name, c);
    }
    catch (e) {
        return `--cadence: ${e.message}`;
    }
    return cadenceRunsIn(k, env)
        ? undefined
        : `--cadence ${name} runs only on ${k.envs.join(", ")}`;
}
export function leftOutBy(tags, env, envRunsFixtures, c = config()) {
    const pinned = envNames(c).filter((e) => tags.includes(`@env:${e}`));
    if (pinned.length && !pinned.includes(env))
        return { kind: "pinned", envs: pinned };
    const excluded = envConfig(env, c).excludeTags.find((t) => tags.includes(t));
    if (excluded)
        return { kind: "excluded", tag: excluded };
    const fixtures = envConfig(env, c).fixtures;
    if (tags.includes("@fixture") &&
        (fixtures === "never" || (fixtures === "when-asked" && !envRunsFixtures)))
        return { kind: "fixture" };
    const cadences = c.cadences.filter((k) => tags.includes(k.tag));
    if (cadences.length === 0)
        return undefined;
    const here = cadences.find((k) => cadenceRunsIn(k, env));
    if (here)
        return { kind: "cadence", cadence: here.name };
    return {
        kind: "pinned",
        envs: envNames(c).filter((e) => cadences.some((k) => cadenceRunsIn(k, e))),
    };
}
/** The envs some scheduled run runs a scenario with these tags in, its cadence's runs included. */
export function envsForTags(tags, runsFixtures, c = config()) {
    return envNames(c).filter((e) => {
        const out = leftOutBy(tags, e, runsFixtures(e), c);
        return !out || out.kind === "cadence";
    });
}
/** Scenarios with any of these tags never run at the same time as each other in a parallel run. */
export const SERIAL_TAGS = ["@serial", "@dispatch"];
const serial = (p) => p.tags.some((t) => SERIAL_TAGS.includes(t.name));
/** cucumber's parallelCanAssign: a serial scenario waits while another serial one runs; the rest run whenever a worker is free. */
export function canRunAlongside(pickle, running) {
    return !serial(pickle) || !running.some(serial);
}
//# sourceMappingURL=tags.js.map