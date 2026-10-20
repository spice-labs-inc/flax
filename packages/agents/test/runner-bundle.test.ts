import { execFile, spawnSync } from "node:child_process";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { parse, stringify } from "yaml";
import {
  bundleProblems,
  buildBundles,
  runnerEntry,
  writeBundles,
} from "../src/bundle/build.ts";
import { bundledTools, manifestProblems } from "../src/bundle/manifest.ts";
import { generate } from "../src/generate/generate.ts";
import {
  BUNDLE_MANIFEST,
  KIT_ROOT,
  REBUILD_DIST,
  REVISE_POLL_BUNDLE,
  RUNNER_BUNDLE,
} from "../src/lib/paths.ts";
import { formatProblem } from "../src/lib/problem.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { jobScriptArgs } from "../src/run-job/input.ts";
import {
  loadMapping,
  useBundledMappings,
} from "../src/tools-server/mapping.ts";
import { startFakeGateway, TLS } from "./fake-gateway.ts";
import { writeFakeLbx } from "./fake-lbx.ts";
import { jobConfig, linkKitNodeModules, OUTPUT_SCHEMA } from "./helpers.ts";

// Built at runtime so no key-shaped literal sits in the source.
const ISSUER = ["issuer", "test", "key", "0a1b2c3d4e"].join("-");

function scratch(prefix = "agents-bundle-run-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A media.ts that writes one file and its manifest with the kit's own hash, from its bundle. */
const DEMO_MEDIA = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMain } from "@flax/agents/collect/tools";
import { mediaHash, sha256Hex } from "@flax/agents/lib/media";

async function main() {
  const dir = process.env.FLAX_AGENTS_MEDIA_DIR!;
  const text = "WEBVTT\\n";
  writeFileSync(join(dir, "captions.vtt"), text);
  const files = [{ path: "captions.vtt", sha256: sha256Hex(text), bytes: text.length, type: "text/vtt" }];
  writeFileSync(join(dir, "media.json"), JSON.stringify({ version: 1, files, hash: mediaHash(files), data: { scenes: 1 } }));
}
await runMain(import.meta.url, "bundle-demo", main);
`;

/** A job whose collect.ts imports an npm package, calls a tool and reads the media manifest, so its bundle must carry all three. */
const DEMO_COLLECT = `import { readFileSync } from "node:fs";
import { stringify } from "yaml";
import { connectCollectTools } from "@flax/agents/collect/tools";

const tools = await connectCollectTools();
const echoed = await tools.call("echo", { text: "from the bundled collect" });
await tools.close();
console.log(JSON.stringify({
  text: stringify({ echoed: echoed.text }),
  sawKey: process.env.LLM_GATEWAY_ISSUER_KEY !== undefined,
  media: JSON.parse(readFileSync(process.env.FLAX_AGENTS_MEDIA_MANIFEST!, "utf8")).data,
}));
`;

const DEMO_FILES: Record<string, string> = {
  "job.yml": stringify(
    jobConfig("bundle-demo", {
      model: "acme/acme-deepseek-v4.1-flash",
      limits: { turns: 10, tokens_per_run: 1000, usd_per_month: 1 },
      collect_tools: ["echo"],
      media: { network: "public", secrets: [], timeout_minutes: 5 },
    }),
  ),
  "prompt.md": "Summarize the input.\n",
  "output.json": JSON.stringify(OUTPUT_SCHEMA),
  "fixtures/input.json": JSON.stringify({ text: "hello" }),
  "fixtures/output.json": JSON.stringify({ summary: "hi" }),
  "collect.ts": DEMO_COLLECT,
  "media.ts": DEMO_MEDIA,
};

/** A render.ts that turns the answer into one section block, from its bundle. */
const DEMO_RENDER = `import { readFileSync } from "node:fs";

