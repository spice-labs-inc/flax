export type PersonaType = string;
export type Edition = string;
export type Stage = string;
export type StationKind = string;
export interface Tension {
    /** Persona id. */
    with: string;
    conflict: string;
    /** The design rule that resolves the conflict. */
    rule: string;
}
export interface Evidence {
    claim: string;
    source: string;
    date: string;
    /** True until a real customer conversation confirms the claim. */
    assumption: boolean;
}
export interface SourceRef {
    title: string;
    date: string;
    where: string;
}
import type { Persona } from "@flax/contract";
export type { Persona };
export interface Station {
    key: string;
    name: string;
    stage: Stage;
    kind: StationKind;
    /** Exact item ids, prefixes ending in `*`, or `api:* <path>` for any method (path exact, or a prefix ending in `*`). */
    match: string[];
}
export interface Journey {
    persona: string;
    /** Station keys, in order. */
    stations: string[];
}
export interface Dataset {
    personas: Persona[];
    stations: Station[];
    journeys: Journey[];
}
export interface DatasetFile {
    /** Path relative to the dataset root, used in messages. */
    path: string;
    text: string;
    data: unknown;
    parseError?: string;
}
export interface DatasetFiles {
    personas: DatasetFile[];
    stations: DatasetFile | null;
    journeys: DatasetFile[];
}
export interface ValidationResult {
    errors: string[];
    warnings: string[];
    dataset: Dataset;
}
/**
 * `required: "always"` means a non-empty value in every file; `"designed"` means non-empty
 * for every persona the product is designed for (any type but negative).
 */
type Required = "always" | "designed";
export type Field = {
    key: string;
    type: "string";
    optional?: true;
    required?: Required;
    enum?: readonly string[];
    pattern?: RegExp;
} | {
    key: string;
    type: "strings";
    required?: Required;
    enum?: readonly string[];
} | {
    key: string;
    type: "boolean";
} | {
    key: string;
    type: "object";
    fields: Field[];
} | {
    key: string;
    type: "objects";
    required?: Required;
    fields: Field[];
};
/** Persona file fields, in the order every persona file keeps them. */
export declare const PERSONA_FIELDS: Field[];
export declare const STATION_FIELDS: Field[];
export declare const JOURNEY_FIELDS: Field[];
/** Wording rules over the whole file text, comments included. */
export declare function checkText(path: string, text: string): string[];
/** Why a matcher is malformed, or null when it is well formed. */
export declare function matcherProblem(matcher: string): string | null;
/** Checks every rule; `dataset` holds only the files that passed their own structural checks. */
export declare function validateDataset(files: DatasetFiles): ValidationResult;
/** `<surface>:* ` when the surface is a service and the matcher uses the any-method form. */
export declare function anyMethodPrefix(surface: string, matcher: string): string | undefined;
