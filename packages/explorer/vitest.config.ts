import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The ported tests keep a three-environment workspace's env and surface names: the fixture workspace is the config.
const workspace = fileURLToPath(
  new URL("test/fixtures/workspace", import.meta.url),
);
process.env["FLAX_WORKSPACE"] = workspace;
const { loadConfig } = await import("@flax/scenarios/config");

export default defineConfig({
  define: {
    __FLAX_CONFIG__: JSON.stringify(loadConfig(workspace)),
    __EXPLORER_SINGLE_FILE__: "false",
    __EXPLORER_LIVE__: "false",
  },
  resolve: {
    alias: { $lib: fileURLToPath(new URL("src/lib", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers: 4,
    env: { FLAX_WORKSPACE: workspace },
  },
});
