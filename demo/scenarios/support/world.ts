import { setWorldConstructor } from "@cucumber/cucumber";
import { installBaseHooks } from "@flax/scenarios/support/hooks";
import { ScenarioWorld } from "@flax/scenarios/support/world";

/** The demo's World: the kit's base, with a stub token. No browser, no network. */
export class NotesWorld extends ScenarioWorld {
  token: string | undefined;
}

setWorldConstructor(NotesWorld);
installBaseHooks({ timeoutMs: 10_000 });
