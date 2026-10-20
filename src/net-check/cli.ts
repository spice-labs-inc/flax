import { takeWorkspaceFlag, workspaceRoot } from "../lib/workspace.ts";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadBox } from "../lib/box.ts";
import { runNetCheck } from "./run.ts";

const usage = "usage: flax agents net-check [--box-outputs]";

let values;
try {
  ({ values } = parseArgs({
    options: { "box-outputs": { type: "boolean", default: false } },
  }));
} catch (err) {
  console.error(`${(err as Error).message}\n${usage}`);
  process.exit(2);
}

takeWorkspaceFlag(process.argv.slice(2));
const root = workspaceRoot();

// For the workflow: the pinned box, as step outputs to pull and check out.
if (values["box-outputs"]) {
  const { box, problems } = loadBox(root);
  if (box === undefined || !box.pinned) {
    console.error(
      `box.yml is not pinned: ${problems.map((p) => p.message).join("; ")}`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `release=${box.box_release}\ncommit=${box.box_commit}\nimage=${box.image}\n`,
  );
  process.exit(0);
}

const scratch = process.env.RUNNER_TEMP;
if (scratch === undefined || scratch === "") {
  console.error(
    "set RUNNER_TEMP to a directory outside the home directory for the run",
  );
  process.exit(2);
}
const result = await runNetCheck({ root, env: process.env, scratch });
process.stdout.write(result.text);
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary !== undefined && summary !== "")
  appendFileSync(summary, `\`\`\`\n${result.text}\`\`\`\n`);
process.exit(result.verdict.pass ? 0 : 1);
