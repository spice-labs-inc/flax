import { formatPacific, type Surface } from "../data.ts";
import {
  SURFACE_ORDER,
  SURFACE_TITLE,
  type Feature,
  type FeatureSurface,
} from "../features.ts";
import type { PlannedIssue } from "../planning.ts";

/** A scenario written and tagged planned, as the map carries it. */
export interface PlannedScenario {
  label: string;
  surface: Surface;
  scenarioId: string;
  feature: string;
  waitingOn: string;
}

export interface SurfaceGroup {
  surface: Surface;
  title: string;
  issues: PlannedIssue[];
  scenarios: PlannedScenario[];
}

export interface PersonaGroup<P> {
  persona: P;
  issues: PlannedIssue[];
}

/** "notes-co/notes-web/issues/199" as people say it: notes-web#199. */
export function repoRef(url: string): string {
  const m = /github\.com\/[^/]+\/([^/]+)\/(?:issues|pull)\/(\d+)/.exec(url);
  return m ? `${m[1]}#${m[2]}` : url.replace(/^https?:\/\//, "");
}

const BOARD_WORDS: Record<string, string> = {
  Backlog: "In the backlog",
  Ready: "Ready to build",
  "In progress": "In progress",
  "In review": "In review",
  "Not on board": "Not on the board yet",
};

export function boardWords(board: string): string {
  return BOARD_WORDS[board] ?? board;
}

/** What a written scenario waits for, as one sentence. */
export function waitsOn(waitingOn: string): string {
  const text = waitingOn.replace(/^waiting on:?\s*/i, "").trim();
  if (!text) return "Waits for the feature it describes to be built.";
  const body = text.replace(/\.$/, "");
  return `Waits on ${body.charAt(0).toLowerCase()}${body.slice(1)}.`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The page's opening statement from the two counts. */
export function headline(issues: number, scenarios: number): string {
  if (!issues && !scenarios) return "Nothing is planned.";
  return `${plural(issues, "planned feature")} on the Engineering Board, ${plural(
    scenarios,
    "scenario",
  )} written and waiting.`;
}

/** Where the board data came from and when GitHub last confirmed the issues were still open. */
export function sourceSentence(src: {
  readAt?: string | null;
  checkedAt: string;
  source?: string | null;
}): string {
  const from = src.source
    ? `From the ${src.source.replace(/\s*\(https?:[^)]*\)/, "")}`
    : "From the Engineering Board as explorer/board.json keeps it";
  const read = src.readAt ? `, read ${formatPacific(src.readAt)}` : "";
  return `${from}${read}; each issue was checked open on GitHub ${formatPacific(src.checkedAt)}.`;
}

/** The existing feature a planned issue extends: same surface, the issue's area naming the feature's area or file. */
export function featureFor(
  features: readonly Feature[],
  issue: Pick<PlannedIssue, "area"> & { item: { surface: FeatureSurface } },
): Feature | undefined {
  return features.find(
    (f) =>
      f.surface === issue.item.surface &&
      (f.area === issue.area || f.stem === issue.area),
  );
}

const BOARD_RANK: Record<string, number> = {
  "In progress": 0,
  "In review": 0,
  Ready: 1,
  Backlog: 2,
  "Not on board": 3,
};
const rank = (b: string) => BOARD_RANK[b] ?? 2;

/** Issues nearest to being built first, then by title. */
export function byReadiness(issues: PlannedIssue[]): PlannedIssue[] {
  return [...issues].sort(
    (a, b) =>
      rank(a.board) - rank(b.board) || a.item.label.localeCompare(b.item.label),
  );
}

/** Everything not built yet, by the surface it lands on, in the catalog's surface order. */
export function groupBySurface(
  issues: PlannedIssue[],
  scenarios: PlannedScenario[],
): SurfaceGroup[] {
  return SURFACE_ORDER.flatMap((surface) => {
    if (surface === "core") return [];
    const own: SurfaceGroup = {
      surface,
      title: SURFACE_TITLE[surface],
      issues: byReadiness(issues.filter((i) => i.item.surface === surface)),
      scenarios: scenarios.filter((s) => s.surface === surface),
    };
    return own.issues.length || own.scenarios.length ? [own] : [];
  });
}

/** Planned issues by the persona they name, in the personas' own order; a persona with nothing planned gets no group. */
export function groupByPersona<P extends { id: string }>(
  personas: readonly P[],
  issues: PlannedIssue[],
): { groups: PersonaGroup<P>[]; nobody: PlannedIssue[]; idle: P[] } {
  const groups: PersonaGroup<P>[] = [];
  const idle: P[] = [];
  for (const persona of personas) {
    const own = byReadiness(
      issues.filter((i) => i.personas.includes(persona.id)),
    );
    if (own.length) groups.push({ persona, issues: own });
    else idle.push(persona);
  }
  return {
    groups,
    nobody: byReadiness(issues.filter((i) => i.personas.length === 0)),
    idle,
  };
}
