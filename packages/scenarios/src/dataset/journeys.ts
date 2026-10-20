import { config } from "../config.ts";
import type { Dataset, Journey, Station } from "./schema.ts";

/** The part of `coverage-map.json` journeys need. */
export interface CoverageInput {
  builtAt?: string;
  items: { id: string }[];
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
export function matches(id: string, matcher: string): boolean {
  const colon = matcher.indexOf(":");
  const surface = colon < 0 ? "" : matcher.slice(0, colon);
  const anyMethod =
    config().matchers.apiPath &&
    matcher.startsWith(`${surface}:* `) &&
    config().surfaces.some((s) => s.name === surface && s.role === "service");
  if (anyMethod) {
    if (!id.startsWith(`${surface}:`)) return false;
    const space = id.indexOf(" ");
    if (space < 0) return false;
    const path = id.slice(space + 1);
    const want = matcher.slice(`${surface}:* `.length);
    return want.endsWith("*")
      ? path.startsWith(want.slice(0, -1))
      : path === want;
  }
  return matcher.endsWith("*")
    ? id.startsWith(matcher.slice(0, -1))
    : id === matcher;
}

export function resolveJourneys(
  dataset: Pick<Dataset, "stations" | "journeys">,
  coverage: CoverageInput,
): JourneyResolution {
  const ids = coverage.items.map((i) => i.id);
  const broken: BrokenStation[] = [];
  const deadMatchers: DeadMatcher[] = [];
  const stations = dataset.stations.map((s): ResolvedStation => {
    const items = ids.filter((id) => s.match.some((m) => matches(id, m)));
    if (s.kind === "surface") {
      if (items.length === 0)
        broken.push({ station: s.key, matchers: [...s.match] });
      else
        for (const m of s.match)
          if (!items.some((id) => matches(id, m)))
            deadMatchers.push({ station: s.key, matcher: m });
    }
    const personas = dataset.journeys
      .filter((j) => j.stations.includes(s.key))
      .map((j) => j.persona);
    return { ...s, items, personas };
  });
  const covered = new Set(
    stations.filter((s) => s.personas.length > 0).flatMap((s) => s.items),
  );
  return {
    coverageMapBuiltAt: coverage.builtAt ?? null,
    stations,
    journeys: dataset.journeys,
    broken,
    deadMatchers,
    orphans: ids.filter((id) => !covered.has(id)),
  };
}
