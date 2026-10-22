import { describe, expect, it } from "vitest";
import { excludedOn } from "$lib/data.ts";
import {
  glossaryRuns,
  glossarySections,
  PROJECT_SECTION,
} from "$lib/glossary.ts";

describe("the project's glossary entries", () => {
  const entries = [
    { term: "Notebook", text: "A collection of notes.", section: "Product" },
    { term: "Pin", text: "A note kept on top." },
    { term: "Owner", text: "Who made the notebook.", section: "People" },
    { term: "Nowhere", text: "No such heading.", section: "Marks and more" },
  ];

  it("join the built-in section they name and otherwise land under This project, in order", () => {
    expect(glossarySections(entries, ["Product", "People", "Marks"])).toEqual({
      Product: [entries[0]],
      People: [entries[2]],
      Marks: [],
      [PROJECT_SECTION]: [entries[1], entries[3]],
    });
    expect(glossarySections([], ["Product"])).toEqual({
      Product: [],
      [PROJECT_SECTION]: [],
    });
  });

  it("carry links written [label](url) and plain text otherwise", () => {
    expect(glossaryRuns("Plain words.")).toEqual([{ text: "Plain words." }]);
    expect(
      glossaryRuns(
        "See the [notes guide](https://docs.example/notes) and [map](/map).",
      ),
    ).toEqual([
      { text: "See the " },
      { text: "notes guide", href: "https://docs.example/notes" },
      { text: " and " },
      { text: "map", href: "/map" },
      { text: "." },
    ]);
    expect(glossaryRuns("")).toEqual([]);
  });
});

describe("a tag the env allows past its excludeTags", () => {
  it("leaves the scenario with no reason to be left out of that env", () => {
    expect(excludedOn(["@admin"], "prod")).toBe("@admin");
    expect(excludedOn(["@admin", "@admin:prod"], "prod")).toBeUndefined();
    expect(excludedOn(["@admin:prod"], "staging")).toBeUndefined();
  });
});
