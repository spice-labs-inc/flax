import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, type Plugin } from "vite";
import { loadConfig, parseConfig } from "@flax/scenarios/config";

// The workspace whose flax.yml the page is built for: envs, surfaces and titles are baked into the build.
const workspace =
  process.env.EXPLORER_WORKSPACE ??
  process.env.EXPLORER_DATASET_DIR ??
  process.env.FLAX_WORKSPACE ??
  process.cwd();
// Without a workspace (svelte-kit sync, svelte-check in this package) a one-env placeholder keeps the tools running.
const kitConfig = (() => {
  try {
    return loadConfig(workspace);
  } catch (e) {
    if (process.env.EXPLORER_WORKSPACE) throw e;
    return parseConfig(
      "org: placeholder\nenvironments: [live]\nscenarios: { surfaces: [{ name: web }] }\n",
    );
  }
})();

const single = process.env.EXPLORER_SINGLE_FILE === "1";
// The data to serve in the dev server: pnpm explorer's explorer/data, or an explorer service's data directory.
const dataDir =
  process.env.EXPLORER_DATA_DIR ??
  fileURLToPath(new URL("data", import.meta.url));
// An explorer service (explorer/server) for the live layer, such as http://127.0.0.1:8091.
const service = process.env.EXPLORER_SERVICE;

/**
 * /data/* in the dev server, as Caddy serves it beside the service: a service's data directory as it is,
 * or pnpm explorer's flat files as the one version "local".
 */
const TYPES: Record<string, string> = {
  json: "application/json",
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
};

function devData(): Plugin {
  return {
    name: "explorer-dev-data",
    apply: "serve",
    configureServer(server) {
      const versioned = existsSync(join(dataDir, "manifest.json"));
      server.middlewares.use("/data", (req, res, next) => {
        const path = normalize((req.url ?? "").split("?")[0] ?? "");
        if (path.includes("..")) return next();
        let file: string | undefined;
        let body: Buffer | string | undefined;
        if (versioned) file = join(dataDir, path);
        else if (
          path === "/manifest.json" &&
          existsSync(join(dataDir, "history.json"))
        )
          body = JSON.stringify({
            version: "local",
            builtAt: statSync(
              join(dataDir, "history.json"),
            ).mtime.toISOString(),
          });
        else {
          const m = /^\/local\/((?:shots\/)?[\w-]+\.\w+)$/.exec(path);
          if (m?.[1]) file = join(dataDir, m[1]);
        }
        if (file && existsSync(file) && statSync(file).isFile())
          body = readFileSync(file);
        if (body === undefined) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader(
          "content-type",
          TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream",
        );
        res.setHeader("cache-control", "no-store");
        res.end(body);
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [sveltekit(), devData()],
  define: {
    __FLAX_CONFIG__: JSON.stringify(kitConfig),
    __EXPLORER_SINGLE_FILE__: JSON.stringify(single),
    // The dev server has live updates only when it has a service to proxy them to.
    __EXPLORER_LIVE__: JSON.stringify(
      !single && (command === "build" || !!service),
    ),
  },
  server: {
    port: 5178,
    strictPort: true,
    ...(service ? { proxy: { "/live": service } } : {}),
  },
  build: { target: "es2022" },
}));
