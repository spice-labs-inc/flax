import {
  CODE_LABEL,
  ENVS,
  type CoverageModel,
  type Code,
  type Env,
  type Item,
  type MarkKind,
} from "./data.ts";
import { STATE_LABEL, type PersonasModel, type Station } from "./personas.ts";
import type { ScenarioDetail, ScenariosModel } from "./scenarios.ts";

export interface EnvState {
  kind: MarkKind;
  label: string;
}

const CODE_KIND: Record<Code, MarkKind> = {
  [-2]: "unchecked",
  [-1]: "never",
  0: "none",
  1: "planned",
  2: "fail",
  3: "pass",
};

/** One mark per env for an item, a scenario or a station, at a timeline point. */
export function proofModel(
  cov: CoverageModel,
  pers: PersonasModel,
  scen: ScenariosModel,
) {
  const { status } = cov;
  const { stationState } = pers;
  const { recordAt } = scen;
  function itemState(it: Item, env: Env, snap: number): EnvState {
    if (it.planned?.kind === "issue")
      return it.envs.includes(env)
        ? { kind: "planned", label: "Open issue, not built yet" }
        : { kind: "never", label: CODE_LABEL[-1] };
    const c = status[snap]![it.idx]![ENVS.indexOf(env)]!;
    return { kind: CODE_KIND[c], label: CODE_LABEL[c] };
  }

  function scenarioState(d: ScenarioDetail, env: Env, snap: number): EnvState {
    const r = recordAt(d, env, snap);
    if (!r)
      return d.applies.includes(env)
        ? { kind: "none", label: "No run yet" }
        : { kind: "never", label: "Never runs here" };
    if (r.status === "p") return { kind: "pass", label: "Verified" };
    if (r.status === "f") return { kind: "fail", label: "Failed" };
    return { kind: "other", label: "Did not finish" };
  }

  function stationEnvState(st: Station, env: Env, snap: number): EnvState {
    const s = stationState(st, snap, env);
    return { kind: s, label: STATE_LABEL[s] };
  }

  return {
    itemState,
    scenarioState,
    stationEnvState,
  };
}

export type ProofModel = ReturnType<typeof proofModel>;
