/**
 * The string literals of a source file in Rust, Java, Scala or TypeScript
 * (and JavaScript and Svelte), and whether a log line is one of them with
 * its variable parts filled in. A log line quoted in a pull request body
 * or a posted analysis may appear only as such a template, its variable
 * parts masked: a literal in our own code cannot carry customer data,
 * while the line as logged can.
 */

export type SourceLanguage = "rust" | "java" | "scala" | "typescript";

/** The language of a source file by its extension; undefined for anything else. */
export function languageOf(path: string): SourceLanguage | undefined {
  if (/\.rs$/.test(path)) return "rust";
  if (/\.java$/.test(path)) return "java";
  if (/\.(scala|sc)$/.test(path)) return "scala";
  if (/\.([cm]?[jt]sx?|svelte)$/.test(path)) return "typescript";
  return undefined;
}

/** One string literal: its text as the program sees it (escapes resolved), where it starts, and the parts a program fills in. */
export interface StringLiteral {
  /** The literal's value with each placeholder kept as written, such as {} or ${name}. */
  text: string;
  /** The line the literal starts on, from 1. */
  line: number;
  /** The literal's pieces: fixed text and the placeholders between them. */
  parts: LiteralPart[];
}

export type LiteralPart = { fixed: string } | { hole: string };

/** What masks a variable part of a log line in a template. */
export const MASK = "<value>";

class Reader {
  i = 0;
  line = 1;
  readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  get done(): boolean {
    return this.i >= this.src.length;
  }

  at(offset = 0): string {
    return this.src[this.i + offset] ?? "";
  }

  startsWith(text: string): boolean {
    return this.src.startsWith(text, this.i);
  }

  advance(n = 1): void {
    for (let k = 0; k < n && this.i < this.src.length; k++) {
      if (this.src[this.i] === "\n") this.line += 1;
      this.i += 1;
    }
  }
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  "\\": "\\",
  '"': '"',
  "'": "'",
  "`": "`",
  $: "$",
  b: "\b",
  f: "\f",
  s: " ",
};

