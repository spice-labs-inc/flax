import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { workspaceRoot } from "../lib/workspace.ts";
import { firstLine } from "../lib/problem.ts";
import type { CheckResult } from "./pr.ts";
import { asReplayInput, replayContext } from "./pinned-input.ts";
import { loadProofCases, PROOF_CASES_DIR, runProofCase } from "./proof.ts";
import { checkReport } from "./report.ts";

const usage =
  "usage: flax agents check-output [--workspace <dir>] <report dir>... | flax agents check-output [--workspace <dir>] --proof <input.json>";

let parsed;
try {
  parsed = parseArgs({
    options: { proof: { type: "string" }, workspace: { type: "string" } },
    allowPositionals: true,
  });
  if ((parsed.values.proof !== undefined) === parsed.positionals.length > 0)
    throw new Error(usage);
} catch (err) {
  const message = (err as Error).message;
  console.error(message === usage ? usage : `${message}\n${usage}`);
  process.exit(2);
}

const root = workspaceRoot(parsed.values.workspace);

function printResult(result: CheckResult): void {
  for (const line of result.problems) console.log(`  ${line}`);
  for (const page of result.pages) {
    const what =
      page.decision === "patch"
        ? `patch, ${page.changedLines} changed line${page.changedLines === 1 ? "" : "s"}`
        : "no change";
    console.log(
      `  ${page.ok ? "ok    " : "REJECT"} ${page.repo}/${page.path} (${what})`,
    );
    for (const p of page.problems) console.log(`         ${p}`);
  }
}

if (parsed.values.proof !== undefined) {
  // The proof input is a workspace fixture: a job input that carries its own rules, pages and sources.
  const proofFile = parsed.values.proof;
  const input = asReplayInput(
    JSON.parse(readFileSync(join(root, proofFile), "utf8")),
  );
  if ("error" in input) {
    console.error(`${proofFile}: ${input.error}`);
    process.exit(2);
  }
  const outcomes = loadProofCases(join(root, PROOF_CASES_DIR)).map((c) =>
    runProofCase(c, replayContext(input)),
  );
  for (const o of outcomes) {
    console.log(
      `${o.passed ? "PASS" : "FAIL"} ${o.name}: expected ${o.expect}, got ${o.got}. ${o.description}`,
    );
    for (const p of o.problems) console.log(`       ${p}`);
    for (const m of o.missing) console.log(`       missing reason: ${m}`);
  }
  const failed = outcomes.filter((o) => !o.passed).length;
  console.log(
    `\n${outcomes.length - failed} of ${outcomes.length} cases reached the expected verdict.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

let rejected = 0;
for (const dir of parsed.positionals) {
  try {
    const check = checkReport(root, dir);
    console.log(
      `${check.result.ok ? "ACCEPTED" : "REJECTED"} ${dir} (${check.job}, ${check.model})`,
    );
    printResult(check.result);
    if (!check.result.ok) rejected++;
  } catch (err) {
    console.error(`${dir}: ${firstLine(err)}`);
    process.exit(2);
  }
}
process.exit(rejected === 0 ? 0 : 1);
