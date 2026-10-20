import { takeWorkspaceFlag, workspaceRoot } from "../lib/workspace.ts";
import { writeBundles } from "../bundle/build.ts";
import { formatProblem } from "../lib/problem.ts";
import { loadRepo } from "../lib/repo.ts";
import { blockingProblems, generate, generateOptions } from "./generate.ts";

let options: { dist: boolean };
try {
  options = generateOptions(takeWorkspaceFlag(process.argv.slice(2)));
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
const repo = loadRepo(workspaceRoot());
const blocking = blockingProblems(repo);
if (blocking.length > 0) {
  for (const p of blocking) console.error(formatProblem(p));
  console.error("Fix these problems, then run flax agents generate again.");
  process.exit(1);
}
const generated = await generate(repo);
const bundles = options.dist
  ? await writeBundles(repo.root)
  : { written: [], removed: [], unchanged: [] };
const result = {
  written: [...generated.written, ...bundles.written],
  removed: [...generated.removed, ...bundles.removed],
  unchanged: [...generated.unchanged, ...bundles.unchanged],
};
for (const file of result.written) console.log(`wrote ${file}`);
for (const file of result.removed) console.log(`removed ${file}`);
console.log(
  `${result.written.length} written, ${result.removed.length} removed, ${result.unchanged.length} unchanged`,
);