/** Reads an escape after a backslash (the reader stands on the character after it) and returns its value. */
function readEscape(r: Reader, language: SourceLanguage): string {
  const c = r.at();
  if (c === "\n") {
    // Rust and JavaScript continue the string on the next line; Rust also skips the next line's leading whitespace.
    r.advance();
    if (language === "rust") while (!r.done && /\s/.test(r.at())) r.advance();
    return "";
  }
  if (c === "u") {
    r.advance();
    if (r.at() === "{") {
      let hex = "";
      r.advance();
      while (!r.done && r.at() !== "}") {
        hex += r.at();
        r.advance();
      }
      r.advance();
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    while (r.at() === "u") r.advance();
    const hex = r.src.slice(r.i, r.i + 4);
    r.advance(4);
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : "";
  }
  if (c === "x") {
    const hex = r.src.slice(r.i + 1, r.i + 3);
    r.advance(3);
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : "";
  }
  r.advance();
  return ESCAPES[c] ?? c;
}

/** A plain quoted string from the opening quote; multiline says whether a newline may be inside it. */
function readQuoted(
  r: Reader,
  quote: string,
  language: SourceLanguage,
  options: { escapes: boolean; multiline: boolean },
): string | undefined {
  r.advance(quote.length);
  let out = "";
  while (!r.done) {
    if (r.startsWith(quote)) {
      r.advance(quote.length);
      return out;
    }
    const c = r.at();
    if (c === "\n" && !options.multiline) return undefined;
    if (c === "\\" && options.escapes) {
      r.advance();
      out += readEscape(r, language);
      continue;
    }
    out += c;
    r.advance();
  }
  return undefined;
}

/** Skips a comment at the reader, nested block comments included where the language nests them; returns whether there was one. */
function skipComment(r: Reader, nested: boolean): boolean {
  if (r.startsWith("//")) {
    while (!r.done && r.at() !== "\n") r.advance();
    return true;
  }
  if (r.startsWith("/*")) {
    let depth = 1;
    r.advance(2);
    while (!r.done && depth > 0) {
      if (nested && r.startsWith("/*")) {
        depth += 1;
        r.advance(2);
      } else if (r.startsWith("*/")) {
        depth -= 1;
        r.advance(2);
      } else r.advance();
    }
    return true;
  }
  return false;
}

/** The parts of a value whose placeholders follow the language's formatting conventions. */
export function partsOf(text: string, language: SourceLanguage): LiteralPart[] {
  const parts: LiteralPart[] = [];
  let fixed = "";
  const flush = () => {
    if (fixed !== "") parts.push({ fixed });
    fixed = "";
  };
  const hole = (h: string) => {
    flush();
    parts.push({ hole: h });
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const rest = text.slice(i);
    // Rust format!, Java SLF4J {} and MessageFormat {0}: braces, with {{ and }} as literal braces in Rust.
    if (c === "{" && text[i + 1] === "{" && language === "rust") {
      fixed += "{";
      i += 2;
      continue;
    }
    if (c === "}" && text[i + 1] === "}" && language === "rust") {
      fixed += "}";
      i += 2;
      continue;
    }
    const brace = /^\{[A-Za-z0-9_.:?#<>^+\- ]*\}/.exec(rest);
    if (brace !== null && language !== "typescript") {
      hole(brace[0]);
      i += brace[0].length;
      continue;
    }
    // printf conventions: String.format, f"..." interpolation, console.log("%s").
    const percent =
      language === "rust"
        ? null
        : /^%(?:\d+\$)?[-#+ 0,(]*\d*(?:\.\d+)?[sdifxXoOjecgb%n]/.exec(rest);
    if (percent !== null && percent[0] !== "%%") {
      if (percent[0] === "%n") {
        fixed += "\n";
        i += 2;
        continue;
      }
      hole(percent[0]);
      i += percent[0].length;
      continue;
    }
    if (percent?.[0] === "%%") {
      fixed += "%";
      i += 2;
      continue;
    }
    // Template literals and Scala interpolation keep ${...} and, in Scala, $name.
    if (c === "$" && text[i + 1] === "{") {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "{") depth += 1;
        else if (text[j] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      hole(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (language === "scala" && c === "$") {
      const name = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      if (name !== null) {
        hole(name[0]);
        i += name[0].length;
        continue;
      }
      if (text[i + 1] === "$") {
        fixed += "$";
        i += 2;
        continue;
      }
    }
    fixed += c;
    i += 1;
  }
  flush();
  return parts;
}

/** Template literal text from the backtick, with each ${...} kept as written; the reader ends after the closing backtick. */
function readTemplate(r: Reader): string | undefined {
  r.advance();
  let out = "";
  while (!r.done) {
    const c = r.at();
    if (c === "`") {
      r.advance();
      return out;
    }
    if (c === "\\") {
      r.advance();
      out += readEscape(r, "typescript");
      continue;
    }
    if (c === "$" && r.at(1) === "{") {
      let depth = 0;
      let expr = "";
      while (!r.done) {
        const d = r.at();
        if (d === "{") depth += 1;
        if (d === "}") depth -= 1;
        expr += d;
        r.advance();
        if (depth === 0) break;
      }
      out += expr;
      continue;
    }
    out += c;
    r.advance();
  }
  return undefined;
}

/** The token before position i that is not whitespace, for telling a regular expression from a division. */
function previousSignificant(src: string, i: number): string {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j]!)) j -= 1;
  return j < 0 ? "" : src[j]!;
}

function skipRegex(r: Reader): void {
  r.advance();
  let inClass = false;
  while (!r.done && r.at() !== "\n") {
    const c = r.at();
    if (c === "\\") {
      r.advance(2);
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      r.advance();
      while (/[a-z]/i.test(r.at())) r.advance();
      return;
    }
    r.advance();
  }
}

/** The script blocks of a Svelte file, with every other line blanked so line numbers stay. */
function svelteScripts(src: string): string {
  const out = src.replace(/[^\n]/g, " ").split("");
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const start = m.index + m[0].indexOf(">") + 1;
    for (let k = 0; k < m[1]!.length; k++) out[start + k] = m[1]![k]!;
  }
  return out.join("");
}

/**
 * Every string literal of a source file, in order. Comments, character
 * literals, Rust lifetimes, Scala symbols and JavaScript regular
 * expressions are skipped, so a quote inside them never starts a string.
 * A string that is not closed where it must be is skipped.
 */
export function stringLiterals(
  source: string,
  language: SourceLanguage,
  path = "",
): StringLiteral[] {
  const src = path.endsWith(".svelte") ? svelteScripts(source) : source;
  const r = new Reader(src);
  const out: StringLiteral[] = [];
  const push = (text: string | undefined, line: number, raw = false) => {
    if (text === undefined) return false;
    out.push({
      text,
      line,
      parts:
        raw && language === "rust"
          ? [{ fixed: text }]
          : partsOf(text, language),
    });
    return true;
  };
  while (!r.done) {
    if (skipComment(r, language === "rust" || language === "scala")) continue;
    const c = r.at();
    const line = r.line;
    if (language === "rust") {
      // Raw strings: r"..." and r#"..."#, also as byte strings br"...".
      const raw = /^b?r(#*)"/.exec(r.src.slice(r.i, r.i + 260));
      const prev = r.src[r.i - 1] ?? "";
      if (raw !== null && !/[A-Za-z0-9_]/.test(prev)) {
        const close = `"${raw[1]!}`;
        r.advance(raw[0].length);
        const end = r.src.indexOf(close, r.i);
        if (end < 0) continue;
        const text = r.src.slice(r.i, end);
        r.advance(end - r.i + close.length);
        // A format string written raw still has its placeholders.
        out.push({ text, line, parts: partsOf(text, "rust") });
        continue;
      }
      if (
        (c === "b" || c === "c") &&
        r.at(1) === '"' &&
        !/[A-Za-z0-9_]/.test(prev)
      ) {
        r.advance();
        if (
          !push(
            readQuoted(r, '"', language, { escapes: true, multiline: true }),
            line,
          )
        )
          continue;
        continue;
      }
      if (c === "'") {
        // A character literal ('a', '\n', '\u{1F600}'), or a lifetime ('a, 'static).
        const ch =
          /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/u.exec(
            r.src.slice(r.i, r.i + 16),
          );
        r.advance(ch === null ? 1 : ch[0].length);
        continue;
      }
      if (c === '"') {
        if (
          !push(
            readQuoted(r, '"', language, { escapes: true, multiline: true }),
            line,
          )
        )
          continue;
        continue;
      }
    } else if (language === "java" || language === "scala") {
      if (r.startsWith('"""')) {
        // Java text blocks process escapes; Scala triple quotes are raw.
        if (
          !push(
            readQuoted(r, '"""', language, {
              escapes: language === "java",
              multiline: true,
            }),
            line,
          )
        )
          continue;
        continue;
      }
      if (language === "scala" && /[A-Za-z]/.test(c)) {
        // An interpolator: s"...", f"...", raw"...", or any name right before a quote.
        const m = /^[A-Za-z][A-Za-z0-9_]*(?="""|")/.exec(
          r.src.slice(r.i, r.i + 40),
        );
        const prev = r.src[r.i - 1] ?? "";
        if (m !== null && !/[A-Za-z0-9_.]/.test(prev)) {
          r.advance(m[0].length);
          const triple = r.startsWith('"""');
          if (
            !push(
              readQuoted(r, triple ? '"""' : '"', language, {
                escapes: !triple && m[0] !== "raw",
                multiline: triple,
              }),
              line,
            )
          )
            continue;
          continue;
        }
        const word = /^[A-Za-z0-9_]+/.exec(r.src.slice(r.i, r.i + 200));
        r.advance(word?.[0].length ?? 1);
        continue;
      }
      if (c === '"') {
        if (
          !push(
            readQuoted(r, '"', language, { escapes: true, multiline: false }),
            line,
          )
        )
          continue;
        continue;
      }
      if (c === "'") {
        const ch = /^'(?:\\(?:u[0-9a-fA-F]{4}|.)|[^\\'\n])'/.exec(
          r.src.slice(r.i, r.i + 10),
        );
        r.advance(ch === null ? 1 : ch[0].length);
        continue;
      }
    } else {
      if (c === "`") {
        if (!push(readTemplate(r), line)) continue;
        continue;
      }
      if (c === '"' || c === "'") {
        if (
          !push(
            readQuoted(r, c, language, { escapes: true, multiline: false }),
            line,
          )
        )
          continue;
        continue;
      }
      if (c === "/" && r.at(1) !== "/" && r.at(1) !== "*") {
        const prev = previousSignificant(r.src, r.i);
        if (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev)) {
          skipRegex(r);
          continue;
        }
      }
    }
    r.advance();
  }
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fixed text that proves a log line is the literal: at least this many letters besides spaces. */
export const MIN_FIXED_CHARS = 8;

