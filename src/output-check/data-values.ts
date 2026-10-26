/**
 * A YAML or JSON file a job may change is data a program reads, so with
 * output.data_keys a patch may change only the values of those keys:
 * every other value, every key, the file's shape (which maps hold which
 * keys, how long each list is) and its comments stay exactly as they were.
 */
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  visit,
  type Document,
} from "yaml";

/** A data file: with data_keys set, a patch to it may change only those keys' values. */
export const DATA_PATH = /\.(?:ya?ml|json)$/;

function parsed(lines: readonly string[]): Document[] | { error: string } {
  const all = parseAllDocuments(lines.join("\n"));
  const docs = Array.isArray(all) ? all : [];
  const err = docs.flatMap((d) => d.errors)[0];
  return err === undefined ? docs : { error: err.message.split("\n")[0]! };
}

/** Every comment of a document, in order. */
function comments(doc: Document): string[] {
  const out: string[] = [];
  const keep = (c: string | null | undefined) => {
    if (c) out.push(c);
  };
  keep(doc.commentBefore);
  visit(doc, (_, node) => {
    if (
      typeof node === "object" &&
      node !== null &&
      ("commentBefore" in node || "comment" in node)
    ) {
      const n = node as {
        commentBefore?: string | null;
        comment?: string | null;
      };
      keep(n.commentBefore);
      keep(n.comment);
    }
  });
  keep(doc.comment);
  return out;
}

const name = (path: readonly (string | number)[]) =>
  path.length === 0
    ? "the top level"
    : path
        .map((p, i) =>
          typeof p === "number" ? `[${p}]` : i === 0 ? p : `.${p}`,
        )
        .join("");

const keyText = (key: unknown): string =>
  isScalar(key) ? String(key.value) : String(key);

function compare(
  a: unknown,
  b: unknown,
  path: (string | number)[],
  key: string | undefined,
  keys: ReadonlySet<string>,
  out: string[],
): void {
  if (isMap(a)) {
    if (
      !isMap(b) ||
      a.items.length !== b.items.length ||
      a.items.some((p, i) => keyText(p.key) !== keyText(b.items[i]!.key))
    ) {
      out.push(
        `changes the keys of ${name(path)}; adding, removing, renaming or moving keys is for a person`,
      );
      return;
    }
    for (const [i, p] of a.items.entries()) {
      const k = keyText(p.key);
      compare(p.value, b.items[i]!.value, [...path, k], k, keys, out);
    }
    return;
  }
  if (isSeq(a)) {
    if (!isSeq(b) || a.items.length !== b.items.length) {
      out.push(
        `changes the length of ${name(path)}; adding or removing items is for a person`,
      );
      return;
    }
    for (const [i, item] of a.items.entries())
      compare(item, b.items[i], [...path, i], key, keys, out);
    return;
  }
  if (isScalar(a) && isScalar(b)) {
    if (JSON.stringify(a.value) === JSON.stringify(b.value)) return;
    if (key === undefined || !keys.has(key))
      out.push(
        `changes ${name(path)}, which only a person changes; a patch may change only the values of ${[...keys].join(", ")}`,
      );
    return;
  }
  if (isAlias(a) && isAlias(b) && a.source === b.source) return;
  if ((a ?? null) === null && (b ?? null) === null) return;
  out.push(`changes the shape of ${name(path)}; that is for a person`);
}

/** Why a patch to a data file changes more than the values of the allowed keys; empty when it does not. */
export function dataValueProblems(
  before: readonly string[],
  after: readonly string[],
  allowed: readonly string[],
): string[] {
  const a = parsed(before);
  if ("error" in a)
    return [
      `the file cannot be read as YAML or JSON (${a.error}); a person changes it`,
    ];
  const b = parsed(after);
  if ("error" in b)
    return [`the patched file cannot be read as YAML or JSON: ${b.error}`];
  if (a.length !== b.length)
    return ["changes how many documents the file holds; that is for a person"];
  const out: string[] = [];
  const keys = new Set(allowed);
  for (const [i, doc] of a.entries())
    compare(doc.contents, b[i]!.contents, [], undefined, keys, out);
  if (JSON.stringify(a.map(comments)) !== JSON.stringify(b.map(comments)))
    out.push("changes a comment, which only a person changes");
  return out;
}
