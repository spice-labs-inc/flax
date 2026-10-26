import { PickleStepType, } from "@cucumber/messages";
const KINDS = {
    [PickleStepType.CONTEXT]: "context",
    [PickleStepType.ACTION]: "action",
    [PickleStepType.OUTCOME]: "outcome",
};
/** The pickle's steps with their keywords as written and whether each came from a Background. */
export function scenarioSteps(pickle, document) {
    const keywords = new Map();
    const background = new Set();
    const children = document.feature?.children ?? [];
    const visit = (steps, isBackground) => {
        for (const s of steps) {
            keywords.set(s.id, s.keyword.trim());
            if (isBackground)
                background.add(s.id);
        }
    };
    for (const child of children) {
        if (child.background)
            visit(child.background.steps, true);
        if (child.scenario)
            visit(child.scenario.steps, false);
        for (const r of child.rule?.children ?? []) {
            if (r.background)
                visit(r.background.steps, true);
            if (r.scenario)
                visit(r.scenario.steps, false);
        }
    }
    let index = 0;
    return pickle.steps.map((s) => {
        const ast = s.astNodeIds[0] ?? "";
        const isBackground = background.has(ast);
        return {
            id: s.id,
            index: isBackground ? 0 : ++index,
            background: isBackground,
            keyword: keywords.get(ast) ?? "*",
            text: s.text,
            kind: (s.type && KINDS[s.type]) ?? "unknown",
        };
    });
}
/**
 * Every scenario of a feature file with its steps. Gherkin is loaded here, not at the top: see
 * plannedScenarios for why.
 */
export async function featureScenarios(uri, text) {
    const { generateMessages } = await import("@cucumber/gherkin");
    const { IdGenerator, SourceMediaType } = await import("@cucumber/messages");
    const envelopes = generateMessages(text, uri, SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, {
        includeSource: false,
        includeGherkinDocument: true,
        includePickles: true,
        newId: IdGenerator.incrementing(),
    });
    const document = envelopes.find((e) => e.gherkinDocument)?.gherkinDocument;
    if (!document) {
        const error = envelopes.find((e) => e.parseError)?.parseError;
        throw new Error(`${uri}: ${error?.message ?? "not a Gherkin feature file"}`);
    }
    return envelopes.flatMap((e) => e.pickle
        ? [
            {
                uri,
                feature: document.feature?.name ?? uri,
                name: e.pickle.name,
                line: e.pickle.location?.line ?? 0,
                tags: e.pickle.tags.map((t) => t.name),
                steps: scenarioSteps(e.pickle, document),
            },
        ]
        : []);
}
//# sourceMappingURL=steps.js.map