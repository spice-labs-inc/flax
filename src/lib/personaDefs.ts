export type PersonaType =
  "primary" | "secondary" | "supplemental" | "internal" | "buyer" | "negative";

/** A persona file from the workspace's personas/ directory. */
export interface PersonaDef {
  id: string;
  name: string;
  type: PersonaType;
  summary: string;
  who: string;
  titles: string[];
  goals: string[];
  needs: string[];
  consumes: string;
  prize: { quote?: string; test: string };
  journey: { name: string; steps: string[] };
  friction: string[];
  antiGoals: string[];
  surfaces: string[];
  neverTouches: string[];
  editions: string[];
  fixtureRole: string;
  tensions: { with: string; conflict: string; rule: string }[];
  evidence: {
    claim: string;
    source: string;
    date: string;
    assumption: boolean;
  }[];
  sources: { title: string; date: string; where: string }[];
}

export type Stage =
  "Discover" | "Start" | "Survey" | "Understand" | "Act" | "Prove";
export type StationKind = "surface" | "planned" | "elsewhere";

export interface DatasetFile {
  commit: string;
  coverageMapBuiltAt: string | null;
  personas: PersonaDef[];
  stations: {
    key: string;
    name: string;
    stage: Stage;
    kind: StationKind;
    items: string[];
  }[];
  journeys: { persona: string; stations: string[] }[];
  orphans: string[];
  broken: { station: string; matchers: string[] }[];
  deadMatchers: { station: string; matcher: string }[];
}

export function personaDefsModel(dataset: DatasetFile) {
  const personaDefs: PersonaDef[] = dataset.personas;
  const defById = new Map(personaDefs.map((d) => [d.id, d]));

  return {
    dataset,
    personaDefs,
    defById,
  };
}

export type PersonaDefsModel = ReturnType<typeof personaDefsModel>;
