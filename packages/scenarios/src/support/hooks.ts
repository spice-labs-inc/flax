import {
  After,
  AfterAll,
  AfterStep,
  Before,
  BeforeStep,
  setDefaultTimeout,
  setParallelCanAssign,
} from "@cucumber/cucumber";
import { SceneCapture, wantedCaptures } from "../capture/capture.ts";
import { config } from "../config.ts";
import { SceneRecording } from "../record/media.ts";
import { plannedRecording } from "../record/plan.ts";
import type { ResolvedSidecar } from "../record/sidecar.ts";
import { scenarioSteps } from "../record/steps.ts";
import { currentCaptureDir, currentRecordPlan } from "../run/env.ts";
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
  /**
   * In a capture run, a script for every document of a captured scenario's page, added before its
   * first load. It runs while the steps check the page, so it must leave what they read alone.
   * Given the scenario and its World.
   */
  captureInitScript?: (
    scenario: { name: string; uri: string; tags: string[] },
    world: ScenarioWorld,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * In a capture run, stand-in text for run-specific values: the source of a page function
   * `(text) => string` applied to the page's text just before each capture and undone right after
   * it, so the steps never read the stand-ins. Given the scenario and its World.
   */
  captureRewrite?: (
    scenario: { name: string; uri: string; tags: string[] },
    world: ScenarioWorld,
  ) => string | undefined | Promise<string | undefined>;
}

/**
 * The base hooks: step tracking, the touches attachment, the shared browser, in a record run the
 * recording of each planned scenario, and in a capture run the screenshots of each selected one. A workspace imports this module from its own support
 * file and adds its hooks (fixture teardown, env guards) beside it.
 */
export function installBaseHooks(options: BaseHookOptions = {}): void {
  setDefaultTimeout(options.timeoutMs ?? 5 * 60_000);
  setParallelCanAssign(canRunAlongside);

  Before(async function (this: ScenarioWorld, { pickle, gherkinDocument }) {
    const dir = currentCaptureDir();
    const tags = pickle.tags.map((t) => t.name);
    if (dir && wantedCaptures(tags, config().capture.tag)) {
      this.capturing = new SceneCapture({
        scenario: {
          name: pickle.name,
          uri: pickle.uri,
          line: pickle.location?.line ?? 0,
          tags,
        },
        settings: config().capture,
        dir,
        steps: scenarioSteps(pickle, gherkinDocument),
        attach: (body, mediaType) => this.attach(body, mediaType),
      });
      const scenario = { name: pickle.name, uri: pickle.uri, tags };
      const script = await options.captureInitScript?.(scenario, this);
      if (script) await this.capturing.addInitScript(script);
      const rewrite = await options.captureRewrite?.(scenario, this);
      if (rewrite) this.capturing.addRewrite(rewrite);
    }
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
    this.capturing?.stepStarted(pickleStep.id);
  });

  AfterStep(async function (this: ScenarioWorld, { pickleStep, result }) {
    this.capturing?.stepFinished();
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
