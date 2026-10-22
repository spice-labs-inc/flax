#!/usr/bin/env node
// `flax atlas <cmd>`: the entry the flax command runs for this package.
//
//   flax atlas check | used-by | index | outlines | budgets | symmetry | recent | inventories | generated | drift
//   flax atlas generate [--reuse-wiring | --reextract-changed] [--max-extractions N] [--only a,b] [--no-cache]
//   flax atlas build [--graph <path>]
//   flax atlas serve [--port N]
//   flax atlas wiring-eval [--socket <path> | --base-url <url> --model <id>] [--sample N | --docs a,b]
//
// Every command reads flax.yml in the workspace (the current directory, or --workspace <dir>)
// and works on the atlas directory its `atlas.root` names. `flax atlas help <cmd>` says more.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const [cmd, ...rest] = process.argv.slice(2);
function usage(code) {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .filter((l) => l.startsWith("//"))
        .map((l) => l.replace(/^\/\/ ?/, ""));
    (code ? process.stderr : process.stdout).write(`${lines.join("\n")}\n`);
    process.exit(code);
}
if (cmd === undefined)
    usage(2);
if (cmd === "--help" || cmd === "-h")
    usage(0);
if (cmd === "help" && rest.length === 0)
    usage(0);
try {
    if (cmd === "generate")
        process.exitCode = await (await import("./generate.js")).main(rest);
    else if (cmd === "build")
        process.exitCode = await (await import("./build.js")).main(rest);
    else if (cmd === "serve")
        await (await import("./serve.js")).main(rest);
    else if (cmd === "wiring-eval")
        process.exitCode = await (await import("./wiring-eval.js")).main(rest);
    else
        process.exitCode = await (await import("./atlas/cli.js")).main([cmd, ...rest]);
}
catch (e) {
    console.error(`flax atlas ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
}
//# sourceMappingURL=bin.js.map