import { Given, Then, When } from "@cucumber/cucumber";
import type { ScenarioWorld } from "@flax/scenarios/support/world";

// The test serves the page and names it here.
const pageUrl = () => process.env["NOTES_PAGE_URL"] ?? "";

Given("the notes page is open", async function (this: ScenarioWorld) {
  await (await this.page()).goto(pageUrl());
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
    const page = await this.page();
    await page.locator("#notes li").filter({ hasText: title }).waitFor();
    await this.media.capture("notes-page");
    await this.media.capture("notes-list", { target: page.locator("#notes") });
  },
);

Then(
  "the heading reads {string}",
  async function (this: ScenarioWorld, text: string) {
    const heading = (await this.page()).locator("h1");
    await this.media.capture("notes-heading", { target: heading, text: false });
    await this.media.capture("notes-unasked");
    const shown = await heading.textContent();
    if (shown !== text) throw new Error(`the heading reads ${shown}`);
  },
);

Then("the list is empty", async function (this: ScenarioWorld) {
  const items = (await this.page()).locator("#notes li");
  if ((await items.count()) !== 0) throw new Error("the list is not empty");
});
