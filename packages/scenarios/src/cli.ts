#!/usr/bin/env node
// `flax scenarios <run|coverage|dataset> ...`, run in a workspace (or with FLAX_WORKSPACE naming one).
// Each command loads its module on demand: coverage and dataset never load cucumber.
import { workspaceRoot } from "./config.ts";

const [command, ...rest] = process.argv.slice(2);
const commands: Record<
  string,
  () => Promise<(argv: string[]) => Promise<number>>
> = {
  run: async () => (await import("./run/run.ts")).runScenarios,
  coverage: async () => (await import("./coverage/cli.ts")).runCoverage,
  dataset: async () => (await import("./dataset/cli.ts")).runDataset,
};
const load = command ? commands[command] : undefined;
if (!load) {
  console.error(
    `usage: flax scenarios <${Object.keys(commands).join("|")}> ... (in a workspace with flax.yml, or FLAX_WORKSPACE=<dir>)`,
  );
  process.exit(2);
}
process.chdir(workspaceRoot());
process.exitCode = await (await load())(rest);
