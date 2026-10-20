import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  commitLink,
  fileLink,
  pageUrl,
  plainText,
  previewSection,
} from "../src/deliver/pr-text.ts";

const JOINER = "⁠";

describe("model text in pull requests and replies", () => {
  it("renders an injection attempt as plain words", () => {
    const text = plainText(
      "Fixed. cc @notes-co/engineering @octocat see [the docs](https://evil.example/x) ![tracker](https://evil.example/p.png) <img src=x onerror=alert(1)> closes #12 and acme/repo#34 https://evil.example/y",
    );
    expect(text).not.toMatch(/@(?!⁠)/);
    expect(text).not.toContain("<img");
    expect(text).toContain("&lt;img");
    expect(text).not.toMatch(/(?<!\\)\[/);
    expect(text).not.toMatch(/(?<!\\)!\\?\[/);
    expect(text).not.toContain("https://evil.example");
    expect(text).toContain(`#${JOINER}12`);
    expect(text).toContain(`acme/repo#${JOINER}34`);
  });

  it("keeps links to the organization's own places", () => {
    expect(
      plainText(
        "See https://github.com/notes-co/engine/pull/614. Docs at https://docs.notes-co.example/docs/.",
      ),
    ).toBe(
      "See https://github.com/notes-co/engine/pull/614. Docs at https://docs.notes-co.example/docs/.",
    );
  });

  it("is one paragraph whose start does not turn into a heading, list or quote", () => {
    expect(plainText("# Title\n\n- one\n- two")).toBe("\\# Title - one - two");
    expect(plainText("- item")).toBe("\\- item");
    expect(plainText("1. first")).toBe("1\\. first");
    expect(plainText("> quoted")).toBe("&gt; quoted");
  });

  it("never holds a raw HTML tag, a newline or a mention, whatever the input", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const out = plainText(input);
        expect(out).not.toMatch(/[<\n\r]/);
        expect(out).not.toMatch(/@(?!⁠)/);
        expect(out).not.toMatch(/(?<!\\)[[\]`]/);
      }),
    );
  });
});

describe("links and previews in pull request bodies", () => {
  it("links files on the branch and commits by pull request or short sha", () => {
    expect(
      fileLink(
        "notes-co/public-docs",
        "agent/x/2026-10-06",
        "src/a b.mdx",
      ),
    ).toBe(
      "[`src/a b.mdx`](https://github.com/notes-co/public-docs/blob/agent/x/2026-10-06/src/a%20b.mdx)",
    );
    expect(
      commitLink("notes-co/engine", "a".repeat(40), "Fix it (#7)"),
    ).toBe("[engine#7](https://github.com/notes-co/engine/pull/7)");
    expect(commitLink("notes-co/engine", "a".repeat(40))).toBe(
      `[engine@aaaaaaa](https://github.com/notes-co/engine/commit/${"a".repeat(40)})`,
    );
  });

  const preview = {
    commands: ["pnpm install", "pnpm dev"],
    url: "http://localhost:4321",
    pages: { dir: "src/content/docs", prefix: "/docs/" },
  };

  it("maps docs pages to local addresses, an index page to its folder", () => {
    expect(pageUrl(preview, "src/content/docs/api/mcp.mdx")).toBe(
      "http://localhost:4321/docs/api/mcp/",
    );
    expect(pageUrl(preview, "src/content/docs/product/index.mdx")).toBe(
      "http://localhost:4321/docs/product/",
    );
    expect(pageUrl(preview, "src/content/docs/index.mdx")).toBe(
      "http://localhost:4321/docs/",
    );
    expect(pageUrl(preview, "src/data/videos.json")).toBeUndefined();
  });

  it("prints nothing without a preview, and the base address when no page maps", () => {
    expect(previewSection(undefined, ["x.mdx"], "agent/x/1")).toEqual([]);
    expect(
      previewSection(
        { commands: ["pnpm dev"], url: "http://localhost:4325" },
        ["src/content/docs/a.mdx"],
        "agent/x/1",
      ),
    ).toContain("Then open http://localhost:4325.");
  });
});
