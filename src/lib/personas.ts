import {
  ELSEWHERE,
  ENVS,
  envLabel,
  envsProse,
  type CoverageModel,
  type Code,
  type Env,
  type EnvChoice,
  type Item,
  PIPELINE,
  REFERENCE_ENV,
} from "./data.ts";
import {
  type PersonaDefsModel,
  type PersonaDef,
  type PersonaType,
  type Stage,
  type StationKind,
} from "./personaDefs.ts";

export const STAGES: readonly Stage[] = [
  "Discover",
  "Start",
  "Survey",
  "Understand",
  "Act",
  "Prove",
];
export type { Stage, StationKind };

export interface Station {
  key: string;
  name: string;
  stage: Stage;
  kind: StationKind;
  items: Item[];
  slot: number;
}

export interface Persona {
  id: string;
  name: string;
  type: PersonaType;
  def: PersonaDef;
  /** Stations in the order the persona's journey file lists them. */
  stations: Station[];
}

const REFERENCE_BESIDE: Partial<Record<StationState, string>> = {
  pass: "verified on",
  partial: "partly verified on",
  unchecked: "not checked on",
  none: "no scenario checks it on",
};

const TYPE_ORDER: PersonaType[] = [
  "primary",
  "secondary",
  "supplemental",
  "internal",
  "buyer",
];

export type StationState =
  | "pass"
  | "fail"
  | "partial"
  | "none"
  | "unchecked"
  | "planned"
  | "elsewhere"
  | "never";

export const STATE_LABEL: Record<StationState, string> = {
  pass: "Verified",
  fail: "Failing",
  partial: "Partly verified",
  none: "No scenario yet",
  unchecked: "Not checked here",
  planned: "Feature not built yet",
  elsewhere: ELSEWHERE,
  never: "Never run in this environment",
};

export const TYPE_LABEL: Record<PersonaType, string> = {
  primary: "Primary persona",
  secondary: "Secondary persona",
  supplemental: "Supplemental persona",
  internal: "Internal persona",
  buyer: "Buyer role, not a user persona",
  negative: "Not designed for",
};

/** Each persona's journey with its stations resolved to the map's items. */
export function personasModel(cov: CoverageModel, defs: PersonaDefsModel) {
  const { items, status } = cov;
  const { dataset, defById } = defs;
  const itemById = new Map(items.map((it) => [it.id, it]));

  const stations = new Map<string, Station>(
    dataset.stations.map((s) => [
      s.key,
      {
        key: s.key,
        name: s.name,
        stage: s.stage,
        kind: s.kind,
        items: s.items.flatMap((id) => itemById.get(id) ?? []),
        slot: 0,
      },
    ]),
  );

  const personas: Persona[] = dataset.journeys
    .flatMap((j): Persona[] => {
      const def = defById.get(j.persona);
      if (!def) return [];
      return [
        {
          id: def.id,
          name: def.name,
          type: def.type,
          def,
          stations: j.stations.flatMap((k) => stations.get(k) ?? []),
        },
      ];
    })
    .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));

  /**
   * Stations of one stage share x slots. A station on several journeys keeps one slot so its interchange lines up,
   * and each journey's stations within a stage keep the order its journey file gives them.
   */
  const stageSlots: number[] = STAGES.map((stage) => {
    const inStage = [...new Set(personas.flatMap((p) => p.stations))].filter(
      (s) => s.stage === stage,
    );
    const after = new Map<Station, Set<Station>>(
      inStage.map((s) => [s, new Set()]),
    );
    const reaches = (
      from: Station,
      to: Station,
      seen = new Set<Station>(),
    ): boolean => {
      if (from === to) return true;
      seen.add(from);
      return [...after.get(from)!].some(
        (n) => !seen.has(n) && reaches(n, to, seen),
      );
    };
    for (const p of personas) {
      const own = p.stations.filter((s) => s.stage === stage);
      for (let i = 1; i < own.length; i++) {
        const a = own[i - 1]!;
        const b = own[i]!;
        if (!reaches(b, a)) after.get(a)!.add(b);
      }
    }
    const depth = new Map<Station, number>();
    const slotOf = (s: Station): number => {
      const known = depth.get(s);
      if (known !== undefined) return known;
      let d = 0;
      for (const [a, next] of after)
        if (next.has(s)) d = Math.max(d, slotOf(a) + 1);
      depth.set(s, d);
      return d;
    };
    let max = 0;
    for (const s of inStage) {
      s.slot = slotOf(s);
      max = Math.max(max, s.slot + 1);
    }
    return max;
  });

  /**
   * A station passes when every item it needs passes in the chosen env(s); one failing item strands the line there.
   * With nothing verified, it is not checked here when scenarios reach its items elsewhere.
   */
  function stationState(
    st: Station,
    snap: number,
    env: EnvChoice,
  ): StationState {
    if (st.kind === "elsewhere") return "elsewhere";
    if (st.kind === "planned") return "planned";
    const eis = env === "all" ? ENVS.map((_, i) => i) : [ENVS.indexOf(env)];
    let pass = 0;
    let total = 0;
    let fail = false;
    let unchecked = false;
    for (const it of st.items) {
      for (const ei of eis) {
        const c: Code = status[snap]![it.idx]![ei]!;
        if (c === -1) continue;
        total++;
        if (c === 3) pass++;
        if (c === 2) fail = true;
        if (c === -2) unchecked = true;
      }
    }
    if (total === 0) return "never";
    if (fail) return "fail";
    if (pass === total) return "pass";
    if (pass > 0) return "partial";
    return unchecked ? "unchecked" : "none";
  }

  /** The pipeline envs beside the reference env: "Breaks on test; verified on live." None when they do not break or the reference env fails too. */
  function pipelineNote(st: Station, snap: number): string | undefined {
    const broken = PIPELINE.filter((e) => stationState(st, snap, e) === "fail");
    if (!broken.length) return undefined;
    const ref = stationState(st, snap, REFERENCE_ENV);
    if (ref === "fail") return undefined;
    const where = `Breaks on ${envsProse(broken, true)}`;
    const beside = REFERENCE_BESIDE[ref];
    return beside
      ? `${where}; ${beside} ${envLabel(REFERENCE_ENV).toLowerCase()}.`
      : `${where}.`;
  }

  /** Items no station on any persona's journey covers, as the workspace dataset resolved them. */
  const orphans: Item[] = dataset.orphans
    .flatMap((id) => itemById.get(id) ?? [])
    .filter((it) => it.kind !== "Element");
  const orphanIds = new Set(dataset.orphans);
  const claimed = new Set<number>(
    items
      .filter((it) => !it.planned && !orphanIds.has(it.id))
      .map((it) => it.idx),
  );

  return {
    personas,
    stageSlots,
    stationState,
    pipelineNote,
    orphans,
    claimed,
  };
}

export type PersonasModel = ReturnType<typeof personasModel>;
