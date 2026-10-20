import type { Model } from "../lib/allowlists.ts";
import type { ModelJobConfig, ThinkingLevel } from "../lib/job.ts";

/** The longest model_reason kept in the report; the rest is cut. */
export const MAX_MODEL_REASON = 300;

export interface ChosenModel {
  model: Model;
  thinking: ThinkingLevel;
  /** collect.ts's choice changed the model from the job's default. */
  changed: boolean;
  /** Why collect.ts chose it, as it said in model_reason. */
  reason?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The model a run uses: the job's own (or the one a hand-started run
 * picked), unless the job lists `models` and collect.ts named one of them
 * as the input's top-level `model`. A choice the job does not list is
 * refused; collect.ts can pick between reviewed models, never add one.
 */
export function chooseModel(options: {
  config: ModelJobConfig;
  current: Model;
  models: readonly Model[];
  input: unknown;
  /** A hand-started run named its model; collect.ts's choice is ignored. */
  overridden: boolean;
}): { ok: true; chosen: ChosenModel } | { ok: false; error: string } {
  const { config, current } = options;
  const keep = {
    ok: true as const,
    chosen: { model: current, thinking: config.thinking, changed: false },
  };
  if (config.models === undefined || options.overridden) return keep;
  if (!isObject(options.input) || options.input.model === undefined)
    return keep;
  const named = options.input.model;
  const choice = config.models.find((c) => c.model === named);
  if (typeof named !== "string" || choice === undefined)
    return {
      ok: false,
      error: `collect.ts chose the model ${JSON.stringify(named)}, which ${config.name}'s models does not list (${config.models.map((c) => c.model).join(", ")})`,
    };
  const model = options.models.find((m) => m.id === choice.model);
  if (model === undefined)
    return {
      ok: false,
      error: `collect.ts chose ${choice.model}, which models.yml does not list`,
    };
  const rawReason = options.input.model_reason;
  const reason =
    typeof rawReason === "string" && rawReason.trim() !== ""
      ? rawReason.trim().slice(0, MAX_MODEL_REASON)
      : undefined;
  return {
    ok: true,
    chosen: {
      model,
      thinking: choice.thinking,
      changed: model.id !== current.id || choice.thinking !== config.thinking,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}
