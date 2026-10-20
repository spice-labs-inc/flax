import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parse } from "yaml";
import { manifestProblems } from "../src/bundle/manifest.ts";
import { generateOptions } from "../src/generate/generate.ts";
import { KIT_ROOT, RUNNER_BUNDLE } from "../src/lib/paths.ts";
import { FIXTURE_WORKSPACE, linkKitNodeModules } from "./helpers.ts";

const FIXTURE = "packages/agents/test/fixtures/workspace";
/** How the kit workflows run the kit's own command line: from source, no install step. */
const KIT_CLI = "pnpm -C packages/agents exec node bin/flax-agents.mjs";
const GENERATE_FIXTURE = `${KIT_CLI} generate --workspace test/fixtures/workspace`;
const GENERATE_DIST = `${KIT_CLI} generate --dist --workspace test/fixtures/workspace`;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agents-${prefix}`));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function write(root: string, file: string, content: string): void {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), content);
}

/** Runs a workflow step's script as GitHub runs a bash step. */
function runStep(
  script: string,
  cwd: string,
  env: Record<string, string>,
  path = process.env.PATH!,
) {
  return spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
    {
      cwd,
      encoding: "utf8",
      env: { PATH: path, ...GIT_ENV, ...env },
    },
  );
}

function workflow(file: string): Record<string, any> {
  return parse(readFileSync(join(KIT_ROOT, "workflows", file), "utf8"));
}

function step(steps: Record<string, any>[], name: string): Record<string, any> {
  const found = steps.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no step named ${name}`);
  return found;
}

/** The steps every kit workflow starts with: a checkout without credentials, pnpm, Node, install, build. */
const SETUP = [
  "actions/checkout@v5",
  "pnpm/action-setup@v6",
  "actions/setup-node@v6",
  "pnpm install --frozen-lockfile",
  "pnpm -r build",
];

describe("flax agents generate", () => {
  it("takes --dist and nothing else", () => {
    expect(generateOptions([])).toEqual({ dist: false });
    expect(generateOptions(["--dist"])).toEqual({ dist: true });
    expect(() => generateOptions(["--dist", "--all"])).toThrow(
      "flax agents generate takes only --dist, not --all",
    );
  });

  it("leaves dist/ alone, and rebuilds it only with --dist", () => {
    const root = tempDir("generate-");
    cpSync(FIXTURE_WORKSPACE, root, { recursive: true, dereference: true });
    linkKitNodeModules(root);
    const generate = (...args: string[]) =>
      spawnSync(
        join(KIT_ROOT, "node_modules", ".bin", "tsx"),
        [join(KIT_ROOT, "src/generate/cli.ts"), "--workspace", root, ...args],
        { cwd: tempDir("generate-cwd-"), encoding: "utf8", timeout: 120_000 },
      );
    const plain = generate();
    expect(plain.status, plain.stderr).toBe(0);
    expect(existsSync(join(root, ".github/workflows/job-hello.yml"))).toBe(true);
    expect(existsSync(join(root, "dist"))).toBe(false);
    const refused = generate("--bundles");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toBe(
      "flax agents generate takes only --dist, not --bundles\n",
    );
    const dist = generate("--dist");
    expect(dist.status, dist.stderr).toBe(0);
    expect(dist.stdout).toContain(`wrote ${RUNNER_BUNDLE}`);
    expect(manifestProblems(root)).toEqual([]);
  }, 120_000);
});