/** A literal's template as a body may show it: fixed text as written, each placeholder masked. */
export function templateOf(literal: Pick<StringLiteral, "parts">): string {
  return literal.parts
    .map((p) => ("fixed" in p ? p.fixed : MASK))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a log line is this literal with its placeholders filled in, and
 * then the line with its variable parts masked. The literal's fixed text
 * must appear in the line in order, with only placeholders between its
 * pieces; the line may carry text before and after the literal (a logger's
 * prefix, the rest of a concatenation), which is masked too. A literal
 * with less than MIN_FIXED_CHARS of fixed letters proves nothing.
 */
export function matchLiteral(
  logLine: string,
  literal: Pick<StringLiteral, "parts">,
): { template: string } | undefined {
  const fixed = literal.parts
    .flatMap((p) => ("fixed" in p ? [p.fixed] : []))
    .join("")
    .replace(/[^A-Za-z]/g, "");
  if (fixed.length < MIN_FIXED_CHARS) return undefined;
  const line = logLine.replace(/\s+/g, " ").trim();
  const last = literal.parts.length - 1;
  const pattern = literal.parts
    .map((p, i) =>
      "fixed" in p
        ? escapeRegex(p.fixed.replace(/\s+/g, " ")).replace(/ /g, "\\s*")
        : i === last
          ? "(.*)"
          : "(.*?)",
    )
    .join("");
  if (pattern === "") return undefined;
  const m = new RegExp(pattern, "s").exec(line);
  if (m === null) return undefined;
  const before = m.index > 0 ? `${MASK} ` : "";
  const after = m.index + m[0].length < line.length ? ` ${MASK}` : "";
  return { template: `${before}${templateOf(literal)}${after}`.trim() };
}

/** A log line as a template of one of the given literals, or undefined when none matches; the literal with the most fixed text wins. */
export function templateFor(
  logLine: string,
  literals: readonly Pick<StringLiteral, "parts">[],
): string | undefined {
  let best: { template: string; fixed: number } | undefined;
  for (const literal of literals) {
    const m = matchLiteral(logLine, literal);
    if (m === undefined) continue;
    const fixed = literal.parts.reduce(
      (n, p) => n + ("fixed" in p ? p.fixed.length : 0),
      0,
    );
    if (best === undefined || fixed > best.fixed)
      best = { template: m.template, fixed };
  }
  return best?.template;
}
