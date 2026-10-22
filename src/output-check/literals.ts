/**
 * A source file (TypeScript, JavaScript) a job may change is code the kit's
 * own workflows run, so a job's patch may change only its literal values:
 * the text of strings and the numbers. Everything else (names, keys,
 * punctuation, comments, template literals with ${...}) must stay exactly
 * as it was, so a patch can never add, remove or move code. Values that
 * point at files, hosts or the coding agent stay as people wrote them.
 */

/** A code file: a patch to it may change only literal values. */
export const CODE_PATH = /\.(?:[cm]?[jt]sx?)$/;

/** Keys whose values a patch never changes: ids, file paths, the voice, and the agent's workspace and instructions. */
export const FROZEN_KEYS = new Set([
  "id",
  "kind",
  "output",
  "workspaceFrom",
  "jarDir",
  "issueRepo",
  "elevenVoice",
  "baseUrl",
  "subject",
  "prompt",
  "guidance",
]);

/** Objects whose values a patch never changes, however deep. */
export const FROZEN_PARENTS = new Set(["agent", "fixture", "vars"]);

/** Keys whose value is a dashboard path: it must stay a path on the dashboard. */
export const PATH_KEYS = new Set(["url"]);

interface Token {
  kind: "string" | "number" | "code";
  text: string;
  /** The key of the property the literal is the value of, or of the array it is in. */
  key?: string;
  /** The keys of the objects around the literal. */
  parents: readonly string[];
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y;

/** Where the template literal starting at i ends (after its closing backtick), and whether it holds ${...}. */
function templateEnd(src: string, i: number): { end: number; code: boolean } {
  let j = i + 1;
  let code = false;
  while (j < src.length) {
    const ch = src[j]!;
    if (ch === "\\") j += 2;
    else if (ch === "`") return { end: j + 1, code };
    else if (ch === "$" && src[j + 1] === "{") {
      code = true;
      j = codeEnd(src, j + 2);
    } else j += 1;
  }
  throw new Error("a template literal is not closed");
}

/** Where the ${...} expression whose body starts at i ends (after its closing brace). */
function codeEnd(src: string, i: number): number {
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const ch = src[j]!;
    if (ch === "`") j = templateEnd(src, j).end;
    else if (ch === '"' || ch === "'") j = quotedEnd(src, j);
    else if (ch === "{") {
      depth += 1;
      j += 1;
    } else if (ch === "}") {
      depth -= 1;
      j += 1;
      if (depth === 0) return j;
    } else j += 1;
  }
  throw new Error("a ${...} expression is not closed");
}

/** Where the quoted string starting at i ends (after its closing quote). */
function quotedEnd(src: string, i: number): number {
  const quote = src[i]!;
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j]!;
    if (ch === "\\") j += 2;
    else if (ch === quote) return j + 1;
    else if (ch === "\n") break;
    else j += 1;
  }
  throw new Error("a quoted string is not closed on its line");
}

/** The file's tokens: literals with the key they belong to, and everything else as code. Throws on text it cannot read. */
export function tokens(src: string): Token[] {
  const out: Token[] = [];
  // One entry per open bracket: the key it is the value of, if any.
  const stack: { bracket: string; key?: string }[] = [];
  let pendingKey: string | undefined;
  let i = 0;
  const parents = () =>
    stack.flatMap((s) =>
      s.bracket === "{" && s.key !== undefined ? [s.key] : [],
    );
  const literalKey = () => {
    if (pendingKey !== undefined) return pendingKey;
    const top = stack.at(-1);
    return top?.bracket === "[" ? top.key : undefined;
  };
  const code = (text: string) => {
    out.push({ kind: "code", text, parents: parents() });
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (src.startsWith("//", i)) {
      const end = src.indexOf("\n", i);
      code(src.slice(i, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new Error("a comment is not closed");
      code(src.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let end: number;
      let isCode = false;
      if (ch === "`") ({ end, code: isCode } = templateEnd(src, i));
      else end = quotedEnd(src, i);
      const text = src.slice(i, end);
      if (isCode) code(text);
      else {
        const key = literalKey();
        out.push({
          kind: "string",
          text,
          ...(key === undefined ? {} : { key }),
          parents: parents(),
        });
      }
      pendingKey = undefined;
      i = end;
      continue;
    }
    IDENT.lastIndex = i;
    const ident = IDENT.exec(src);
    if (ident !== null) {
      code(ident[0]);
      i += ident[0].length;
      let j = i;
      while (j < src.length && /[ \t]/.test(src[j]!)) j += 1;
      pendingKey = src[j] === ":" ? ident[0] : undefined;
      continue;
    }
    NUMBER.lastIndex = i;
    const num = NUMBER.exec(src);
    if (num !== null) {
      const key = literalKey();
      out.push({
        kind: "number",
        text: num[0],
        ...(key === undefined ? {} : { key }),
        parents: parents(),
      });
      pendingKey = undefined;
      i += num[0].length;
      continue;
    }
    code(ch);
    if (ch === "{" || ch === "[") {
      stack.push({
        bracket: ch,
        ...(pendingKey === undefined ? {} : { key: pendingKey }),
      });
      pendingKey = undefined;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      pendingKey = undefined;
    } else if (ch !== ":") pendingKey = undefined;
    i += 1;
  }
  return out;
}

/** The value of a string literal token as written between its quotes. */
function inner(text: string): string {
  return text.slice(1, -1);
}

/**
 * Why a patch to a code file changes more than literal values, or a value
 * it may not change; empty when it changes only text and numbers it may.
 */
export function literalOnlyProblems(
  before: readonly string[],
  after: readonly string[],
): string[] {
  let a: Token[];
  let b: Token[];
  try {
    a = tokens(before.join("\n"));
  } catch (err) {
    return [
      `the file cannot be read as data (${(err as Error).message}); a person changes it`,
    ];
  }
  try {
    b = tokens(after.join("\n"));
  } catch (err) {
    return [`the patched file cannot be read: ${(err as Error).message}`];
  }
  if (
    a.length !== b.length ||
    a.some(
      (t, i) =>
        t.kind !== b[i]!.kind || (t.kind === "code" && t.text !== b[i]!.text),
    )
  )
    return [
      "changes code, not only the text of strings and numbers; adding, removing or moving steps, scenes or keys is for a person",
    ];
  const out: string[] = [];
  for (const [i, t] of a.entries()) {
    const n = b[i]!;
    if (t.text === n.text) continue;
    const where = t.key === undefined ? "a value outside any key" : `${t.key}`;
    if (t.key === undefined)
      out.push(`changes ${where}: ${t.text}; only keyed values may change`);
    else if (FROZEN_KEYS.has(t.key))
      out.push(`changes ${t.key}, which only a person changes`);
    else if (t.parents.some((p) => FROZEN_PARENTS.has(p)))
      out.push(
        `changes ${t.key} inside ${t.parents.find((p) => FROZEN_PARENTS.has(p))}, which only a person changes`,
      );
    else if (PATH_KEYS.has(t.key) && n.kind === "string") {
      const value = inner(n.text);
      if (
        !value.startsWith("/") ||
        value.startsWith("//") ||
        value.includes("://")
      )
        out.push(
          `sets ${t.key} to ${n.text}; it must stay a dashboard path starting with /`,
        );
    }
  }
  return out;
}
