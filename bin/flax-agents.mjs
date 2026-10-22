#!/usr/bin/env node
// The agents command line: flax agents <command> [--workspace <dir>] [args], also reachable as
// flax-agents. Each command is one of the src/*/cli.ts entries, run from source with tsx.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const commands = {
  check: "src/check/cli.ts",
  generate: "src/generate/cli.ts",
  "new-job": "src/new-job/cli.ts",
  "run-job": "src/run-job/cli.ts",
  "check-output": "src/output-check/cli.ts",
  "net-check": "src/net-check/cli.ts",
  "tools-smoke": "src/tools-server/smoke-cli.ts",
  "fetch-servers": "src/tools-server/fetch-servers-cli.ts",
  "fetch-github-hosts": "src/tools-server/fetch-github-hosts-cli.ts",
  "box-release": "src/box-release/cli.ts",
  "bundle-pi-plugin": "src/pi-plugin/cli.ts",
};
const [cmd, ...rest] = process.argv.slice(2);
const at = rest.indexOf("--workspace");
if (at >= 0 && rest[at + 1] !== undefined)
  process.env.FLAX_WORKSPACE = rest[at + 1];
const entry = commands[cmd];
if (!entry) {
  console.error(
    `usage: flax agents <${Object.keys(commands).join("|")}> [--workspace <dir>] ...`,
  );
  process.exit(2);
}
const require = createRequire(import.meta.url);
const tsx = join(dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");
const r = spawnSync(process.execPath, [tsx, join(here, "..", entry), ...rest], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
