import { CAPTURE_MEDIA_TYPE } from "./capture.js";
/** The capture entries of a run's messages, in the order they were taken. */
export function captureEntries(envelopes) {
    return envelopes.flatMap((e) => e.attachment?.mediaType === CAPTURE_MEDIA_TYPE
        ? [JSON.parse(e.attachment.body)]
        : []);
}
/** The manifest of a capture run from its entries, the scenarios' results and what was selected. */
export function captureManifest(entries, results, selected, run) {
    const problems = [];
    const statusOf = new Map(results.map((r) => [r.id, r.status]));
    const byName = new Map();
    for (const e of [...entries].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
        const status = statusOf.get(`${e.feature}:${e.line}`) ?? "failed";
        const earlier = byName.get(e.name);
        if (earlier)
            problems.push(`${e.name} was taken by "${earlier.scenario}" and again by "${e.scenario}"; the file is the later one; give each its own name, or name the one each scenario takes in a <tag>:<name> tag`);
        byName.set(e.name, { ...e, status });
    }
    for (const s of selected) {
        const status = statusOf.get(`${s.uri}:${s.line}`);
        if (status === undefined) {
            problems.push(`"${s.name}" (${s.uri}:${s.line}) did not run: the tag policy or --tags left it out`);
            continue;
        }
        if (status !== "passed")
            problems.push(`"${s.name}" ${status}; its captures are marked so and are not to be used`);
        const took = new Set(entries
            .filter((e) => e.feature === s.uri && e.line === s.line)
            .map((e) => e.name));
        for (const name of s.names)
            if (!took.has(name))
                problems.push(status === "passed"
                    ? `"${s.name}" passed without taking ${name}: no step of it captures that name`
                    : `"${s.name}" stopped before taking ${name}`);
        if (s.all && took.size === 0 && status === "passed")
            problems.push(`"${s.name}" passed without taking any capture`);
    }
    return {
        ...run,
        status: problems.length === 0 ? "passed" : "failed",
        captures: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
        problems,
    };
}
//# sourceMappingURL=manifest.js.map