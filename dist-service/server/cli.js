#!/usr/bin/env node
// `flax explorer <build|serve|refresh> ...`, run in a workspace (or with FLAX_WORKSPACE naming one).
//   build    builds the page for this workspace's flax.yml (its envs, surfaces and titles are baked in)
//            into <workspace>/explorer-site, and the data files into <workspace>/explorer-data
//   serve    runs the live service: the page, the data and the live layer on one port
//   refresh  rebuilds only the data files from the results on disk
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const usage = "usage: flax explorer <build|serve|refresh> [--workspace <dir>] [--results <dir>] [--out <dir>] [--site <dir>] [--state <dir>] [--port <n>] [--single-file] [--page-only]";
const [command, ...rest] = process.argv.slice(2);
let values;
try {
    ({ values } = parseArgs({
        args: rest,
        options: {
            workspace: { type: "string" },
            results: { type: "string" },
            out: { type: "string" },
            site: { type: "string" },
            state: { type: "string" },
            port: { type: "string" },
            "single-file": { type: "boolean", default: false },
            "page-only": { type: "boolean", default: false },
        },
    }));
}
catch (e) {
    console.error(`${e.message}\n${usage}`);
    process.exit(2);
}
const root = resolve(values.workspace ?? process.env["FLAX_WORKSPACE"] ?? process.cwd());
if (!existsSync(join(root, "flax.yml"))) {
    console.error(`no flax.yml in ${root}; run in a workspace or pass --workspace`);
    process.exit(2);
}
process.env["FLAX_WORKSPACE"] = root;
const site = resolve(root, values.site ?? "explorer-site");
const data = resolve(root, values.out ?? "explorer-data");
function run(cmd, args, env, cwd) {
    return new Promise((done) => {
        const child = spawn(cmd, args, {
            cwd,
            env: { ...process.env, ...env },
            stdio: "inherit",
        });
        child.on("exit", (code) => done(code ?? 1));
    });
}
/** The page build: vite inside this package, with the workspace's config and the output directory from the environment. */
async function buildPage() {
    const vite = join(PACKAGE_DIR, "node_modules", ".bin", "vite");
    const kit = join(PACKAGE_DIR, "node_modules", ".bin", "svelte-kit");
    if (!existsSync(vite) || !existsSync(kit)) {
        console.error(`the page build needs vite and @sveltejs/kit installed beside ${PACKAGE_DIR}`);
        return 1;
    }
    const env = {
        EXPLORER_WORKSPACE: root,
        EXPLORER_SITE_DIR: site,
    };
    if (values["single-file"]) {
        env["EXPLORER_SINGLE_FILE"] = "1";
        const routes = await run(process.execPath, [join(PACKAGE_DIR, "scripts", "single-routes.mjs")], env, PACKAGE_DIR);
        if (routes !== 0)
            return routes;
    }
    const sync = await run(kit, ["sync"], env, PACKAGE_DIR);
    if (sync !== 0)
        return sync;
    return run(vite, ["build"], env, PACKAGE_DIR);
}
switch (command) {
    case "refresh": {
        const { refresh } = await import("../scripts/refresh.js");
        process.exitCode = await refresh({
            workspace: root,
            results: values.results,
            out: values.out,
        });
        break;
    }
    case "build": {
        const page = await buildPage();
        if (page !== 0) {
            process.exitCode = page;
            break;
        }
        console.error(`page built into ${site}`);
        if (values["page-only"]) {
            if (values["single-file"])
                console.error("a single-file build without --page-only carries its data inside the page");
            break;
        }
        const { refresh } = await import("../scripts/refresh.js");
        const code = await refresh({
            workspace: root,
            results: values.results,
            out: values.out,
        });
        if (code !== 0) {
            process.exitCode = code;
            break;
        }
        if (values["single-file"]) {
            const { writeSingleFile } = await import("../scripts/single.js");
            const sizes = writeSingleFile({
                built: join(site, "index.html"),
                dataDir: data,
                outDir: site,
                builtAt: new Date().toISOString(),
            });
            console.error(`single-file page written to ${join(site, "index.html")} (${Math.round(sizes.page / 1024)} KB), with artifact.html beside it`);
        }
        break;
    }
    case "serve": {
        process.env["EXPLORER_DATASET_DIR"] = root;
        const { config } = await import("@flax/scenarios/config");
        process.env["EXPLORER_RESULTS_DIR"] ??= resolve(root, values.results ?? config().paths.results);
        process.env["EXPLORER_STATE_DIR"] ??= values.state
            ? resolve(root, values.state)
            : join(root, "explorer-state");
        if (values.port)
            process.env["EXPLORER_PORT"] = values.port;
        process.env["EXPLORER_SITE_DIR"] ??= site;
        if (!existsSync(join(site, "index.html")))
            console.error(`no page at ${site}; run flax explorer build first (serving the data and live layer only)`);
        await import("./service.js");
        break;
    }
    default:
        console.error(usage);
        process.exitCode = 2;
}
//# sourceMappingURL=cli.js.map