const answer = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify({
  text: \`render-demo: \${answer.summary}\`,
  blocks: [{ type: "section", text: { type: "mrkdwn", text: \`*render-demo*\\n\${answer.summary}\` } }],
}));
`;

const RENDER_FILES: Record<string, string> = {
  "job.yml": stringify(
    jobConfig("render-demo", {
      model: "acme/acme-deepseek-v4.1-flash",
      limits: { turns: 10, tokens_per_run: 1000, usd_per_month: 1 },
    }),
  ),
  "prompt.md": "Summarize the input.\n",
  "output.json": JSON.stringify(OUTPUT_SCHEMA),
  "fixtures/input.json": JSON.stringify({ text: "hello" }),
  "fixtures/output.json": JSON.stringify({ summary: "hi" }),
  "render.ts": DEMO_RENDER,
};

/**
 * A copy of the fixture workspace with two more jobs, a lockfile, its
 * workflows generated and its bundles built with the kit linked under
 * node_modules, and then no node_modules at all: what a job workflow has
 * after checkout.
 */
async function bundledCopy(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "agents-bundle-copy-"));
  cpSync(FIXTURE_WORKSPACE, root, { recursive: true, dereference: true });
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const [job, files] of [
    ["bundle-demo", DEMO_FILES],
    ["render-demo", RENDER_FILES],
  ] as const) {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(root, "jobs", job, file, ".."), { recursive: true });
      writeFileSync(join(root, "jobs", job, file), content);
    }
  }
  await generate(loadRepo(root));
  linkKitNodeModules(root);
  try {
    await writeBundles(root);
  } finally {
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
  }
  return root;
}

function runBundle(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const { PATH, HOME } = process.env;
  return spawnSync(process.execPath, [join(root, RUNNER_BUNDLE), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { PATH, HOME, ...env },
    timeout: 60_000,
  });
}

/** runBundle without blocking this process, for a run that talks to a fake served from it. */
function runBundleAsync(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { PATH, HOME } = process.env;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(root, RUNNER_BUNDLE), ...args],
      {
        cwd: root,
        encoding: "utf8",
        env: { PATH, HOME, ...env },
        timeout: 60_000,
      },
      (error, stdout, stderr) =>
        resolve({
          status:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : null,
          stdout,
          stderr,
        }),
    );
  });
}

describe("the runner bundles", () => {
  it("are the same bytes every time", async () => {
    const first = await buildBundles(FIXTURE_WORKSPACE);
    const second = await buildBundles(FIXTURE_WORKSPACE);
    expect([...first.keys()]).toEqual([...second.keys()]);
    for (const [file, text] of first) expect(second.get(file)).toBe(text);
    expect(first.has(RUNNER_BUNDLE)).toBe(true);
    expect(first.has(REVISE_POLL_BUNDLE)).toBe(true);
  }, 60_000);

  it("carry no absolute path of the machine that built them", async () => {
    for (const [file, text] of await buildBundles(FIXTURE_WORKSPACE))
      expect(text.includes(KIT_ROOT), file).toBe(false);
  }, 60_000);

  it("hand the runner every tool mapping before its command line starts", () => {
    const tools = bundledTools(FIXTURE_WORKSPACE);
    expect(tools).toContain("echo");
    const entry = runnerEntry(tools);
    for (const name of tools)
      expect(entry).toContain(`from "./tools/${name}/map.ts";`);
    // The kit's own entry point by its absolute path: the bundle is built in the workspace, which has no src/.
    expect(entry.trim().split("\n").at(-1)).toBe(
      `await import(${JSON.stringify(join(KIT_ROOT, "src/run-job/cli.ts"))});`,
    );
    expect(entry.indexOf("useBundledMappings({")).toBeLessThan(
      entry.indexOf("await import"),
    );
  });
});

describe("job scripts", () => {
  it("run through tsx from source and from their bundle in the bundled runner", () => {
    const root = scratch();
    const source = jobScriptArgs(root, "demo", "collect.ts", false);
    expect(source).toHaveLength(2);
    expect(source[0]).toMatch(/tsx/);
    expect(source[1]).toBe(join(root, "jobs/demo/collect.ts"));
    expect(() => jobScriptArgs(root, "demo", "render.ts", true)).toThrow(
      `dist/jobs/demo/render.mjs is missing, so jobs/demo/render.ts cannot run; ${REBUILD_DIST}`,
    );
    mkdirSync(join(root, "dist/jobs/demo"), { recursive: true });
    writeFileSync(join(root, "dist/jobs/demo/render.mjs"), "");
    expect(jobScriptArgs(root, "demo", "render.ts", true)).toEqual([
      join(root, "dist/jobs/demo/render.mjs"),
    ]);
  });
});

describe("bundled tool mappings", () => {
  it("are used instead of importing, and a tool left out of the bundle does not load", async () => {
    const mapping = {
      map: () => ({ operation: "echo", arguments: {} }),
    };
    useBundledMappings({ echo: { default: mapping } });
    onTestFinished(() => useBundledMappings(undefined));
    expect(await loadMapping("/nonexistent", "echo")).toBe(mapping);
    await expect(loadMapping("/nonexistent", "newer")).rejects.toThrow(
      `cannot be loaded: it is not in the runner bundle; ${REBUILD_DIST}`,
    );
  });
});

