import { setWorldConstructor } from "@cucumber/cucumber";
import { installBaseHooks } from "@flax/scenarios/support/hooks";
import { ScenarioWorld } from "@flax/scenarios/support/world";

setWorldConstructor(ScenarioWorld);
installBaseHooks({
  timeoutMs: 30_000,
  // A stand-in: the filmed page's heading reads "Notebook".
  recordInitScript: (sidecar) =>
    sidecar.standIns === "demo"
      ? `document.addEventListener("DOMContentLoaded", () => { const h = document.querySelector("h1"); if (h) h.textContent = "Notebook"; });`
      : undefined,
});
