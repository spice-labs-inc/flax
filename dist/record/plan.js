import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { stringify } from "yaml";
import { defaultSidecar, parseSidecars, resolveSidecar, sidecarFiles, slug, } from "./sidecar.js";
import { featureScenarios } from "./steps.js";
/** A path as cucumber reports a pickle's uri: relative to the working directory. */
export const featureKey = (uri) => relative(process.cwd(), resolve(uri));
/**
 * The scenarios of the given feature files to record: each one a sidecar names, or every one
 * with `all`, those without a sidecar getting a generated one. Every problem with any sidecar is
 * returned (an unknown scenario name, a bad step reference, overlapping narration, a duplicate id),
 * and nothing is planned while there is one.
 */
export async function planRecordings(files, options) {
    const errors = [];
    const recordings = [];
    const generated = new WeakSet();
    const defaults = {
        pace: options.record.pace,
        viewport: options.record.viewport,
        scale: options.record.scale,
    };
    for (const { uri, text } of files) {
        const scenarios = await featureScenarios(uri, text).catch((e) => {
            errors.push(e.message);
            return [];
        });
        const documents = [];
        for (const { file, id } of sidecarFiles(uri)) {
            const parsed = parseSidecars(readFileSync(file, "utf8"), file);
            errors.push(...parsed.errors);
            for (const doc of parsed.documents) {
                if (id !== undefined && doc.sidecar.id !== id)
                    errors.push(`${doc.file}: the file is named for id ${id} but the sidecar's id is ${doc.sidecar.id}`);
                else
                    documents.push(doc);
            }
        }
        const covered = new Set();
        for (const doc of documents) {
            const name = doc.sidecar.scenario;
            const matches = scenarios.filter((s) => s.name === name);
            if (matches.length === 0) {
                errors.push(`${doc.file}: scenario "${name}" is not in ${uri}; its scenarios: ${[...new Set(scenarios.map((s) => `"${s.name}"`))].join(", ") || "none"}`);
                continue;
            }
            if (matches.length > 1) {
                errors.push(`${doc.file}: scenario "${name}" names ${matches.length} examples of an outline; put an example value in the outline's name (Scenario Outline: ... <column>) and name one of them`);
                continue;
            }
            const match = matches[0];
            if (covered.has(match.line)) {
                errors.push(`${doc.file}: scenario "${name}" already has a sidecar; one per scenario`);
                continue;
            }
            covered.add(match.line);
            const resolved = resolveSidecar(doc.sidecar, match.steps, defaults, doc.file);
            errors.push(...resolved.errors);
            if (resolved.sidecar)
                recordings.push({
                    uri: featureKey(uri),
                    line: match.line,
                    feature: match.feature,
                    sidecar: resolved.sidecar,
                    source: doc.source,
                });
        }
        if (!options.all)
            continue;
        for (const s of scenarios) {
            if (covered.has(s.line))
                continue;
            const sidecar = defaultSidecar(s.name, slug(s.name));
            const resolved = resolveSidecar(sidecar, s.steps, defaults, uri);
            if (!resolved.sidecar)
                continue;
            const r = {
                uri: featureKey(uri),
                line: s.line,
                feature: s.feature,
                sidecar: resolved.sidecar,
                source: stringify(sidecar),
            };
            generated.add(r);
            recordings.push(r);
        }
    }
    const ids = new Map();
    const sidecarsFirst = [...recordings].sort((a, b) => Number(generated.has(a)) - Number(generated.has(b)));
    for (const r of sidecarsFirst) {
        const first = ids.get(r.sidecar.id);
        if (!first) {
            ids.set(r.sidecar.id, r);
            continue;
        }
        // A generated id that collides takes a number; a sidecar's own id never changes.
        if (generated.has(r)) {
            let n = 2;
            while (ids.has(`${r.sidecar.id}-${n}`))
                n++;
            r.sidecar = { ...r.sidecar, id: `${r.sidecar.id}-${n}` };
            r.source = stringify(defaultSidecar(r.sidecar.scenario, r.sidecar.id));
            ids.set(r.sidecar.id, r);
            continue;
        }
        errors.push(`id ${r.sidecar.id} is used twice: by "${first.sidecar.scenario}" (${first.uri}) and "${r.sidecar.scenario}" (${r.uri}); each recording needs its own`);
    }
    return {
        plan: {
            dir: resolve(options.dir),
            options: options.record,
            recordings: errors.length > 0 ? [] : recordings,
        },
        errors,
    };
}
/** The planned recording of a pickle, by its feature file and line. */
export function plannedRecording(plan, uri, line) {
    const key = featureKey(uri);
    return plan.recordings.find((r) => r.uri === key && r.line === line);
}
//# sourceMappingURL=plan.js.map