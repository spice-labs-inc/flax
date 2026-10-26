import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jobDir } from "../lib/paths.ts";
import { problem, type Problem } from "../lib/problem.ts";
import { byCodePoint } from "../lib/sort.ts";
import type { Check } from "./types.ts";

interface SecretPattern {
  name: string;
  pattern: RegExp;
  /** Extra test on the match, for patterns that would otherwise flag ordinary words. */
  accept?: (match: string) => boolean;
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values())
    bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

// Real API keys mix cases and digits and look random; prose like
// "sk-not-a-real-key-just-an-example" does neither.
function looksRandom(key: string): boolean {
  const body = key.replace(/^sk-(ant-)?/, "");
  return (
    /[a-z]/.test(body) &&
    /[A-Z]/.test(body) &&
    /\d/.test(body) &&
    entropy(body) >= 3.5
  );
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  {
    name: "GitHub fine-grained token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: "private key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/g,
  },
  {
    name: "API key",
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
    accept: looksRandom,
  },
];

export interface SecretHit {
  line: number;
  name: string;
}

export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    for (const { name, pattern, accept } of SECRET_PATTERNS) {
      for (const m of line.matchAll(pattern)) {
        if (accept === undefined || accept(m[0]))
          hits.push({ line: i + 1, name });
      }
    }
  }
  return hits;
}

function filesUnder(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir)).sort(byCodePoint)) {
    const rel = `${dir}/${entry}`;
    const stat = lstatSync(join(root, rel));
    if (stat.isDirectory()) out.push(...filesUnder(root, rel));
    else if (stat.isFile()) out.push(rel);
  }
  return out;
}

/** No file in a job folder contains something shaped like a credential. */
export const secretsCheck: Check = {
  id: "secrets",
  title: "no secret-shaped strings in job folders",
  run(repo) {
    const problems: Problem[] = [];
    for (const job of repo.jobs) {
      for (const file of filesUnder(repo.root, jobDir(job.name))) {
        const text = readFileSync(join(repo.root, file), "utf8");
        // The matched text is never echoed, so a leaked key does not also end up in CI logs.
        for (const hit of findSecrets(text)) {
          problems.push(
            problem(
              file,
              `line ${hit.line} matches the ${hit.name} pattern; remove the secret and rotate it`,
            ),
          );
        }
      }
    }
    return problems;
  },
};