describe("the bundled runner, in a checkout with no node_modules", () => {
  let root: string;
  beforeAll(async () => {
    root = await bundledCopy();
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("has nothing to install: no node_modules and every bundle in dist/", () => {
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    for (const file of [
      RUNNER_BUNDLE,
      REVISE_POLL_BUNDLE,
      BUNDLE_MANIFEST,
      "dist/jobs/bundle-demo/collect.mjs",
      "dist/jobs/bundle-demo/media.mjs",
      "dist/jobs/render-demo/render.mjs",
    ])
      expect(existsSync(join(root, file)), file).toBe(true);
    expect(manifestProblems(root)).toEqual([]);
  });

  it("runs the revision poller from anywhere, finding the jobs next to it", () => {
    const { PATH, HOME } = process.env;
    const run = spawnSync(process.execPath, [join(root, REVISE_POLL_BUNDLE)], {
      cwd: scratch(),
      encoding: "utf8",
      env: { PATH, HOME },
      timeout: 60_000,
    });
    // With no live pull request job it stops there; with one, it stops at the missing secrets.
    expect(`${run.stdout}${run.stderr}`).toMatch(
      /^(No live pull request job; nothing to poll\.|AGENTS_READER_APP_ID, AGENTS_READER_PRIVATE_KEY and GH_TOKEN must be set)\n$/,
    );
  });

  it("checks the tree and runs stub jobs, rendering with the bundled render.ts and loading the bundled tools", () => {
    expect(runBundle(root, ["hello", "--preflight"]).status).toBe(0);
    for (const job of ["hello", "render-demo"]) {
      const dir = scratch();
      const run = runBundle(root, [
        job,
        "--stub",
        "--scratch",
        dir,
        "--out",
        join(dir, "report"),
      ]);
      expect(run.stderr, job).toBe("");
      expect(run.status, job).toBe(0);
      expect(run.stdout).toContain(`${job}: answer accepted.`);
    }
    const dir = scratch();
    runBundle(root, [
      "render-demo",
      "--stub",
      "--scratch",
      dir,
      "--out",
      join(dir, "report"),
    ]);
    const slack = JSON.parse(
      readFileSync(join(dir, "report/slack.json"), "utf8"),
    );
    expect(slack.blocks.length).toBeGreaterThan(1);
  }, 60_000);

  it("takes the thinking level from the command line, the job's own when empty, and refuses one the model does not take", () => {
    const status = (args: string[]) => {
      const dir = scratch();
      const run = runBundle(root, [
        "hello",
        "--stub",
        "--scratch",
        dir,
        "--out",
        join(dir, "report"),
        ...args,
      ]);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      const argv: string[] = JSON.parse(
        readFileSync(join(dir, "report/argv.json"), "utf8"),
      );
      const thinking = JSON.parse(
        readFileSync(join(dir, "report/status.json"), "utf8"),
      ).thinking;
      expect(argv[argv.indexOf("--thinking") + 1]).toBe(thinking);
      return thinking;
    };
    expect(status(["--model", "", "--thinking", ""])).toBe("high");
    expect(status(["--thinking", "low"])).toBe("low");
    const refused = runBundle(root, [
      "hello",
      "--preflight",
      "--thinking",
      "max",
    ]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      '--thinking: "max" is not a thinking level acme/acme-deepseek-v4.1-flash takes; models.yml lists off, low, high, xhigh',
    );
  }, 60_000);

  it("runs a real job through the gateway whose bundled media.ts makes media and bundled collect.ts calls a tool, without the issuer key", async () => {
    const fake = await startFakeGateway({ issuerKey: ISSUER });
    const gatewayFile = join(root, "gateway.yml");
    const before = readFileSync(gatewayFile, "utf8");
    onTestFinished(async () => {
      writeFileSync(gatewayFile, before);
      rmSync(join(root, "test-gateway-ca.pem"), { force: true });
      await generate(loadRepo(root));
    });
    writeFileSync(join(root, "test-gateway-ca.pem"), TLS.ca);
    writeFileSync(
      gatewayFile,
      stringify({
        ...parse(before),
        url: fake.url,
        server_name: "localhost",
        ca: "test-gateway-ca.pem",
      }),
    );
    await generate(loadRepo(root));
    const bin = scratch("agents-bundle-lbx-");
    symlinkSync(writeFakeLbx(bin), join(bin, "lbx"));
    const dir = scratch();
    const run = await runBundleAsync(
      root,
      ["bundle-demo", "--scratch", dir, "--out", join(dir, "report")],
      {
        PATH: `${bin}:${process.env.PATH}`,
        LLM_GATEWAY_ISSUER_KEY: ISSUER,
        FAKE_LBX_ANSWER: JSON.stringify({ summary: "done" }),
      },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(fake.issued).toHaveLength(1);
    expect(fake.keys[0]?.blocked).toBe(true);
    expect(run.stdout).toContain("bundle-demo: answer accepted.");
    const input = JSON.parse(
      readFileSync(join(dir, "report/input.json"), "utf8"),
    );
    expect(input).toEqual({
      text: "echoed: from the bundled collect\n",
      sawKey: false,
      media: { scenes: 1 },
    });
  }, 60_000);

  it("refuses to start when a source changed after the bundles were built", () => {
    const file = join(root, "tools/echo/map.ts");
    const before = readFileSync(file);
    appendFileSync(file, "\n");
    try {
      const run = runBundle(root, ["hello", "--preflight"]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        `tools/echo/map.ts: changed after the runner bundles were built; ${REBUILD_DIST}`,
      );
    } finally {
      writeFileSync(file, before);
    }
  }, 60_000);
});

describe("the bundle manifest check", () => {
  let root: string;
  beforeAll(async () => {
    root = await bundledCopy();
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function problems(): string[] {
    return manifestProblems(root).map(formatProblem);
  }

  function edited(file: string, change: (path: string) => void): () => void {
    const path = join(root, file);
    const before = existsSync(path) ? readFileSync(path) : undefined;
    change(path);
    return () =>
      before === undefined
        ? rmSync(path, { recursive: true, force: true })
        : writeFileSync(path, before);
  }

  it("names a changed lockfile, a hand-edited bundle and a missing one", () => {
    const undo = [
      edited("pnpm-lock.yaml", (p) => appendFileSync(p, "\n")),
      edited(RUNNER_BUNDLE, (p) => appendFileSync(p, "\n")),
      edited("dist/jobs/bundle-demo/collect.mjs", (p) => rmSync(p)),
    ];
    try {
      expect(problems()).toEqual([
        `pnpm-lock.yaml: changed after the runner bundles were built; ${REBUILD_DIST}`,
        `dist/jobs/bundle-demo/collect.mjs: is missing; ${REBUILD_DIST}`,
        `dist/run-job.mjs: is not the bundle the manifest names; ${REBUILD_DIST}`,
      ]);
    } finally {
      for (const u of undo) u();
    }
    expect(problems()).toEqual([]);
  });

  it("names a tool mapping and a job script the bundles do not have yet", () => {
    const undo = [
      edited("tools/newer", (p) => {
        mkdirSync(p);
        writeFileSync(join(p, "map.ts"), "export default {};\n");
      }),
      edited("jobs/hello/render.ts", (p) => writeFileSync(p, "")),
    ];
    try {
      expect(problems()).toEqual([
        `tools/newer/map.ts: is not in the runner bundles; ${REBUILD_DIST}`,
        `jobs/hello/render.ts: has no bundle in dist/; ${REBUILD_DIST}`,
      ]);
    } finally {
      for (const u of undo) u();
    }
  });

  it("leaves the committed dist/ to main: flax agents check takes a stale bundle and a stray file, and refuses only bundles that do not build", async () => {
    linkKitNodeModules(root);
    const undo = [
      edited("dist/jobs/bundle-demo/collect.mjs", (p) =>
        appendFileSync(p, "\n"),
      ),
      edited("dist/stray.txt", (p) => writeFileSync(p, "")),
    ];
    try {
      expect(await bundleProblems(root)).toEqual([]);
      undo.push(
        edited("jobs/hello/render.ts", (p) =>
          writeFileSync(p, 'import "no-such-package";\n'),
        ),
      );
      const problems = (await bundleProblems(root)).map(formatProblem);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(
        /^dist: the runner bundles do not build: .*no-such-package/s,
      );
    } finally {
      for (const u of undo) u();
      rmSync(join(root, "node_modules"), { recursive: true, force: true });
    }
  });

  it("stops at a missing manifest", () => {
    const undo = edited(BUNDLE_MANIFEST, (p) => rmSync(p));
    try {
      expect(problems()).toEqual([
        `dist/manifest.json: is missing; ${REBUILD_DIST}`,
      ]);
    } finally {
      undo();
    }
  });
});
