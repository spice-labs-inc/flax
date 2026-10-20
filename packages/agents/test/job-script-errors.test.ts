import { join } from "node:path";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { startedFromJob } from "../src/collect/tools.ts";
import { bundleOne } from "../src/bundle/build.ts";
import { bundledJobScript, jobFile, KIT_ROOT } from "../src/lib/paths.ts";
import { failureLine, runJobScript } from "../src/run-job/input.ts";
import { jobFiles, linkKitNodeModules, makeRepo } from "./helpers.ts";

describe("a failed job script", () => {
  it("names the thrown error, skipping the bundled source line Node prints first", () => {
    const stderr = [
      "file:///opt/runner/_work/agents/dist/jobs/demo/collect.mjs:59",
      `${"x".repeat(50_000)}`,
      "    ^",
      "",
      "Error: the internal docs moved while the pages were read",
      "    at collect (file:///opt/runner/collect.mjs:59:12)",
      "    at async main (file:///opt/runner/collect.mjs:60:3)",
      "",
      "Node.js v24.1.0",
    ].join("\n");
    expect(failureLine(stderr)).toBe(
      "Error: the internal docs moved while the pages were read",
    );
    expect(failureLine("TypeError [ERR_X]: bad input\n")).toBe(
      "TypeError [ERR_X]: bad input",
    );
    expect(failureLine("listing failed\n    at x\n")).toBe("listing failed");
    expect(failureLine("")).toBeUndefined();
  });

  it("puts the error in the run's failure message", async () => {
    const root = makeRepo({
      jobs: {
        demo: {
          ...jobFiles("demo"),
          "collect.ts": `const pad = "${"y".repeat(3000)}";\nif (pad.length > 0) throw new Error("could not list the open pull requests");\n`,
        },
      },
    });
    await expect(
      runJobScript(root, "demo", "collect.ts", {
        PATH: process.env.PATH ?? "",
      }),
    ).rejects.toThrow(
      "jobs/demo/collect.ts failed (exit 1): Error: could not list the open pull requests",
    );
  });

  it("prints one short line for an error a job script's main throws, however long its message", async () => {
    const tools = JSON.stringify(join(KIT_ROOT, "src/collect/tools.ts"));
    const root = makeRepo({
      jobs: {
        demo: {
          ...jobFiles("demo"),
          "collect.ts": `import { runMain } from ${tools};
async function main() {
  const nl = String.fromCharCode(10);
  throw new Error("invalid tool result:" + nl + "[{ code: 'invalid_type' }]".concat(nl).repeat(400));
}
await runMain(import.meta.url, "demo", main);
`,
        },
      },
      files: { "package.json": JSON.stringify({ type: "module" }) },
    });
    const failure = await runJobScript(root, "demo", "collect.ts", {
      PATH: process.env.PATH ?? "",
    }).then(
      () => "",
      (err: Error) => err.message,
    );
    expect(failure).toMatch(
      /^jobs\/demo\/collect\.ts failed \(exit 1\): Error: invalid tool result: \[\{ code: 'invalid_type' \}\]/,
    );
    expect(failure.length).toBeLessThan(400);
  });

  it("runs only the started job's main, so a job bundling another job's script runs one main", () => {
    const root = makeRepo({
      jobs: { alpha: { ...jobFiles("alpha"), "collect.ts": "" } },
    });
    const bundle = join(root, "dist/jobs/beta/collect.mjs");
    mkdirSync(join(root, "dist/jobs/beta"), { recursive: true });
    writeFileSync(bundle, "");
    const argv = process.argv[1];
    try {
      process.argv[1] = bundle;
      expect(startedFromJob("beta")).toBe(true);
      expect(startedFromJob("alpha")).toBe(false);
      process.argv[1] = join(root, "jobs/alpha/collect.ts");
      expect(startedFromJob("alpha")).toBe(true);
      expect(startedFromJob("beta")).toBe(false);
      // A script that is not there started nothing.
      process.argv[1] = join(root, "jobs/gamma/collect.ts");
      expect(startedFromJob("gamma")).toBe(false);
    } finally {
      process.argv[1] = argv!;
    }
  });

  it("bundles each job script with only its own main: two jobs share the kit's collect helpers and a workspace library, never each other", async () => {
    const collect = (job: string) =>
      [
        'import { runMain } from "@flax/agents/collect/tools";',
        'import { greeting } from "../../lib/shared.ts";',
        "",
        "async function main() {",
        `  console.log(JSON.stringify({ text: greeting("${job}") }));`,
        "}",
        `await runMain(import.meta.url, "${job}", main);`,
        "",
      ].join("\n");
    const root = makeRepo({
      jobs: {
        alpha: { ...jobFiles("alpha"), "collect.ts": collect("alpha") },
        beta: { ...jobFiles("beta"), "collect.ts": collect("beta") },
      },
      files: {
        "lib/shared.ts":
          "export const greeting = (job: string) => `hello from ${job}`;\n",
        "package.json": JSON.stringify({ type: "module" }),
      },
    });
    linkKitNodeModules(root);
    for (const job of ["alpha", "beta"]) {
      const { text: bundle } = await bundleOne(
        root,
        bundledJobScript(job, "collect.ts"),
        { file: jobFile(job, "collect.ts") },
      );
      expect(
        [
          ...bundle.matchAll(/runMain\(import\.meta\.url,\s*"([a-z0-9-]+)"/g),
        ].map((m) => m[1]),
        job,
      ).toEqual([job]);
      expect(bundle).toContain("hello from ");
    }
    // No job script of the fixture workspace or of these reaches into another job's folder.
    for (const base of [FIXTURE_WORKSPACE, root])
      for (const job of readdirSync(join(base, "jobs")))
        for (const file of readdirSync(join(base, "jobs", job)).filter((f) =>
          f.endsWith(".ts"),
        ))
          expect(
            readFileSync(join(base, "jobs", job, file), "utf8"),
            `jobs/${job}/${file}`,
          ).not.toMatch(/from "\.\.\/(?!\.\.\/)[^"]+"/);
  });
});
