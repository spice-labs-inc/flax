import { touchesMediaType, } from "./results.js";
const WORST_FIRST = [
    "failed",
    "ambiguous",
    "undefined",
    "pending",
    "skipped",
    "passed",
];
function millis(t) {
    return t.seconds * 1000 + Math.round(t.nanos / 1e6);
}
function statusOf(r) {
    const s = r.status.toLowerCase();
    return WORST_FIRST.includes(s)
        ? s
        : "failed";
}
function isTouch(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof value.item === "string");
}
/** One result per scenario run from a cucumber message stream; a retried attempt counts only when it was the last. */
export function scenarioResults(envelopes) {
    const features = new Map();
    const pickles = new Map();
    const testCases = new Map();
    const attempts = new Map();
    for (const e of envelopes) {
        if (e.gherkinDocument?.uri && e.gherkinDocument.feature)
            features.set(e.gherkinDocument.uri, e.gherkinDocument.feature.name);
        if (e.pickle)
            pickles.set(e.pickle.id, e.pickle);
        if (e.testCase)
            testCases.set(e.testCase.id, e.testCase);
        if (e.testCaseStarted)
            attempts.set(e.testCaseStarted.id, {
                testCaseId: e.testCaseStarted.testCaseId,
                startedMs: millis(e.testCaseStarted.timestamp),
                willBeRetried: false,
                steps: [],
                touches: [],
            });
        if (e.testStepFinished) {
            const a = attempts.get(e.testStepFinished.testCaseStartedId);
            a?.steps.push({
                stepId: e.testStepFinished.testStepId,
                result: e.testStepFinished.testStepResult,
            });
        }
        if (e.attachment?.testCaseStartedId &&
            e.attachment.mediaType === touchesMediaType()) {
            const parsed = JSON.parse(e.attachment.body);
            const a = attempts.get(e.attachment.testCaseStartedId);
            if (a && Array.isArray(parsed))
                a.touches.push(...parsed.filter(isTouch));
        }
        if (e.testCaseFinished) {
            const a = attempts.get(e.testCaseFinished.testCaseStartedId);
            if (a) {
                a.finishedMs = millis(e.testCaseFinished.timestamp);
                a.willBeRetried = e.testCaseFinished.willBeRetried;
            }
        }
    }
    const results = [];
    for (const a of attempts.values()) {
        if (a.willBeRetried || a.finishedMs === undefined)
            continue;
        const testCase = testCases.get(a.testCaseId);
        const pickle = testCase ? pickles.get(testCase.pickleId) : undefined;
        if (!testCase || !pickle)
            continue;
        const stepText = new Map(pickle.steps.map((s) => [s.id, s.text]));
        const textOf = (testStepId) => {
            const step = testCase.testSteps.find((s) => s.id === testStepId);
            return step?.pickleStepId
                ? (stepText.get(step.pickleStepId) ?? "")
                : "(hook)";
        };
        const atOf = (testStepId) => {
            const i = testCase.testSteps.findIndex((s) => s.id === testStepId);
            const pickleStepId = testCase.testSteps[i]?.pickleStepId;
            if (pickleStepId)
                return pickle.steps.findIndex((s) => s.id === pickleStepId);
            return testCase.testSteps.slice(0, i).some((s) => s.pickleStepId)
                ? -2
                : -1;
        };
        let status = "passed";
        let failure;
        for (const { stepId, result } of a.steps) {
            const s = statusOf(result);
            if (WORST_FIRST.indexOf(s) < WORST_FIRST.indexOf(status))
                status = s;
            if (s === "failed" && failure === undefined)
                failure = {
                    step: textOf(stepId),
                    at: atOf(stepId),
                    message: (result.message ?? "").split("\n").slice(0, 20).join("\n"),
                };
        }
        results.push({
            id: `${pickle.uri}:${pickle.location?.line ?? 0}`,
            name: pickle.name,
            feature: features.get(pickle.uri) ?? pickle.uri,
            tags: pickle.tags.map((t) => t.name),
            status,
            durationMs: a.finishedMs - a.startedMs,
            touches: dedupe(a.touches),
            ...(failure ? { failure } : {}),
        });
    }
    return results.sort((x, y) => x.id.localeCompare(y.id, "en", { numeric: true }));
}
function dedupe(touches) {
    const seen = new Map();
    for (const t of touches)
        seen.set(`${t.item}\u0000${t.need ?? ""}\u0000${t.step ?? ""}`, t);
    return [...seen.values()];
}
//# sourceMappingURL=messages.js.map