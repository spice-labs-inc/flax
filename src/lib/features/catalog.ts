import { ENV_ORDER, type Env, type Item } from "../data.ts";
import type {
  Feature,
  FeatureGroup,
  FeatureScenario,
  FeatureSurface,
} from "../features.ts";
import type { HexStates, MarkKind } from "../data.ts";

/** Search results in the catalog's surface order, dropping surfaces nothing matched. */
export function groupBySurface(
  groups: FeatureGroup[],
  found: Feature[],
): FeatureGroup[] {
  const hit = new Set(found);
  return groups.flatMap((g) => {
    const features = g.features.filter((f) => hit.has(f));
    return features.length ? [{ ...g, features }] : [];
  });
}

/** A feature file's description as paragraphs: blank lines separate them, single line breaks are wrapping. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

/** The issue as its repo names it: "dashboard#326" from "bug:dashboard#326" or "planned:dashboard#326". */
export function issueRef(id: string): string {
  return id.replace(/^[a-z]+:/, "");
}

/** Where a written-but-not-running scenario stands: the envs it would run in and why it waits. */
export interface PlannedNote {
  states: HexStates;
  label: string;
}

const PLANNED_DEFAULT = "Written for a feature not released yet";

export function plannedNote(
  scenarioId: string,
  items: readonly Item[],
): PlannedNote {
  const it = items.find(
    (x) =>
      x.planned?.kind === "scenario" && x.planned.scenarioId === scenarioId,
  );
  const envs: readonly Env[] = it ? it.envs : ENV_ORDER;
  const states = Object.fromEntries(
    ENV_ORDER.map((e): [Env, MarkKind] => [
      e,
      envs.includes(e) ? "planned" : "never",
    ]),
  ) as HexStates;
  const waiting =
    it?.planned?.kind === "scenario"
      ? it.planned.waitingOn.replace(/^waiting on:?\s*/i, "").trim()
      : "";
  const reason = waiting.replace(/\.$/, "");
  return {
    states,
    label: reason ? `Written, waiting for ${reason}` : PLANNED_DEFAULT,
  };
}

/** The features before and after one within its surface, in catalog order. */
export function neighbors(
  groups: FeatureGroup[],
  f: Feature,
): { prev?: Feature; next?: Feature } {
  const own = groups.find((g) => g.surface === f.surface)?.features ?? [];
  const i = own.indexOf(f);
  const out: { prev?: Feature; next?: Feature } = {};
  const prev = own[i - 1];
  const next = own[i + 1];
  if (i > 0 && prev) out.prev = prev;
  if (i >= 0 && next) out.next = next;
  return out;
}

export const ITEM_CAP = 40;

/** The first items to show and how many are folded away. */
export function capped<T>(
  list: readonly T[],
  open: boolean,
  cap = ITEM_CAP,
): { shown: readonly T[]; hidden: number } {
  if (open || list.length <= cap) return { shown: list, hidden: 0 };
  return { shown: list.slice(0, cap), hidden: list.length - cap };
}

/** "3 scenarios" or "1 scenario". */
export function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function isSurface(
  groups: FeatureGroup[],
  s: string,
): s is FeatureSurface {
  return groups.some((g) => g.surface === s);
}

/** A feature's scenarios as its page lists them: one by one, and each Scenario Outline with its rows under it. */
export type ScenarioBlock =
  | { kind: "one"; scenario: FeatureScenario }
  | { kind: "outline"; line: number; name: string; rows: FeatureScenario[] };

export function scenarioBlocks(
  scenarios: readonly FeatureScenario[],
): ScenarioBlock[] {
  const out: ScenarioBlock[] = [];
  for (const s of scenarios) {
    const ex = s.example;
    const last = out[out.length - 1];
    if (!ex) out.push({ kind: "one", scenario: s });
    else if (last?.kind === "outline" && last.line === ex.outline)
      last.rows.push(s);
    else
      out.push({
        kind: "outline",
        line: ex.outline,
        name: outlineName(ex.name),
        rows: [s],
      });
  }
  return out;
}

/** An outline's name with its placeholders left open, since each row fills them: "A guest cannot …". */
export function outlineName(name: string): string {
  return name.replace(/<[^>]+>/g, "…");
}

/** A row of an outline, told apart by its cells: "rename the organization, org:manage_org". */
export function rowLabel(s: FeatureScenario): string {
  return s.example ? s.example.cells.join(", ") : s.name;
}
