import type { Dataset, Journey, Station } from "./schema.ts";
/** The part of `coverage-map.json` journeys need. */
export interface CoverageInput {
    builtAt?: string;
    items: {
        id: string;
    }[];
}
export interface ResolvedStation extends Station {
    /** Item ids the station's matchers select, in coverage map order. */
    items: string[];
    /** Personas whose journey passes through the station. */
    personas: string[];
}
export interface BrokenStation {
    station: string;
    matchers: string[];
}
export interface DeadMatcher {
    station: string;
    matcher: string;
}
export interface JourneyResolution {
    coverageMapBuiltAt: string | null;
    stations: ResolvedStation[];
    journeys: Journey[];
    /** Surface stations none of whose matchers match an item. */
    broken: BrokenStation[];
    /** Matchers that match nothing in surface stations that do match other items. */
    deadMatchers: DeadMatcher[];
    /** Item ids no station on any journey covers. */
    orphans: string[];
}
/** Exact id, a prefix ending in `*`, or `<service surface>:* <path>` for any method with the path exact or a `*` prefix. */
export declare function matches(id: string, matcher: string): boolean;
export declare function resolveJourneys(dataset: Pick<Dataset, "stations" | "journeys">, coverage: CoverageInput): JourneyResolution;
