#!/usr/bin/env node
// The explorer service on its own: `EXPLORER_DATASET_DIR=<workspace> node main.js`; `flax explorer serve` wraps it.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(process.env["EXPLORER_DATASET_DIR"] ??
    process.env["FLAX_WORKSPACE"] ??
    process.cwd());
if (!existsSync(join(root, "flax.yml"))) {
    console.error(`no flax.yml in ${root}; set EXPLORER_DATASET_DIR to a workspace`);
    process.exit(2);
}
process.env["FLAX_WORKSPACE"] = root;
process.env["EXPLORER_DATASET_DIR"] = root;
await import("./service.js");
//# sourceMappingURL=main.js.map