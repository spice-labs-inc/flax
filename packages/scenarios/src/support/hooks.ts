import {
  After,
  AfterAll,
  BeforeStep,
  setDefaultTimeout,
  setParallelCanAssign,
} from "@cucumber/cucumber";
import { touchesMediaType } from "../run/results.ts";
import { canRunAlongside } from "../run/tags.ts";
import { closeSharedBrowser, type ScenarioWorld } from "./world.ts";

/**
 * The base hooks: step tracking, the touches attachment, the shared browser. A workspace imports this
 * module from its own support file and adds its hooks (fixture teardown, env guards) beside it.
 */
export function installBaseHooks(options: { timeoutMs?: number } = {}): void {
  setDefaultTimeout(options.timeoutMs ?? 5 * 60_000);
  setParallelCanAssign(canRunAlongside);

  // Each touch says which step made it, so a reader can tell what the scenario did with an item.
  BeforeStep(function (this: ScenarioWorld, { pickle, pickleStep }) {
    this.step = pickle.steps.findIndex((s) => s.id === pickleStep.id);
  });

  After(async function (this: ScenarioWorld) {
    this.step = undefined;
    await this.closePage();
    this.attach(JSON.stringify(this.touches), touchesMediaType());
  });

  AfterAll(async () => {
    await closeSharedBrowser();
  });
}
