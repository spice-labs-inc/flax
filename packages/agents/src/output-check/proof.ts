import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { byCodePoint } from "../lib/sort.ts";
import { checkPatchSet, resultLines, type CheckContext } from "./pr.ts";

/** A committed answer with the verdict the PR checker must reach on it. */
export interface ProofCase {
  name: string;
  description: string;
  expect: "accept" | "reject";
  /** Pieces of text that must each appear in one of the checker's problems. */
  reasons: string[];
  answer: unknown;
}

export interface ProofOutcome {
  name: string;
  description: string;
  expect: "accept" | "reject";
  got: "accept" | "reject";
  problems: string[];
  /** Expected reasons the checker did not give. */
  missing: string[];
  passed: boolean;
}

export const PROOF_CASES_DIR = "test/output-check-cases";

export function loadProofCases(dir: string): ProofCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort(byCodePoint)
    .map((f) => {
      const data = JSON.parse(readFileSync(join(dir, f), "utf8")) as Omit<
        ProofCase,
        "name"
      >;
      return { name: f.replace(/\.json$/, ""), ...data };
    });
}

export function runProofCase(
  c: ProofCase,
  context: CheckContext,
): ProofOutcome {
  const result = checkPatchSet(c.answer, context);
  const problems = resultLines(result);
  const got = result.ok ? "accept" : "reject";
  const missing = c.reasons.filter((r) => !problems.some((p) => p.includes(r)));
  return {
    name: c.name,
    description: c.description,
    expect: c.expect,
    got,
    problems,
    missing,
    passed:
      got === c.expect &&
      missing.length === 0 &&
      (c.expect === "accept" || problems.length > 0),
  };
}
