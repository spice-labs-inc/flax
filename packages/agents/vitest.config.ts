import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup-workspace.ts"],
    // Several suites start real processes; under a full parallel run on a busy
    // machine they can pass 5 s, so the default timeout only made them flaky.
    testTimeout: 30_000,
  },
});
