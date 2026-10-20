import type {
  BoardFile,
  CoverageFile,
  CoverageFileItem,
  CoverageStatus,
  DocSource,
  Env,
  HistoryFile,
  ItemLink,
  Snapshot,
  SurfaceName as Surface,
} from "@flax/contract";
import type { ScenariosConfig, SurfaceConfig } from "@flax/contract/config";

import type { BoardEntry } from "@flax/contract";
export type {
  BoardEntry,
  BoardFile,
  CoverageFile as CoverageData,
  DocSource,
  Env,
  HistoryFile,
  ItemLink,
  Snapshot,
  Surface,
};

/** The workspace config the page was built for. */
export const CONFIG: ScenariosConfig = __FLAX_CONFIG__;
/** The environments in config order: the data order, the display order, and the first one is the reference env (the customer.s truth). */
export const ENVS: readonly Env[] = CONFIG.envs.map((e) => e.name);
export const N_ENVS = ENVS.length;
export const REFERENCE_ENV: Env = ENVS[0]!;
/** The envs a change passes through before the reference env, nearest first. */
export const PIPELINE: readonly Env[] = ENVS.slice(1);
export type EnvChoice = Env | "all";
/** Display order equals data order now; kept as a name for the many readers. */
export const ENV_ORDER: readonly Env[] = ENVS;
export function surfaceConfigOf(name: string): SurfaceConfig | undefined {
  return CONFIG.surfaces.find((s) => s.name === name);
}
/** Per env, a record built from a function; replaces the three-key literals. */
export function byEnv<T>(f: (env: Env, ei: number) => T): Record<Env, T> {
  return Object.fromEntries(ENVS.map((e, i) => [e, f(e, i)])) as Record<Env, T>;
}
/** Whether a scenario with these tags is left out of an env by the config.s tag policy. */
export function excludedOn(
  tags: readonly string[],
  env: Env,
): string | undefined {
  return CONFIG.envs
    .find((e) => e.name === env)
    ?.excludeTags.find((t) => tags.includes(t));
}

/** The states a mark or a hex face can show: shape and color carry the state. */
export type MarkKind =
  | "pass"
  | "fail"
  | "partial"
  | "planned"
  | "none"
  | "skip"
  | "other"
  | "never"
  | "elsewhere"
  | "unchecked";

/** The environments. states as the hex splits them: one sector per env, the reference env on top. */
export type HexStates = Record<Env, MarkKind>;

/** Per env: -2 not checked here though scenarios reach it elsewhere, -1 never runs there, 0 no scenario, 1 planned, 2 failing, 3 verified. */
export type Code = -2 | -1 | 0 | 1 | 2 | 3;

/** Why a cell reads as it does, beyond its code: verified only by steps before a later step failed, or why it is not checked here. */
export type CellNote =
  "later-failed" | "elsewhere" | "partial" | "skipped" | "unreached";

/** One island on the map: a whole surface, or the areas of one that the build split off. */
export interface SurfaceInfo {
  island: string;
  surface: Surface;
  title: string;
  /** The areas and planned scenario feature files this island takes from its surface; empty when it is the whole surface. */
  areas: string[];
  features: string[];
  items: number;
  notes: string[];
  outOfScope: { label: string; reason: string }[];
}

/** Not on the map as surface yet: a scenario written and waiting, or an open issue for a feature not built. */
export type PlannedInfo =
  | {
      kind: "scenario";
      scenarioId: string;
      feature: string;
      waitingOn: string;
      pIdx: number;
    }
  | {
      kind: "issue";
      url: string;
      board: string;
      area: string;
      personas: string[];
    };

/** One item as the page holds it: the file.s item plus its index, island and planned-ness. */
export interface Item extends CoverageFileItem {
  idx: number;
  island: string;
  status: Partial<Record<Env, CoverageStatus>>;
  planned?: PlannedInfo;
}

export const DOC_KIND: Record<DocSource["kind"], string> = {
  readme: "README",
  "internal-doc": "Internal doc",
};

