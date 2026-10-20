import { isPlainRelativePath, matchesAnyGlob } from "../output-check/glob.ts";
import { frontmatter, type PrPolicy } from "../output-check/pr.ts";

/**
 * A frontmatter value the job's own code (collect.ts) computed for one
 * page, such as the commit a doc now describes. The model never writes
 * one; delivery sets it after every check has passed.
 */
export interface Stamp {
  repo: string;
  path: string;
  /** The commit the page is read at; the pull request is built on it. */
  commit: string;
  key: string;
  value: string;
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
/** Words of letters, digits and . _ / + -, one space apart: a plain YAML scalar that cannot start a comment, a mapping or a new line. */
const VALUE = /^[A-Za-z0-9._/+-]+( [A-Za-z0-9._/+-]+)*$/;
const MAX_VALUE = 200;
const MAX_STAMPS = 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stamps in a run's input (its optional `stamps` list), each held to
 * the job's pr output: a repository and path the job may change, a key in
 * its `stamp_keys`, a plain one-line value, one stamp per page and key.
 */
export function inputStamps(
  input: unknown,
  policy: PrPolicy,
): { stamps: Stamp[] } | { error: string } {
  const list = isObject(input) ? input.stamps : undefined;
  if (list === undefined) return { stamps: [] };
  if (!Array.isArray(list))
    return { error: "the input's stamps is not a list" };
  if (list.length > MAX_STAMPS)
    return { error: `the input has more than ${MAX_STAMPS} stamps` };
  const allowed = policy.stampKeys ?? [];
  const stamps: Stamp[] = [];
  const seen = new Set<string>();
  for (const [i, s] of list.entries()) {
    const at = `stamps[${i}]`;
    if (!isObject(s)) return { error: `${at} is not an object` };
    const { repo, path, commit, key, value } = s;
    if (typeof repo !== "string" || !REPO.test(repo))
      return { error: `${at}.repo is not an owner/name repository` };
    if (!policy.repos.includes(repo))
      return {
        error: `${at}: ${repo} is not a repository this job may change`,
      };
    if (typeof path !== "string" || !isPlainRelativePath(path))
      return { error: `${at}.path is not a plain relative path` };
    if (!matchesAnyGlob(path, policy.paths))
      return {
        error: `${at}: ${path} is outside the paths this job may change`,
      };
    if (typeof commit !== "string" || !COMMIT.test(commit))
      return { error: `${at}.commit is not a 40-character commit sha` };
    if (typeof key !== "string" || !KEY.test(key))
      return { error: `${at}.key is not a frontmatter key` };
    if (!allowed.includes(key))
      return {
        error: `${at}: ${key} is not among the job's stamp_keys (${allowed.join(", ") || "none"})`,
      };
    if (
      typeof value !== "string" ||
      value.length > MAX_VALUE ||
      !VALUE.test(value)
    )
      return {
        error: `${at}.value is not a plain value of at most ${MAX_VALUE} characters (letters, digits, . _ / + - and single spaces)`,
      };
    const id = `${repo}/${path}#${key}`;
    if (seen.has(id))
      return { error: `${at}: ${repo}/${path} has more than one ${key} stamp` };
    seen.add(id);
    stamps.push({ repo, path, commit, key, value });
  }
  return { stamps };
}

/**
 * A page with its stamps set: each key must already be in the page's
 * frontmatter on one line of its own, and only that line changes.
 */
export function applyStamps(
  lines: readonly string[],
  stamps: readonly Pick<Stamp, "key" | "value">[],
): { lines: string[] } | { error: string } {
  const block = frontmatter(lines);
  if (block.length === 0 && stamps.length > 0)
    return { error: "has no frontmatter to stamp" };
  const out = [...lines];
  for (const { key, value } of stamps) {
    const at = block.findIndex((l) => l.startsWith(`${key}:`));
    if (at <= 0 || at === block.length - 1)
      return { error: `has no ${key} in its frontmatter to stamp` };
    const next = block[at + 1]!;
    if (next !== "---" && !/^[A-Za-z0-9_-]+:/.test(next))
      return {
        error: `${key} spans more than one line; a stamp replaces one line`,
      };
    out[at] = `${key}: ${value}`;
  }
  return { lines: out };
}
