import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The ported tests keep a three-environment workspace's env and surface names: the fixture workspace is the config.
const workspace = fileURLToPath(
  new URL("test/fixtures/workspace", import.meta.url),
);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers: 4,
    env: { FLAX_WORKSPACE: workspace },
  },
});
