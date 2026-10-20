import type { PlannedScenario } from "./results.ts";

/**
 * Every scenario tagged @planned, from feature file sources; they are listed, never run. Gherkin is loaded
 * here, not at the top: @cucumber/cucumber (CommonJS) requires it while this module graph is still linking
 * otherwise, and node refuses that cycle.
 */
export async function plannedScenarios(
  files: { uri: string; text: string }[],
): Promise<PlannedScenario[]> {
  const { generateMessages } = await import("@cucumber/gherkin");
  const { IdGenerator, SourceMediaType } = await import("@cucumber/messages");
  const out: PlannedScenario[] = [];
  for (const { uri, text } of files) {
    const envelopes = generateMessages(
      text,
      uri,
      SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN,
      {
        includeSource: false,
        includeGherkinDocument: true,
        includePickles: true,
        newId: IdGenerator.incrementing(),
      },
    );
    const feature =
      envelopes.find((e) => e.gherkinDocument)?.gherkinDocument?.feature
        ?.name ?? uri;
    for (const e of envelopes) {
      const p = e.pickle;
      if (!p || !p.tags.some((t) => t.name === "@planned")) continue;
      out.push({
        id: `${uri}:${p.location?.line ?? 0}`,
        name: p.name,
        feature,
        tags: p.tags.map((t) => t.name),
      });
    }
  }
  return out;
}
