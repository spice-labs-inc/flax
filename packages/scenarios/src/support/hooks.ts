import {
  After,
  AfterAll,
  AfterStep,
  Before,
  BeforeStep,
  setDefaultTimeout,
  setParallelCanAssign,
} from "@cucumber/cucumber";
import { SceneRecording } from "../record/media.ts";
import { plannedRecording } from "../record/plan.ts";
import type { ResolvedSidecar } from "../record/sidecar.ts";
import { scenarioSteps } from "../record/steps.ts";
import { currentRecordPlan } from "../run/env.ts";
import { touchesMediaType } from "../run/results.ts";
import { canRunAlongside } from "../run/tags.ts";
import { closeSharedBrowser, type ScenarioWorld } from "./world.ts";

export interface BaseHookOptions {
  timeoutMs?: number;
  /**
   * In a record run, a script for every document of a filmed page, added before its first load:
   * the workspace's stand-in text for run-specific values, for one. Given the scenario's sidecar.
   */
  recordInitScript?: (
    sidecar: ResolvedSidecar,
  ) => string | undefined | Promise<string | undefined>;
}

/**
 * The base hooks: step tracking, the touches attachment, the shared browser, and in a record run
 * the recording of each planned scenario. A workspace imports this module from its own support
 * file and adds its hooks (fixture teardown, env guards) beside it.
 */
export function installBaseHooks(options: BaseHookOptions = {}): void {
  setDefaultTimeout(options.timeoutMs ?? 5 * 60_000);
  setParallelCanAssign(canRunAlongside);

  Before(async function (this: ScenarioWorld, { pickle, gherkinDocument }) {
    const plan = currentRecordPlan();
    const planned =
      plan && plannedRecording(plan, pickle.uri, pickle.location?.line);
    if (!plan || !planned) return;
    this.recording = new SceneRecording(
      planned,
      plan.options,
      scenarioSteps(pickle, gherkinDocument),
      plan.dir,
    );
    await this.recording.prepare();
    const script = await options.recordInitScript?.(planned.sidecar);
    if (script) this.recording.addInitScript(script);
  });

  // Each touch says which step made it, so a reader can tell what the scenario did with an item.
  BeforeStep(function (this: ScenarioWorld, { pickle, pickleStep }) {
    this.step = pickle.steps.findIndex((s) => s.id === pickleStep.id);
    this.recording?.stepStarted(pickleStep.id);
  });

  AfterStep(async function (this: ScenarioWorld, { pickleStep, result }) {
    await this.recording?.stepFinished(pickleStep.id, result);
  });

  After(async function (this: ScenarioWorld, { result }) {
    this.step = undefined;
    await this.recording?.finish(result?.status);
    await this.closePage();
    this.attach(JSON.stringify(this.touches), touchesMediaType());
  });

  AfterAll(async () => {
    await closeSharedBrowser();
  });
}
