import { takeWorkspaceFlag, workspaceRoot } from "../lib/workspace.ts";
import { bundleCheck } from "../bundle/build.ts";
import { formatProblem, isError } from "../lib/problem.ts";
import { loadRepo } from "../lib/repo.ts";
import { CHECKS, runChecks } from "./index.ts";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

takeWorkspaceFlag(process.argv.slice(2));
const repo = loadRepo(workspaceRoot());
// The bundle check needs esbuild, so the bundled runner leaves it out and checks dist/manifest.json instead.
const problems = await runChecks(repo, [...CHECKS, bundleCheck]);
const errors = problems.filter(isError);
const warnings = problems.filter((p) => !isError(p));
for (const p of warnings) {
  console.error(formatProblem(p));
  // An annotation makes the warning visible on the pull request, not only in the log.
  if (process.env.GITHUB_ACTIONS === "true")
    console.log(`::warning file=${p.file}::${formatProblem(p)}`);
}
if (errors.length > 0) {
  for (const p of errors) console.error(formatProblem(p));
  console.error(`\n${plural(errors.length, "problem")} found.`);
  process.exit(1);
}
console.log(
  `All checks passed for ${plural(repo.jobs.length, "job")}${warnings.length > 0 ? ` (${plural(warnings.length, "warning")})` : ""}.`,
);