/** Everything the map, panels and timeline read from coverage.json, history.json and board.json. */
export const ENV_LABEL: Record<Env, string> = byEnv(
  (e) => CONFIG.envs.find((x) => x.name === e)?.label ?? e,
);
export function envLabel(env: Env): string {
  return CONFIG.envs.find((x) => x.name === env)?.label ?? env;
}
/** The environments read out in config order: "Live, Staging and Test". */
export function envsProse(envs: readonly Env[] = ENVS, lower = false): string {
  const names = envs.map((e) =>
    lower ? envLabel(e).toLowerCase() : envLabel(e),
  );
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
/** How the page describes a station or scenario verified outside these runs. */
export const ELSEWHERE: string = CONFIG.vocabulary.elsewhere;
/** A site is one deployment, not one per environment: its home is named by its area, so the panels never name an env for it. */
export function singleHome(it: Item): boolean {
  return surfaceConfigOf(it.surface)?.singleHome ?? false;
}

/** The places an item's status is reported for, in panel order. */
export function homesOf(it: Item): { env: Env; label: string }[] {
  if (singleHome(it)) return it.envs.map((env) => ({ env, label: it.area }));
  return ENV_ORDER.map((env) => ({ env, label: ENV_LABEL[env] }));
}

/** What to call an environment on an item's panel. */
export function whereLabel(it: Item, env: Env): string {
  return singleHome(it) ? it.area : ENV_LABEL[env];
}

/** A link's address as people read it: no scheme, no trailing slash. */
export function readableUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export const CODE_LABEL: Record<Code, string> = {
  [-2]: "Not checked here",
  [-1]: "Never run here",
  0: "No scenario yet",
  1: "Scenario planned",
  2: "Failing",
  3: "Verified",
};
/** A background per code; not checked here is hatched, so it never reads as plain grey. */
export const CODE_COLOR: Record<Code, string> = {
  [-2]: "repeating-linear-gradient(135deg, var(--land-edge) 0 1.5px, transparent 1.5px 3.5px)",
  [-1]: "transparent",
  0: "var(--land-edge)",
  1: "var(--planned)",
  2: "var(--fail)",
  3: "var(--pass)",
};

export type RunCode = "pass" | "fail" | "other" | "none";
export interface ScenarioRef {
  id: string;
  name: string;
  feature: string;
  sIdx: number;
  /** Some run recorded which step each of its touches came from. */
  stepped?: true;
}

export interface Tally {
  pass: number;
  fail: number;
  planned: number;
  none: number;
  unchecked: number;
  slots: number;
}

export function envIndexes(env: EnvChoice): number[] {
  return env === "all" ? ENVS.map((_, i) => i) : [ENVS.indexOf(env)];
}

export function coverageModel(
  data: CoverageFile,
  history: HistoryFile,
  board: BoardFile,
) {
  const builtAt = data.builtAt;
  const scenariosCommit = history.scenariosCommit;
  const surfaces = data.surfaces.filter((s) => s.items > 0);
  const boardSource = {
    readAt: board.readAt,
    checkedAt: board.checkedAt,
    source: board.source,
  };
  const bugs = board.bugs.filter((b) => b.state === "open");

  /**
   * What a hex can carry: an element goes by its test id alone, and a page by the part of
   * its route that is its own, without the prefix every page shares. Ids and kinds stay as they are.
   */
  function shortLabel(it: { kind: string; label: string }): string {
    if (it.kind === "Element") return it.label.replace(/^Test id /, "");
    if (it.kind === "Page" || it.kind === "Redirect") {
      const m = /^(Page |Redirect )(\/.*)$/.exec(it.label);
      if (!m) return it.label;
      const tail = m[2]!
        .replace(/^\/app\/\[project_uuid\]\/?/, "")
        .replace(/^\/app\/?/, "")
        .replace(/\[([a-zA-Z]+?)(?:_?uuid|_?[iI]d)\]/g, "[$1]");
      const name = tail === "" ? (m[2] === "/" ? "/" : "home") : tail;
      return m[1] === "Redirect " ? `Redirect ${name}` : name;
    }
    return it.label;
  }

  /** The island an item of a surface lands on: by its area, else by a planned scenario's feature file, else the surface's own. */
  function islandOf(surface: Surface, area: string, id = ""): string {
    const own = surfaces.filter((s) => s.surface === surface);
    return (own.find((s) => s.areas.includes(area)) ??
      own.find((s) => s.features.some((f) => id.startsWith(`${f}:`))) ??
      own.find((s) => s.areas.length === 0) ??
      own[0])!.island;
  }

  const real: Item[] = data.items.map((it, idx) => ({
    ...it,
    idx,
    label: shortLabel(it),
    island: islandOf(it.surface, it.area),
  }));
  const onMap = (s: Surface) => surfaces.some((x) => x.surface === s);

  const plannedScenarioItems = history.planned
    .map((p, pIdx) => ({ p, pIdx }))
    .filter(({ p }) => onMap(p.surface))
    .map(({ p, pIdx }, i): Item => ({
      idx: real.length + i,
      id: `scenario:${p.id}`,
      label: p.name,
      surface: p.surface,
      island: islandOf(p.surface, "", p.id),
      area: "Planned scenarios",
      kind: "Planned scenario",
      envs: p.envs,
      status: {},
      planned: {
        kind: "scenario",
        scenarioId: p.id,
        feature: p.feature,
        waitingOn: p.waitingOn,
        pIdx,
      },
    }));

  const issueItems = board.items
    .filter((p) => p.state === "open" && onMap(p.surface))
    .map((p, i): Item => ({
      idx: real.length + plannedScenarioItems.length + i,
      id: p.id,
      label: p.label,
      surface: p.surface,
      island: islandOf(p.surface, p.area),
      area: "Open issues",
      kind: "Open issue",
      envs: surfaceConfigOf(p.surface)?.envs.length
        ? [...surfaceConfigOf(p.surface)!.envs]
        : [...ENVS],
      status: {},
      planned: {
        kind: "issue",
        url: p.url,
        board: p.status,
        area: p.area,
        personas: p.personas ?? [],
      },
    }));

  const plannedScenarioCount = plannedScenarioItems.length;
  const openIssueCount = issueItems.length;

  /** Elements (a dashboard's test ids) are parts of a page, not hexes; the ones in shared components gather under one hex per surface. */
  const elements = real.filter((it) => it.kind === "Element");
  const SHARED_AREA = "Shared across sections";
  const sharedItems: Item[] = [
    ...new Set(elements.filter((c) => !c.page).map((c) => c.surface)),
  ].map((surface, i): Item => {
    const own = elements.filter((c) => !c.page && c.surface === surface);
    return {
      idx: real.length + plannedScenarioItems.length + issueItems.length + i,
      id: `${surface}:shared-elements`,
      label: "Shared elements",
      surface,
      island: islandOf(surface, SHARED_AREA),
      area: SHARED_AREA,
      kind: "Shared elements",
      envs: ENVS.filter((e) => own.some((c) => c.envs.includes(e))),
      status: {},
    };
  });
  const items: Item[] = [
    ...real,
    ...plannedScenarioItems,
    ...issueItems,
    ...sharedItems,
  ];
  /** What the map draws: everything a customer can reach, with elements and parts folded into what holds them. */
  const mapItems = items.filter((it) => it.kind !== "Element" && !it.parent);

  /** What an item directly holds: a page's elements, a surface's shared elements, and any item naming it as parent. */
  function childrenOf(it: Item): Item[] {
    const own =
      it.kind === "Page"
        ? elements.filter((c) => c.page === it.id)
        : it.kind === "Shared elements"
          ? elements.filter((c) => !c.page && c.surface === it.surface)
          : [];
    return [...own, ...real.filter((c) => c.parent === it.id)];
  }

  /** Everything folded into an item: its elements and parts, and their parts in turn. */
  function elementsOf(it: Item): Item[] {
    const out: Item[] = [];
    const walk = (x: Item) => {
      for (const c of childrenOf(x)) {
        out.push(c);
        walk(c);
      }
    };
    walk(it);
    return out;
  }

  /** Elements other pages own or share that this page also renders. */
  function sharedElementsOn(it: Item): Item[] {
    return it.kind === "Page"
      ? elements.filter((c) => !c.page && c.usedBy?.includes(it.id))
      : [];
  }

  /** The item an element or part sits in directly: its page, its surface's Shared elements hex, or its parent. */
  function holderOf(it: Item): Item | undefined {
    const id =
      it.kind === "Element"
        ? (it.page ?? `${it.surface}:shared-elements`)
        : it.parent;
    return id ? items.find((x) => x.id === id) : undefined;
  }

  /** The holders above an item, outermost first: the videos page, then the video, for a video's share control. */
  function holderChain(it: Item): Item[] {
    const out: Item[] = [];
    for (let h = holderOf(it); h; h = holderOf(h)) out.unshift(h);
    return out;
  }

  /** What an item shows when opened as a map of its own: its elements and parts, and the shared elements a page renders. */
  function insideItems(it: Item): Item[] {
    return [...childrenOf(it), ...sharedElementsOn(it)];
  }

  /** How many items a holder opens into. */
  function holdCount(it: Item): number {
    return insideItems(it).length;
  }

  /** Items that open as a sub-map: anything holding elements or parts. */
  const holders = new Set(
    items.filter((it) => insideItems(it).length > 0).map((it) => it.idx),
  );

  /** The district an item takes inside its holder: a page's elements by component, parts by kind, shared elements apart. */
  function districtInside(holder: Item, it: Item): string {
    if (it.kind === "Element")
      return it.page === holder.id || holder.kind === "Shared elements"
        ? (it.component ?? "Other elements")
        : "Shared with other pages";
    return it.kind;
  }

  /** A sub-map's name: a page alone in its area goes by the area's name, any other holder by its own label. */
  function insideTitle(it: Item): string {
    if (it.kind === "Page") {
      const siblings = real.filter(
        (x) =>
          x.kind === "Page" && x.surface === it.surface && x.area === it.area,
      );
      if (siblings.length === 1) return it.area;
    }
    return it.label.replace(/^Page /, "");
  }

  /** The sub-map of a holder: one island named for it, its contents placed by district; null when it holds nothing. */
  function insideOf(
    it: Item,
  ): { info: SurfaceInfo; items: Item[]; place: Map<number, string> } | null {
    const list = insideItems(it);
    if (list.length === 0) return null;
    const place = new Map(list.map((x) => [x.idx, districtInside(it, x)]));
    return {
      info: {
        island: `inside:${it.id}`,
        surface: it.surface,
        title: insideTitle(it),
        areas: [...new Set(place.values())],
        features: [],
        items: list.length,
        notes: [],
        outOfScope: [],
      },
      items: list,
      place,
    };
  }

  /** The surface island an item belongs to, by name, wherever it is drawn. */
  function surfaceTitleOf(it: Item): string {
    return surfaces.find((s) => s.island === it.island)?.title ?? it.surface;
  }

  /** The docs pages and controls that document an item. */
  function documentedBy(it: Item): Item[] {
    return real.filter((c) => c.documents?.includes(it.id));
  }

  /** The READMEs and internal docs that document an item, or any part it holds when `deep`. */
  function docSources(it: Item): DocSource[] {
    return (data.documentation ?? []).filter((d) =>
      d.documents.includes(it.id),
    );
  }

  /** The items a docs page or control documents, as items. */
  function documentsOf(it: Item): Item[] {
    return (it.documents ?? []).flatMap(
      (id) => items.find((x) => x.id === id) ?? [],
    );
  }

  /** The needs a scenario's touches named for the item. */
  function itemNeeds(it: Item, sIdx: number): string[] {
    return history.itemNeeds?.[it.id]?.[sIdx] ?? [];
  }

  /** The steps of a scenario whose touches reached the item, when its run recorded them. */
  function itemSteps(it: Item, sIdx: number): number[] | undefined {
    return history.itemSteps?.[it.id]?.[sIdx];
  }

  if (history.itemCount !== real.length)
    throw new Error(
      `history covers ${history.itemCount} items, the map has ${real.length}; run pnpm explorer`,
    );

  const snapshots = history.snapshots;
  const LATEST = snapshots.length - 1;

  const CHAR_CODE: Record<string, Code> = {
    "-": -1,
    "0": 0,
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 3,
    "5": -2,
    "6": -2,
    "7": -2,
    "8": -2,
  };
  const CHAR_NOTE: Record<string, CellNote> = {
    "4": "later-failed",
    "5": "elsewhere",
    "6": "partial",
    "7": "skipped",
    "8": "unreached",
  };

  /** What a real item's cell says beyond its code at a timeline point, by env index. */
  function cellNote(it: Item, snap: number, ei: number): CellNote | undefined {
    if (it.idx >= real.length) return undefined;
    return CHAR_NOTE[snapshots[snap]!.status[it.idx * N_ENVS + ei]!];
  }

  /** status[snapshot][item.idx][envIndex] */
  const status: Code[][][] = snapshots.map((snap) => {
    const rows: Code[][] = real.map((it) =>
      ENVS.map((_, ei) => CHAR_CODE[snap.status[it.idx * N_ENVS + ei]!] ?? 0),
    );
    for (const it of plannedScenarioItems) {
      const p = it.planned!;
      const listed = p.kind === "scenario" && snap.planned[p.pIdx] === "1";
      rows.push(
        ENVS.map((e): Code => (listed && it.envs.includes(e) ? 1 : -1)),
      );
    }
    for (const it of issueItems)
      rows.push(ENVS.map((e): Code => (it.envs.includes(e) ? 0 : -1)));
    // A shared hex shows the worst of its elements: failing, else verified, else planned, else not checked here, else nothing yet.
    for (const it of sharedItems) {
      const own = elementsOf(it);
      rows.push(
        ENVS.map((_, ei): Code => {
          const codes = own.map((c) => rows[c.idx]![ei]!);
          for (const want of [2, 3, 1, -2, 0] as const)
            if (codes.includes(want)) return want;
          return -1;
        }),
      );
    }
    return rows;
  });
  const realCount = mapItems.filter((it) => !it.planned).length;

  const scenarios: ScenarioRef[] = history.scenarios.map((s, sIdx) => ({
    ...s,
    sIdx,
  }));
  const scenariosOf = new Map(
    Object.entries(history.itemScenarios).map(([id, xs]) => [
      id,
      xs.map((i) => scenarios[i]!),
    ]),
  );

  /** Scenarios any run so far recorded touching the item itself, without its elements. */
  function ownScenarios(it: Item): ScenarioRef[] {
    return scenariosOf.get(it.id) ?? [];
  }

  /** Scenarios any run so far recorded touching the item; a page or a shared hex counts its elements' touches too. */
  function itemScenarios(it: Item): ScenarioRef[] {
    const own = scenariosOf.get(it.id) ?? [];
    const parts = elementsOf(it);
    if (!parts.length) return own;
    const seen = new Set(own);
    for (const c of parts)
      for (const s of scenariosOf.get(c.id) ?? []) seen.add(s);
    return [...seen].sort((x, y) => x.sIdx - y.sIdx);
  }

  const RUN_CODE: Record<string, RunCode> = {
    p: "pass",
    f: "fail",
    o: "other",
    "-": "none",
  };

  /** A scenario's latest result per env as of a snapshot. */
  function scenarioResults(s: ScenarioRef, snap: number): RunCode[] {
    const str = snapshots[snap]!.scen;
    return ENVS.map((_, ei) => RUN_CODE[str[s.sIdx * N_ENVS + ei]!] ?? "none");
  }

  /** Counts env checks on real surface items; planned scenarios and open issues are not checks yet. */
  function tally(list: Item[], snap: number, env: EnvChoice): Tally {
    const t: Tally = {
      pass: 0,
      fail: 0,
      planned: 0,
      none: 0,
      unchecked: 0,
      slots: 0,
    };
    const eis = envIndexes(env);
    const rows = status[snap]!;
    for (const it of list) {
      if (it.planned) continue;
      for (const ei of eis) {
        const c = rows[it.idx]![ei]!;
        if (c === -1) continue;
        t.slots++;
        if (c === 3) t.pass++;
        else if (c === 2) t.fail++;
        else if (c === 1) t.planned++;
        else if (c === -2) t.unchecked++;
        else t.none++;
      }
    }
    return t;
  }

  /** An item counts as covered when every env it runs in has a scenario result (passing or failing). */
  function coveredCount(list: Item[], snap: number, env: EnvChoice): number {
    const rows = status[snap]!;
    let n = 0;
    for (const it of list) {
      if (it.planned) continue;
      const codes = rows[it.idx]!;
      const ok =
        env === "all"
          ? codes.every((c) => c === 3 || c === 2 || c === -1) &&
            codes.some((c) => c >= 2)
          : codes[ENVS.indexOf(env)]! >= 2;
      if (ok) n++;
    }
    return n;
  }

  return {
    builtAt,
    scenariosCommit,
    surfaces,
    boardSource,
    bugs,
    islandOf,
    realCount,
    childrenOf,
    sharedElementsOn,
    holderOf,
    holderChain,
    holders,
    holdCount,
    insideOf,
    surfaceTitleOf,
    documentedBy,
    documentsOf,
    docSources,
    itemNeeds,
    itemSteps,
    mapItems,
    elements,
    elementsOf,
    plannedScenarioCount,
    openIssueCount,
    items,
    snapshots,
    LATEST,
    status,
    cellNote,
    scenarios,
    ownScenarios,
    itemScenarios,
    scenarioResults,
    tally,
    coveredCount,
  };
}

export type CoverageModel = ReturnType<typeof coverageModel>;

export function formatPacific(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CONFIG.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

export function formatPacificDay(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CONFIG.timezone,
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

export function formatPacificTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CONFIG.timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
