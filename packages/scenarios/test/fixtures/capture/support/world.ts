import { setWorldConstructor } from "@cucumber/cucumber";
import { installBaseHooks } from "@flax/scenarios/support/hooks";
import { ScenarioWorld } from "@flax/scenarios/support/world";

setWorldConstructor(ScenarioWorld);
installBaseHooks({
  timeoutMs: 30_000,
  // A footer the steps never read, and a stand-in: in a screenshot the heading reads "Notebook".
  captureInitScript: () =>
    `document.addEventListener("DOMContentLoaded", () => { const f = document.createElement("footer"); f.textContent = "Example footer"; document.body.appendChild(f); });`,
  captureRewrite: () => `(text) => (text === "Notes" ? "Notebook" : text)`,
});
