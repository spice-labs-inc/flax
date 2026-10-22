#!/usr/bin/env node
// `flax scenarios <run|coverage|dataset> ...`, run in a workspace (or with FLAX_WORKSPACE naming one).
// Each command loads its module on demand: coverage and dataset never load cucumber.
import { workspaceRoot } from "./config.js";
const [command, ...rest] = process.argv.slice(2);
const commands = {
    run: async () => (await import("./run/run.js")).runScenarios,
    coverage: async () => (await import("./coverage/cli.js")).runCoverage,
    dataset: async () => (await import("./dataset/cli.js")).runDataset,
};
const load = command ? commands[command] : undefined;
if (!load) {
    console.error(`usage: flax scenarios <${Object.keys(commands).join("|")}> ... (in a workspace with flax.yml, or FLAX_WORKSPACE=<dir>)`);
    process.exit(2);
}
process.chdir(workspaceRoot());
process.exitCode = await (await load())(rest);
//# sourceMappingURL=cli.js.map