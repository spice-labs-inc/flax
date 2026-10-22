import type { Feature } from "../features.ts";
import { format, type Route, type RouteData } from "../location.ts";
import { hrefOf } from "../nav.ts";

/** Links out of the Personas door; the env and timeline point carry over, nothing else does. */
export function personaLinks(route: Route, m: RouteData) {
  const base = {
    env: route.env,
    snap: route.snap,
    lens: "all" as const,
  };
  return {
    overview: hrefOf(format({ ...base, view: "personas" }, m)),
    gaps: hrefOf(format({ ...base, view: "personas", gaps: true }, m)),
    persona: (id: string, station?: string) =>
      hrefOf(
        format(
          {
            ...base,
            view: "personas",
            persona: id,
            ...(station ? { station } : {}),
          },
          m,
        ),
      ),
    lines: (id?: string) =>
      hrefOf(
        format(
          {
            ...base,
            view: "personas",
            lines: true,
            ...(id ? { persona: id } : {}),
          },
          m,
        ),
      ),
    scenario: (id: string) =>
      hrefOf(format({ ...base, view: "map", scenario: id }, m)),
    feature: (f: Feature) =>
      hrefOf(
        format(
          { ...base, view: "features", feature: `${f.surface}/${f.stem}` },
          m,
        ),
      ),
    orphans: hrefOf(format({ ...base, view: "map", lens: "orphans" }, m)),
  };
}

export type PersonaLinks = ReturnType<typeof personaLinks>;
