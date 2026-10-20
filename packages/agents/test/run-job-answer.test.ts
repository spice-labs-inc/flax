import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { answerProblems, parseAnswer } from "../src/run-job/answer.ts";
import { readUntrusted } from "../src/run-job/untrusted.ts";
import { OUTPUT_SCHEMA } from "./helpers.ts";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-answer-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("answer", () => {
  it("parses plain JSON and JSON in one code fence", () => {
    expect(parseAnswer('{"summary":"hi"}\n')).toEqual({
      value: { summary: "hi" },
    });
    expect(parseAnswer('```json\n{"summary":"hi"}\n```\n')).toEqual({
      value: { summary: "hi" },
    });
    expect(parseAnswer('```\n{"summary":"hi"}\n```')).toEqual({
      value: { summary: "hi" },
    });
  });

  it("takes the one json block out of prose around it, and refuses two", () => {
    expect(
      parseAnswer('Both patches verified.\n\n```json\n{"summary":"hi"}\n```\n'),
    ).toEqual({ value: { summary: "hi" } });
    const two = parseAnswer(
      'First:\n```json\n{"summary":"a"}\n```\nThen:\n```json\n{"summary":"b"}\n```\n',
    );
    expect("error" in two).toBe(true);
  });

  it("takes JSON that starts on its own line after prose and runs to the end", () => {
    expect(
      parseAnswer('All three patches apply cleanly.\n\n{"summary":"hi"}\n'),
    ).toEqual({ value: { summary: "hi" } });
    expect(
      parseAnswer(
        'Result:\n[see below]\n{\n  "pages": [\n    {"a": 1}\n  ]\n}',
      ),
    ).toEqual({ value: { pages: [{ a: 1 }] } });
  });

  it("takes a complete answer followed by a broken leftover fragment, with a warning", () => {
    // The shape of run 37852040092: one line of complete JSON, then the
    // pretty-printed tail of an earlier draft of the same answer.
    const answer = {
      pages: [
        {
          repo: "notes-co/atlas",
          path: "repos/widget.md",
          evidence: [{ repo: "notes-co/widget", commit: "1ad6577" }],
        },
      ],
      maintainer_notes: [{ kind: "limit_hit", text: "103 diffs left out" }],
    };
    const fragment = [
      "  },",
      "            {",
      '              "repo": "notes-co/widget",',
      '              "commit": "af67aec"',
      "            }",
      "          ]",
      "    },",
      "    {",
      '      "kind": "limit_hit",',
      '      "text": "103 diffs left out"',
      "    }",
      "  ]",
      "}",
    ].join("\n");
    expect(parseAnswer(`${JSON.stringify(answer)}\n${fragment}\n`)).toEqual({
      value: answer,
      warning: `text after the answer was ignored: ${fragment.trim().length} characters, starting "},\\n            {\\n              \\"repo\\": \\""`,
    });
    // The shape of run 37866245523: the leftover is the compact tail of the same object.
    const tail = 'notes-co/widget/README.md"}],"why":"x"}]},{"repo":"a","path":"b"}]}';
    expect(parseAnswer(`{"summary":"hi"}\n${tail}`)).toEqual({
      value: { summary: "hi" },
      warning: `text after the answer was ignored: ${tail.length} characters, starting ${JSON.stringify(tail.slice(0, 40))}`,
    });
    expect(parseAnswer('{"summary":"hi"}\nThat is all.')).toEqual({
      value: { summary: "hi" },
      warning:
        'text after the answer was ignored: 12 characters, starting "That is all."',
    });
  });

  it("refuses a complete answer followed by a second complete one", () => {
    for (const text of [
      '{"summary":"a"}\n{"summary":"b"}',
      '{"summary":"a"}{"summary":"b"}',
      '{"summary":"a"} ["b"]',
      '{\n  "summary": "a"\n}\n{\n  "summary": "b"\n}',
      '{"summary":"a"}\nOr, shorter:\n```json\n{"summary":"b"}\n```',
      '{"summary":"a"}\nAnd then:\n{"summary":"b"}\nThat is all.',
    ])
      expect(parseAnswer(text)).toEqual({
        error:
          "the answer is two JSON values, one after the other: which one is the answer would be a guess",
      });
  });

  it("fails on an empty answer or prose around the JSON", () => {
    expect(parseAnswer("  \n")).toEqual({ error: "the answer is empty" });
    for (const text of [
      'Here you go: {"summary":"hi"}',
      'Here you go:\n{"summary":"hi"}\nThat is all.',
      'First:\n{"summary":"a"}\n{"summary":"b"}',
      'First:\n{"summary":"a"}\n  },\n  {"left": "over"}',
    ]) {
      const prose = parseAnswer(text);
      expect(
        "error" in prose && prose.error.startsWith("the answer is not JSON: "),
      ).toBe(true);
    }
  });

  it("is checked against output.json with one line per problem", () => {
    expect(answerProblems({ summary: "hi" }, OUTPUT_SCHEMA)).toEqual([]);
    expect(answerProblems({ summary: 3, extra: true }, OUTPUT_SCHEMA)).toEqual([
      "extra: is not an allowed key",
      "summary: must be string",
    ]);
    expect(answerProblems([], OUTPUT_SCHEMA)).toEqual(["must be object"]);
  });
});

describe("reading files the box wrote", () => {
  it("reads a regular file", () => {
    const dir = scratch();
    writeFileSync(join(dir, "a"), "text");
    expect(readUntrusted(join(dir, "a"), 10)).toEqual({ text: "text" });
  });

  it("never follows a link, reads a directory or a file over the cap", () => {
    const dir = scratch();
    writeFileSync(join(dir, "secret"), "host file");
    symlinkSync(join(dir, "secret"), join(dir, "link"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "big"), "x".repeat(11));
    expect(readUntrusted(join(dir, "link"), 100)).toEqual({
      error: "is a symbolic link",
    });
    expect(readUntrusted(join(dir, "sub"), 100)).toEqual({
      error: "is not a regular file",
    });
    expect(readUntrusted(join(dir, "big"), 10)).toEqual({
      error: "is 11 bytes, over the 10 byte limit",
    });
    expect(readUntrusted(join(dir, "gone"), 10)).toEqual({
      error: "does not exist",
    });
  });

  it("refuses a file with a second name when asked to", () => {
    const dir = scratch();
    writeFileSync(join(dir, "a"), "text");
    linkSync(join(dir, "a"), join(dir, "b"));
    expect(readUntrusted(join(dir, "b"), 10)).toEqual({ text: "text" });
    expect(readUntrusted(join(dir, "b"), 10, { singleLink: true })).toEqual({
      error: "has 2 hard links; only one is allowed",
    });
  });
});
