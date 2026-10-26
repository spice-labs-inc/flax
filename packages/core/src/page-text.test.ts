import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPageText, pageTextScript, parsePageText } from "./page-text.js";

test("formatPageText writes headings and indented lines, and parsePageText reads them back", () => {
  const sections = [
    { heading: "", lines: ["Top"] },
    { heading: "Notes", lines: ["Weekly plan | today", "Groceries"] },
  ];
  const text = formatPageText(sections);
  assert.equal(text, "  Top\n## Notes\n  Weekly plan | today\n  Groceries\n");
  assert.deepEqual(parsePageText(text), sections);
  assert.equal(formatPageText([]), "");
});

test("pageTextScript names its root element, or the whole body", () => {
  assert.match(
    pageTextScript('main[id="x"]'),
    /const selector = "main\[id=\\"x\\"\]";/,
  );
  assert.match(pageTextScript(null), /const selector = null;/);
});
