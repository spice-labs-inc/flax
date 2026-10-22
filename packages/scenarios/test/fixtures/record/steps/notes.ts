import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Given, Then, When } from "@cucumber/cucumber";
import type { ScenarioWorld } from "@flax/scenarios/support/world";

const exec = promisify(execFile);

// The test serves the page and names it here.
const pageUrl = () => process.env["NOTES_PAGE_URL"] ?? "";

Given("the notes page is open", async function (this: ScenarioWorld) {
  await (await this.page()).goto(pageUrl());
});

Given("the list starts empty", async function (this: ScenarioWorld) {
  const items = (await this.page()).locator("#notes li");
  if ((await items.count()) !== 0) throw new Error("the list is not empty");
});

When(
  "I type {string} as the title",
  async function (this: ScenarioWorld, title: string) {
    await this.media.type((await this.page()).locator("#title"), title);
  },
);

When("I save the note", async function (this: ScenarioWorld) {
  await this.media.click((await this.page()).locator("#save"));
});

Then(
  "the list shows {string}",
  async function (this: ScenarioWorld, title: string) {
    const item = (await this.page())
      .locator("#notes li")
      .filter({ hasText: title });
    await item.waitFor({ timeout: 2000 });
    await this.media.highlight(item);
  },
);

Then("the list is empty", async function (this: ScenarioWorld) {
  const items = (await this.page()).locator("#notes li");
  if ((await items.count()) !== 0) throw new Error("the list is not empty");
});

let output = "";

When(
  "I list the notes from the terminal",
  async function (this: ScenarioWorld) {
    const command = "notes list";
    const started = performance.now();
    const r = await exec(process.execPath, [
      "-e",
      "console.log('Weekly plan')",
    ]);
    output = r.stdout.trimEnd();
    this.media.terminal({
      command,
      output: [{ afterMs: 5, text: r.stdout }],
      cwd: "/work",
      exitCode: 0,
      durationMs: performance.now() - started,
    });
  },
);

Then(
  "the terminal shows {string}",
  function (this: ScenarioWorld, text: string) {
    if (!output.includes(text)) throw new Error(`the terminal shows ${output}`);
  },
);

Then(
  "the heading reads {string}",
  async function (this: ScenarioWorld, text: string) {
    const heading = (await this.page()).locator("h1");
    const shown = await heading.textContent();
    if (shown !== text) throw new Error(`the heading reads ${shown}`);
    await this.media?.highlight(heading);
  },
);