describe("the Check workflow", () => {
  const steps = (): Record<string, any>[] =>
    workflow("check.yml").jobs.check.steps;

  it("runs on pull requests and pushes to main that touch the kit, with read access only", () => {
    const doc = workflow("check.yml");
    const paths = ["packages/agents/**", "pnpm-lock.yaml"];
    expect(doc.on).toEqual({
      pull_request: { paths },
      push: { branches: ["main"], paths },
    });
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(doc.jobs.check["runs-on"]).toBe("ubuntu-24.04");
  });

  it("installs, checks and generates the fixture workspace, then typechecks and tests the kit", () => {
    const all = steps();
    expect(all[0]!.with).toEqual({ "persist-credentials": false });
    expect(all.map((s) => s.name ?? s.uses ?? s.run)).toEqual([
      ...SETUP,
      "pnpm -C packages/agents exec playwright install --with-deps chromium",
      "Check the fixture workspace",
      "Generate the fixture workspace",
      "Keep the fixture's generated files current",
      "pnpm -C packages/agents typecheck",
      "pnpm -C packages/agents test",
    ]);
    expect(step(all, "Check the fixture workspace").run).toBe(
      `${KIT_CLI} check --workspace test/fixtures/workspace`,
    );
    expect(step(all, "Generate the fixture workspace").run).toBe(GENERATE_FIXTURE);
    // The kit commits no workspace's dist, so nothing here builds one.
    expect(JSON.stringify(all)).not.toContain("--dist");
    expect(readFileSync(join(KIT_ROOT, "workflows/check.yml"), "utf8")).not.toMatch(
      /secrets\.|github\.token/,
    );
  });

  /** A kit checkout whose fixture workspace is committed, then changed by `change`. */
  function checkedOut(change: (root: string) => void) {
    const root = tempDir("check-fixture-");
    git(root, "init", "-q", "-b", "main");
    write(root, `${FIXTURE}/jobs/hello/job.yml`, "name: hello\n");
    write(root, `${FIXTURE}/.github/workflows/job-hello.yml`, "name: job-hello\n");
    write(root, "packages/agents/src/a.ts", "export {};\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    change(root);
    return runStep(step(steps(), "Keep the fixture's generated files current").run, root, {});
  }

  it("passes when generating left the fixture's committed files as they are", () => {
    const run = checkedOut((root) => write(root, "packages/agents/src/a.ts", "export const a = 1;\n"));
    expect(run.status, run.stdout).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("fails, naming the files, when generating changed what the fixture commits", () => {
    const run = checkedOut((root) =>
      write(root, `${FIXTURE}/.github/workflows/job-hello.yml`, "name: job-hello\nchanged: true\n"),
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(`${FIXTURE}/.github/workflows/job-hello.yml`);
    expect(run.stdout).toContain(
      "::error::the fixture workspace's generated files are stale; run node bin/flax-agents.mjs generate --workspace test/fixtures/workspace and commit the result",
    );
  });
});

describe("the Rebuild dist workflow", () => {
  const job = (): Record<string, any> =>
    workflow("rebuild-dist.yml").jobs.rebuild;

  it("runs after each push to main that touches the kit, one run at a time, with read access only", () => {
    const doc = workflow("rebuild-dist.yml");
    expect(doc.on).toEqual({
      push: { branches: ["main"], paths: ["packages/agents/**", "pnpm-lock.yaml"] },
      workflow_dispatch: {},
    });
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(doc.concurrency).toEqual({
      group: "rebuild-dist",
      "cancel-in-progress": false,
    });
    expect(job()["runs-on"]).toBe(workflow("check.yml").jobs.check["runs-on"]);
    const text = readFileSync(join(KIT_ROOT, "workflows/rebuild-dist.yml"), "utf8");
    // Nothing is pushed: the kit commits no workspace's dist.
    expect(text).not.toMatch(/secrets\.|github\.token|git push|git commit/);
  });

  it("builds the fixture's dist twice from install and generate --dist alone, and compares", () => {
    const steps: Record<string, any>[] = job().steps;
    expect(steps[0]!.with).toEqual({ "persist-credentials": false });
    expect(steps.map((s) => s.name ?? s.uses ?? s.run)).toEqual([
      ...SETUP,
      "Build the fixture workspace's dist",
      "Build it again from nothing and compare",
    ]);
    expect(step(steps, "Build the fixture workspace's dist").run).toBe(GENERATE_DIST);
    const again = step(steps, "Build it again from nothing and compare").run;
    expect(again).toContain(`rm -rf "$fixture/dist"`);
    expect(again).toContain(GENERATE_DIST);
  });

  /**
   * A checkout whose fixture dist/ holds the first build, with a fake pnpm
   * first on PATH that answers the second build with the files in next/.
   */
  function rebuilt(first: Record<string, string>, second: Record<string, string>) {
    const root = tempDir("rebuild-dist-");
    for (const [file, content] of Object.entries(first))
      write(root, `${FIXTURE}/dist/${file}`, content);
    for (const [file, content] of Object.entries(second))
      write(root, `next/${file}`, content);
    const bin = join(root, "fake-bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "pnpm"),
      `#!/usr/bin/env bash\nset -eu\nprintf '%s\\n' "pnpm $*" >> ${JSON.stringify(join(root, "calls.log"))}\nmkdir -p ${JSON.stringify(join(root, FIXTURE, "dist"))}\ncp -R ${JSON.stringify(join(root, "next"))}/. ${JSON.stringify(join(root, FIXTURE, "dist"))}/\n`,
    );
    chmodSync(join(bin, "pnpm"), 0o755);
    const summary = join(root, "summary.md");
    writeFileSync(summary, "");
    mkdirSync(join(root, "runner-temp"), { recursive: true });
    const run = runStep(
      step(job().steps, "Build it again from nothing and compare").run,
      root,
      {
        RUNNER_TEMP: join(root, "runner-temp"),
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      },
      `${bin}:${process.env.PATH}`,
    );
    return {
      ...run,
      calls: existsSync(join(root, "calls.log")) ? readFileSync(join(root, "calls.log"), "utf8") : "",
      summary: readFileSync(summary, "utf8"),
    };
  }

  const MANIFEST = JSON.stringify({
    kit: { name: "@flax/agents", version: "0.0.1" },
    files: { "run-job.mjs": "ab".repeat(32) },
    sources: { "jobs/hello/job.yml": "cd".repeat(32) },
  });

  it("passes, and summarizes the manifest without its sources, when both builds are the same bytes", () => {
    const dist = { "run-job.mjs": "first\n", "manifest.json": MANIFEST };
    const run = rebuilt(dist, dist);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.calls).toBe(`${GENERATE_DIST}\n`);
    expect(run.summary).toContain("### dist rebuilt twice for 0123456789ab, identical");
    expect(run.summary).toContain('kit: {"name":"@flax/agents","version":"0.0.1"}');
    expect(run.summary).toContain('files: {"run-job.mjs":');
    expect(run.summary).not.toContain("sources");
  });

  it("fails when the second build differs from the first", () => {
    const run = rebuilt(
      { "run-job.mjs": "first\n", "manifest.json": MANIFEST },
      { "run-job.mjs": "second\n", "manifest.json": MANIFEST },
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      "::error::two builds of dist/ from the same sources differ; a workspace's rebuilt dist would never match its manifest",
    );
    expect(run.summary).toBe("");
  });
});
