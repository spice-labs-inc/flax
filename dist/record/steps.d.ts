import { type GherkinDocument, type Pickle } from "@cucumber/messages";
import type { StepKind } from "./pace.ts";
/** One step of a scenario as a recording addresses it. */
export interface StepInfo {
    /** The pickle step id, for matching cucumber's step hooks. */
    id: string;
    /** 1-based among the scenario's own steps; 0 for a Background step, which a sidecar cannot address. */
    index: number;
    background: boolean;
    /** As written: Given, When, Then, And, But, `*`. */
    keyword: string;
    text: string;
    kind: StepKind;
}
/** A scenario of a feature file, as the record planner sees it. */
export interface FeatureScenario {
    uri: string;
    feature: string;
    name: string;
    /** The scenario's line, or its example row's for a scenario outline. */
    line: number;
    steps: StepInfo[];
}
/** The pickle's steps with their keywords as written and whether each came from a Background. */
export declare function scenarioSteps(pickle: Pickle, document: GherkinDocument): StepInfo[];
/**
 * Every scenario of a feature file with its steps. Gherkin is loaded here, not at the top: see
 * plannedScenarios for why.
 */
export declare function featureScenarios(uri: string, text: string): Promise<FeatureScenario[]>;
