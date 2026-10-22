import type { PlannedScenario } from "./results.ts";
/**
 * Every scenario tagged @planned, from feature file sources; they are listed, never run. Gherkin is loaded
 * here, not at the top: @cucumber/cucumber (CommonJS) requires it while this module graph is still linking
 * otherwise, and node refuses that cycle.
 */
export declare function plannedScenarios(files: {
    uri: string;
    text: string;
}[]): Promise<PlannedScenario[]>;
