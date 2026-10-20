#!/usr/bin/env node
// The flax command. `flax <package> [args]` resolves `@flax/<package>` and runs the entry its
// package.json names under "flax" (a path to an executable JS file that reads process.argv).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

const SUBCOMMANDS = ["agents", "atlas", "scenarios", "explorer"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function usage(): never {
  process.stderr.write(`usage: flax <${SUBCOMMANDS.join("|")}> [args]\n`);
  process.exit(2);
}

function isSubcommand(word: string | undefined): word is Subcommand {
  return SUBCOMMANDS.includes(word as Subcommand);
}

const [, , word, ...rest] = process.argv;
if (!isSubcommand(word)) usage();

// Resolve the package from the workspace the user runs in first (a consumer that depends on
// @flax/<package>), then from the cli package itself (the monorepo and global installs).
const resolvers = [createRequire(join(process.cwd(), "package.json")), createRequire(import.meta.url)];
function resolvePackage(name: string): string {
  let lastError: unknown;
  for (const req of resolvers) {
    try {
      return req.resolve(name);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const require = createRequire(import.meta.url);
let entry: string;
try {
  const manifestPath = resolvePackage(`@flax/${word}/package.json`);
  const manifest = require(manifestPath) as { flax?: string };
  if (!manifest.flax) throw new Error(`@flax/${word} declares no "flax" entry in its package.json`);
  entry = join(dirname(manifestPath), manifest.flax);
} catch (error) {
  process.stderr.write(`flax ${word}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const child = spawn(process.execPath, [entry, ...rest], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
