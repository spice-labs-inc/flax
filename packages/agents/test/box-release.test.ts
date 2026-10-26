import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it, onTestFinished } from "vitest";
import { parse } from "yaml";
import { releasePinText } from "../src/box-release/pin.ts";
import {
  NOTES_BEGIN,
  NOTES_END,
  parseReleaseNotes,
  parseSha256File,
  resolveRelease,
  type Exec,
  type ExecResult,
} from "../src/box-release/release.ts";
import { boxRepository } from "../src/generate/render.ts";
import { BOX_RELEASE_PATTERN, LBX_BINARY, loadBox } from "../src/lib/box.ts";
import { format } from "../src/lib/format.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { BOX, makeRepo } from "./helpers.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const TAG = "v0.1.0";
/** What the fake release attaches as its launcher binary: a script that answers --help. */
const BINARY = '#!/bin/sh\n[ "$1" = --help ] && echo usage\nexit 0\n';
const SHA256 = createHash("sha256").update(BINARY).digest("hex");
/** The release's .sha256 asset, as sha256sum writes it. */
const SHA256_FILE = `${SHA256}  ${LBX_BINARY}\n`;

/** The block exactly as the sandbox's release workflow writes it (its docs/releasing.md). */
function block(commit = COMMIT, binary = LBX_BINARY): string {
  return [
    NOTES_BEGIN,
    "## Release artifacts",
    "",
    `- Commit: \`${commit}\``,
    `- Binary: ${binary} (sha256 in ${binary}.sha256)`,
    NOTES_END,
  ].join("\n");
}

function notes(inner = block()): string {
  return `## What's Changed\n* lbx --run by @someone in #4\n\n${inner}\n`;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("the release notes block", () => {
  it("gives the commit and the binary", () => {
    expect(parseReleaseNotes(notes())).toEqual({
      ok: true,
      value: { commit: COMMIT, binary: LBX_BINARY },
    });
  });

  it("names the default binary when the block has no Binary line, and takes backticks", () => {
    const bare = [NOTES_BEGIN, `- Commit: ${COMMIT}`, NOTES_END].join("\n");
    expect(parseReleaseNotes(bare)).toEqual({
      ok: true,
      value: { commit: COMMIT, binary: LBX_BINARY },
    });
    const ticked = [
      NOTES_BEGIN,
      `- Commit: \`${COMMIT}\``,
      "- Binary: `lbx-aarch64-unknown-linux-musl`",
      NOTES_END,
    ].join("\n");
    expect(parseReleaseNotes(ticked)).toEqual({
      ok: true,
      value: { commit: COMMIT, binary: "lbx-aarch64-unknown-linux-musl" },
    });
  });

  it("reads notes with carriage returns", () => {
    expect(parseReleaseNotes(notes().replaceAll("\n", "\r\n"))).toEqual({
      ok: true,
      value: { commit: COMMIT, binary: LBX_BINARY },
    });
  });

  it("keeps the values whatever the person wrote around the block", () => {
    const marker = fc.constantFrom(NOTES_BEGIN, NOTES_END);
    const line = fc
      .string({ maxLength: 60 })
      .map((s) => s.replaceAll(/[\r\n]/g, ""))
      .filter((s) => s !== NOTES_BEGIN && s !== NOTES_END);
    const text = fc.array(line, { maxLength: 8 }).map((l) => l.join("\n"));
    fc.assert(
      fc.property(text, text, fc.boolean(), (before, after, crlf) => {
        const body = `${before}\n${block()}\n${after}`;
        const result = parseReleaseNotes(
          crlf ? body.replaceAll("\n", "\r\n") : body,
        );
        expect(result).toEqual({
          ok: true,
          value: { commit: COMMIT, binary: LBX_BINARY },
        });
      }),
    );
    fc.assert(
      fc.property(text, marker, (before, extra) => {
        expect(parseReleaseNotes(`${before}\n${block()}\n${extra}\n`).ok).toBe(
          extra === NOTES_END,
        );
      }),
    );
  });

  it.each<[string, string, RegExp]>([
    ["no block", "## What's Changed\n", /no <!-- llm-in-a-box release: begin/],
    [
      "a block with no end line",
      `${NOTES_BEGIN}\n- Commit: \`${COMMIT}\`\n- Binary: ${LBX_BINARY}\n`,
      /no <!-- llm-in-a-box release: end/,
    ],
    [
      "two blocks",
      `${block()}\n${block()}`,
      /2 <!-- llm-in-a-box release: begin/,
    ],
    [
      "no commit line",
      block().replace(/- Commit.*\n/, ""),
      /exactly one "- Commit/,
    ],
    ["a short commit", block("0123456789ab"), /exactly one "- Commit/],
    [
      "two commit lines",
      block().replace(NOTES_END, `- Commit: \`${OTHER_COMMIT}\`\n${NOTES_END}`),
      /found 2/,
    ],
    [
      "two binary lines",
      block().replace(NOTES_END, `- Binary: other\n${NOTES_END}`),
      /2 "- Binary:" lines/,
    ],
    [
      "the values only outside the block",
      `- Commit: \`${COMMIT}\`\n- Binary: ${LBX_BINARY}\n${NOTES_BEGIN}\n${NOTES_END}`,
      /exactly one "- Commit/,
    ],
  ])("refuses %s", (_, body, error) => {
    const result = parseReleaseNotes(body);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(error);
  });
});

describe("the release's .sha256 file", () => {
  it("gives the sum of the binary, whatever else the file lists", () => {
    expect(parseSha256File(SHA256_FILE, LBX_BINARY)).toEqual({
      ok: true,
      value: SHA256,
    });
    const several = `${"ab".repeat(32)}  other\r\n${SHA256} *${LBX_BINARY}\r\n`;
    expect(parseSha256File(several, LBX_BINARY)).toEqual({
      ok: true,
      value: SHA256,
    });
  });

  it("refuses a file that names no sum for the binary", () => {
    for (const text of [
      "",
      `${"ab".repeat(32)}  other\n`,
      `abc  ${LBX_BINARY}\n`,
    ]) {
      const result = parseSha256File(text, LBX_BINARY);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatch(/names no sha256 for/);
    }
  });
});

/** A stand-in for gh: the notes and the .sha256 file it answers, and every call it got. */
function fakeExec(answers: { notes?: ExecResult; sums?: ExecResult }): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "gh" && args[1] === "view")
      return answers.notes ?? { code: 0, stdout: notes(), stderr: "" };
    if (file === "gh" && args[1] === "download")
      return answers.sums ?? { code: 0, stdout: SHA256_FILE, stderr: "" };
    return { code: 127, stdout: "", stderr: `${file}: not found` };
  };
  return { exec, calls };
}

const VIEW_CALL = [
  "gh",
  "release",
  "view",
  TAG,
  "--repo",
  boxRepository(),
  "--json",
  "body",
  "--jq",
  ".body",
];
const DOWNLOAD_CALL = [
  "gh",
  "release",
  "download",
  TAG,
  "--repo",
  boxRepository(),
  "--pattern",
  `${LBX_BINARY}.sha256`,
  "--output",
  "-",
];

describe("resolving a release", () => {
  it("reads the notes and the checksum file, and gives the commit, the binary and its sha256", async () => {
    const { exec, calls } = fakeExec({});
    expect(
      await resolveRelease({ tag: TAG, checkoutCommit: COMMIT, exec }),
    ).toEqual({
      ok: true,
      value: {
        commit: COMMIT,
        binary: LBX_BINARY,
        sha256: SHA256,
        notes: notes(),
      },
    });
    expect(calls).toEqual([VIEW_CALL, DOWNLOAD_CALL]);
  });

  it("needs no checked out commit", async () => {
    const { exec } = fakeExec({});
    const result = await resolveRelease({ tag: TAG, exec });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.commit).toBe(COMMIT);
  });

  it("refuses a malformed tag before calling anything", async () => {
    const { exec, calls } = fakeExec({});
    for (const tag of ["main", "v1.2", "v01.2.3", "v1.2.3\n"]) {
      const result = await resolveRelease({
        tag,
        checkoutCommit: COMMIT,
        exec,
      });
      expect(result.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("refuses notes naming another commit than the tag checks out, before downloading anything", async () => {
    const { exec, calls } = fakeExec({});
    const result = await resolveRelease({
      tag: TAG,
      checkoutCommit: OTHER_COMMIT,
      exec,
    });
    expect(result).toEqual({
      ok: false,
      error: `the release notes name commit ${COMMIT}, but tag ${TAG} checks out ${OTHER_COMMIT}`,
    });
    expect(calls).toEqual([VIEW_CALL]);
  });

  it.each<[string, { notes?: ExecResult; sums?: ExecResult }, RegExp]>([
    [
      "notes that cannot be read",
      { notes: { code: 1, stdout: "", stderr: "release not found\n" } },
      /reading the notes of spice-labs-inc\/lbx release v0\.1\.0 failed \(exit 1\): release not found/,
    ],
    [
      "notes without the block",
      { notes: { code: 0, stdout: "## What's Changed\n", stderr: "" } },
      /no <!-- llm-in-a-box release: begin/,
    ],
    [
      "a checksum file that cannot be downloaded",
      { sums: { code: 1, stdout: "", stderr: "asset not found\n" } },
      /downloading lbx-x86_64-unknown-linux-musl\.sha256 of spice-labs-inc\/lbx release v0\.1\.0 failed \(exit 1\): asset not found/,
    ],
    [
      "a checksum file that names no sum for the binary",
      { sums: { code: 0, stdout: `${"ab".repeat(32)}  other\n`, stderr: "" } },
      /names no sha256 for lbx-x86_64-unknown-linux-musl/,
    ],
  ])("refuses %s", async (_, answers, error) => {
    const { exec } = fakeExec(answers);
    const result = await resolveRelease({
      tag: TAG,
      checkoutCommit: COMMIT,
      exec,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(error);
  });
});

/**
 * A fake gh first on PATH, answering `release view` with the notes, `api
 * repos/<repo>/commits/<tag>` with the tagged commit, and `release download`
 * with the binary and its .sha256 file (to --dir, or --output - for one).
 * Every call is appended to calls.log in the directory.
 */
function fakeGh(
  dir: string,
  fake: { notes?: string; tagged?: string; binary?: string } = {},
): string {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, "notes.txt"), fake.notes ?? notes());
  writeFileSync(join(dir, "tagged.txt"), `${fake.tagged ?? COMMIT}\n`);
  const binary = fake.binary ?? BINARY;
  writeFileSync(join(dir, "binary.bin"), binary);
  writeFileSync(
    join(dir, "binary.sha256"),
    `${createHash("sha256").update(binary).digest("hex")}  ${LBX_BINARY}\n`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
set -eu
here=${JSON.stringify(dir)}
printf '%s\\n' "gh $*" >> "$here/calls.log"
case "$1 \${2:-}" in
  "release view") cat "$here/notes.txt" ;;
  "api "*) cat "$here/tagged.txt" ;;
  "release download")
    dir=""; out=""; patterns=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --dir) dir="$2"; shift ;;
        --output) out="$2"; shift ;;
        --pattern) patterns+=("$2"); shift ;;
      esac
      shift
    done
    for p in "\${patterns[@]}"; do
      case "$p" in
        *.sha256) src="$here/binary.sha256" ;;
        *) src="$here/binary.bin" ;;
      esac
      if [ "$out" = "-" ]; then cat "$src"; else cp "$src" "$dir/$p"; fi
    done ;;
  *) echo "fake gh: unexpected $*" >&2; exit 64 ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

function ghCalls(dir: string): string {
  const log = join(dir, "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

/** Runs flax agents box-release with the fake gh first on PATH. */
function boxRelease(
  cwd: string,
  args: string[],
  fake: { notes?: string } = {},
) {
  const bin = fakeGh(cwd, fake);
  const result = spawnSync(
    join(KIT_ROOT, "node_modules", ".bin", "tsx"),
    [join(KIT_ROOT, "src", "box-release", "cli.ts"), ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    },
  );
  return { ...result, calls: ghCalls(cwd) };
}

describe("flax agents box-release", () => {
  it("resolve prints the step outputs and keeps the whole notes", () => {
    const dir = makeRepo();
    const out = join(dir, "notes.md");
    const result = boxRelease(dir, [
      "resolve",
      "--release",
      TAG,
      "--commit",
      COMMIT,
      "--notes-out",
      out,
    ]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `commit=${COMMIT}\nbinary=${LBX_BINARY}\nsha256=${SHA256}\n`,
    );
    expect(readFileSync(out, "utf8")).toBe(notes());
    expect(result.calls).toBe(
      [
        `gh release view ${TAG} --repo ${boxRepository()} --json body --jq .body`,
        `gh release download ${TAG} --repo ${boxRepository()} --pattern ${LBX_BINARY}.sha256 --output -`,
        "",
      ].join("\n"),
    );
  });

  it("resolve fails, and writes no notes, when the notes name another commit", () => {
    const dir = makeRepo();
    const out = join(dir, "notes.md");
    const result = boxRelease(dir, [
      "resolve",
      "--release",
      TAG,
      "--commit",
      OTHER_COMMIT,
      "--notes-out",
      out,
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/but tag v0\.1\.0 checks out/);
    expect(existsSync(out)).toBe(false);
  });

  it("pin writes a box.yml that passes its check, formatted as committed", async () => {
    const dir = makeRepo({ box: null });
    const image = `ghcr.io/notes-co/flax-agent@sha256:${"ab".repeat(32)}`;
    const result = boxRelease(dir, [
      "pin",
      "--release",
      TAG,
      "--commit",
      COMMIT,
      "--sha256",
      SHA256,
      "--image",
      image,
      "--run-id",
      "123",
    ]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const text = readFileSync(join(dir, "box.yml"), "utf8");
    expect(await format(text, { parser: "yaml" })).toBe(text);
    expect(text).toContain('the "Publish image" run 123');
    const expected = {
      pinned: true,
      box_release: TAG,
      box_commit: COMMIT,
      lbx_sha256: SHA256,
      image,
    };
    expect(parse(text)).toEqual(expected);
    expect(loadBox(dir)).toEqual({ box: expected, problems: [] });
    expect(result.calls).toBe("");
  });

  it("pin writes the four pinned values only, whatever the box.yml it replaces had", () => {
    const dir = makeRepo({
      box: { ...BOX, sockets: true, relay: "ghcr.io/notes-co/relay:1" },
    });
    const result = boxRelease(dir, [
      "pin",
      "--release",
      TAG,
      "--commit",
      COMMIT,
      "--sha256",
      SHA256,
      "--image",
      BOX.image,
    ]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const box = loadBox(dir).box!;
    expect(box.box_release).toBe(TAG);
    expect(Object.keys(box).sort()).toEqual([
      "box_commit",
      "box_release",
      "image",
      "lbx_sha256",
      "pinned",
    ]);
  });

  it("pin refuses values box.yml would refuse, and writes nothing", async () => {
    const good = {
      box_release: TAG,
      box_commit: COMMIT,
      lbx_sha256: "9f".repeat(32),
      image: `ghcr.io/notes-co/flax-agent@sha256:${"ab".repeat(32)}`,
    };
    expect((await releasePinText(good)).ok).toBe(true);
    for (const bad of [
      { box_release: "v1.2" },
      { box_commit: "0123" },
      { lbx_sha256: "9f".repeat(31) },
      { image: "" },
    ]) {
      expect((await releasePinText({ ...good, ...bad })).ok).toBe(false);
    }
    const dir = makeRepo({ box: null });
    const result = boxRelease(dir, [
      "pin",
      "--release",
      TAG,
      "--commit",
      COMMIT,
      "--sha256",
      SHA256,
      "--image",
      "lbx:docker",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /refusing to write box\.yml: box\.yml: image:/,
    );
    expect(existsSync(join(dir, "box.yml"))).toBe(false);
  });

  it("pin needs every value", () => {
    const dir = makeRepo({ box: null });
    const result = boxRelease(dir, [
      "pin",
      "--release",
      TAG,
      "--commit",
      COMMIT,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/missing --sha256, --image/);
    expect(existsSync(join(dir, "box.yml"))).toBe(false);
  });
});

/** Runs a workflow step's script as GitHub runs a bash step, with the fake gh on PATH. */
function runStep(
  script: string,
  dir: string,
  env: Record<string, string>,
  fake: { notes?: string; tagged?: string } = {},
  cwd = dir,
) {
  const bin = fakeGh(dir, fake);
  const runnerTemp = join(dir, "runner-temp");
  mkdirSync(runnerTemp, { recursive: true });
  const githubPath = join(dir, "github-path");
  writeFileSync(githubPath, "");
  const githubOutput = join(dir, "github-output");
  writeFileSync(githubOutput, "");
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
    {
      cwd,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp,
        GITHUB_PATH: githubPath,
        GITHUB_OUTPUT: githubOutput,
        ...env,
      },
    },
  );
  return {
    ...result,
    calls: ghCalls(dir),
    githubPath: readFileSync(githubPath, "utf8"),
    outputs: readFileSync(githubOutput, "utf8"),
  };
}

function kitWorkflow(name: string): Record<string, any> {
  return parse(readFileSync(join(KIT_ROOT, "workflows", name), "utf8"));
}

function kitWorkflowText(name: string): string {
  return readFileSync(join(KIT_ROOT, "workflows", name), "utf8");
}

const byName = (steps: Record<string, any>[], name: string) =>
  steps.find((s) => s.name === name)!;

describe("the Publish image workflow", () => {
  const workflow = () => kitWorkflow("publish-image.yml");

  it("takes a sandbox release tag and nothing else", () => {
    expect(workflow().on).toEqual({
      workflow_dispatch: {
        inputs: {
          box_release: {
            description: "Sandbox (lbx) release tag vX.Y.Z",
            required: true,
            type: "string",
          },
        },
      },
    });
    expect(workflow().env).toEqual({
      AGENT_IMAGE: "ghcr.io/${{ github.repository_owner }}/flax-agent",
      BOX_REPO: boxRepository(),
      BOX_RELEASE: "${{ inputs.box_release }}",
      LBX_BINARY,
    });
  });

  it("refuses a malformed box_release in its first step", () => {
    const first = workflow().jobs.publish.steps[0];
    expect(first.name).toBe("Check the release tag");
    const accepts = (tag: string) =>
      runStep(first.run, tempDir("publish-"), { BOX_RELEASE: tag }).status ===
      0;
    for (const tag of ["v0.0.0", "v0.1.0", "v10.20.30"])
      expect(accepts(tag)).toBe(true);
    for (const tag of [
      "",
      "main",
      "0.1.0",
      "v0.1",
      "v01.1.0",
      "v0.1.0-rc.1",
      "v0.1.0+build",
      " v0.1.0",
      "v0.1.0\n",
      "v0.1.0\nv0.1.0",
      "v٠.1.0",
      "v0.1.0; true",
    ])
      expect(accepts(tag), JSON.stringify(tag)).toBe(false);
    const release = fc
      .tuple(fc.nat(), fc.nat(), fc.nat())
      .map((n) => `v${n.join(".")}`);
    const near = fc.oneof(
      release,
      release.map((t) => `${t}-rc.1`),
      release.map((t) => t.replace("v", "v0")),
      fc.string({ maxLength: 12 }),
    );
    fc.assert(
      fc.property(near, (tag) => {
        expect(accepts(tag)).toBe(BOX_RELEASE_PATTERN.test(tag));
      }),
      { numRuns: 40 },
    );
  });

  it("reads the release notes and requires their commit to be the one the tag names", () => {
    const read = byName(workflow().jobs.publish.steps, "Read the release");
    expect(read.id).toBe("release");
    expect(read.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    const env = { BOX_RELEASE: TAG, BOX_REPO: boxRepository() };
    const good = runStep(read.run, tempDir("publish-"), env);
    expect(good.stderr).toBe("");
    expect(good.status).toBe(0);
    expect(good.outputs).toBe(`commit=${COMMIT}\n`);
    expect(good.calls).toBe(
      [
        `gh release view ${TAG} --repo ${boxRepository()} --json body --jq .body`,
        `gh api repos/${boxRepository()}/commits/${TAG} --jq .sha`,
        "",
      ].join("\n"),
    );
    const other = runStep(read.run, tempDir("publish-"), env, {
      tagged: OTHER_COMMIT,
    });
    expect(other.status).toBe(1);
    expect(other.stdout).toContain(
      `::error::the release notes name commit ${COMMIT}, but tag ${TAG} names ${OTHER_COMMIT}`,
    );
    const none = runStep(read.run, tempDir("publish-"), env, {
      notes: "## What's Changed\n",
    });
    expect(none.status).toBe(1);
    expect(none.stdout).toContain("need exactly one '- Commit: <40 hex>' line");
    expect(none.outputs).toBe("");
  });

  it("downloads the release binary with its checksum file, verifies and runs it", () => {
    const step = byName(
      workflow().jobs.publish.steps,
      "Download and verify the release binary",
    );
    expect(step.id).toBe("binary");
    expect(step.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    const dir = tempDir("publish-");
    const result = runStep(step.run, dir, {
      BOX_RELEASE: TAG,
      BOX_REPO: boxRepository(),
      LBX_BINARY,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.calls).toBe(
      `gh release download ${TAG} --repo ${boxRepository()} --dir ${join(dir, "runner-temp", "lbx-release")} --pattern ${LBX_BINARY} --pattern ${LBX_BINARY}.sha256\n`,
    );
    expect(result.outputs).toBe(
      `sha256=${SHA256}\npath=${join(dir, "runner-temp", "lbx-release", LBX_BINARY)}\n`,
    );
  });

  it("builds from the tagged entrypoint, smoke runs the image with no network, and pins nothing", () => {
    const text = kitWorkflowText("publish-image.yml");
    expect(text).not.toMatch(
      /relay|RELAY|box_ref|net-policy|create-pull-request|box-release pin/,
    );
    const job = workflow().jobs.publish;
    expect(job.permissions).toEqual({ contents: "read", packages: "write" });
    const steps: Record<string, any>[] = job.steps;
    const source = byName(steps, "Take entrypoint.sh from the tagged source");
    expect(source.env.COMMIT).toBe("${{ steps.release.outputs.commit }}");
    expect(source.run).toContain(
      'gh api "repos/$BOX_REPO/tarball/$BOX_RELEASE"',
    );
    const build = byName(steps, "Build and push the agent image");
    expect(build.id).toBe("build");
    expect(build.env).toEqual({
      COMMIT: "${{ steps.release.outputs.commit }}",
      ENTRYPOINT: "${{ steps.source.outputs.entrypoint }}",
    });
    expect(build.run).toContain('build_tag="$BOX_RELEASE-${GITHUB_SHA::12}"');
    expect(build.run).toContain(
      'pnpm -C packages/agents exec node bin/flax-agents.mjs bundle-pi-plugin "$context/pi-mcp-mailbox.mjs"',
    );
    expect(build.run).toContain('--build-arg "BOX_COMMIT=$COMMIT"');
    const smoke = byName(steps, "Smoke run through lbx --run");
    expect(smoke.env).toEqual({
      AGENT_REF: "${{ steps.build.outputs.image }}",
      LBX: "${{ steps.binary.outputs.path }}",
    });
    expect(smoke.run).toContain("--no-network");
    expect(smoke.run).toContain('"$LBX" --run --runtime docker');
    const summary = byName(steps, "Summary");
    expect(summary.env).toEqual({
      COMMIT: "${{ steps.release.outputs.commit }}",
      LBX_SHA256: "${{ steps.binary.outputs.sha256 }}",
      TAG: "${{ steps.build.outputs.tag }}",
      AGENT_REF: "${{ steps.build.outputs.image }}",
    });
    for (const line of [
      'echo "pinned: true"',
      'echo "box_release: \\"$BOX_RELEASE\\""',
      'echo "box_commit: \\"$COMMIT\\""',
      'echo "lbx_sha256: \\"$LBX_SHA256\\""',
      'echo "image: $AGENT_REF"',
    ])
      expect(summary.run).toContain(line);
    const names = steps.map((s) => s.name ?? s.uses ?? s.run);
    const order = [
      "Check the release tag",
      "Read the release",
      "Download and verify the release binary",
      "Take entrypoint.sh from the tagged source",
      "Build and push the agent image",
      "Smoke run through lbx --run",
      "Summary",
    ];
    for (let i = 1; i < order.length; i++)
      expect(names.indexOf(order[i]!)).toBeGreaterThan(
        names.indexOf(order[i - 1]!),
      );
  });
});

/** The fixture's box.yml as the Box test and Network refusal workflows read it into step outputs. */
const FIXTURE_BOX = parse(
  readFileSync(join(KIT_ROOT, "test/fixtures/workspace/box.yml"), "utf8"),
);

describe.each(["box-test.yml", "net-refusal.yml"])(
  "the pinned box check of %s",
  (file) => {
    const steps = (): Record<string, any>[] =>
      Object.values<Record<string, any>>(kitWorkflow(file).jobs)[0]!.steps;

    it("reads the four pinned values of the fixture's box.yml into step outputs", () => {
      expect(kitWorkflow(file).env).toEqual({
        BOX_REPO: boxRepository(),
        LBX_BINARY,
      });
      const read = byName(steps(), "Read the pinned box");
      expect(read.id).toBe("box");
      expect(read["working-directory"]).toBe("packages/agents");
      const result = runStep(read.run, tempDir("box-test-"), {}, {}, KIT_ROOT);
      expect(result.status).toBe(0);
      expect(result.outputs).toBe(
        `box_release=${FIXTURE_BOX.box_release}\nbox_commit=${FIXTURE_BOX.box_commit}\nlbx_sha256=${FIXTURE_BOX.lbx_sha256}\nimage=${FIXTURE_BOX.image}\n`,
      );
    });

    it("downloads the pinned release binary, checks the notes name box_commit and the binary has lbx_sha256, and puts it on PATH", () => {
      const step = byName(
        steps(),
        "Download and verify the pinned release binary",
      );
      expect(step.env).toEqual({
        GH_TOKEN: "${{ github.token }}",
        BOX_RELEASE: "${{ steps.box.outputs.box_release }}",
        BOX_COMMIT: "${{ steps.box.outputs.box_commit }}",
        LBX_SHA256: "${{ steps.box.outputs.lbx_sha256 }}",
      });
      const env = {
        BOX_RELEASE: TAG,
        BOX_COMMIT: COMMIT,
        LBX_SHA256: SHA256,
        BOX_REPO: boxRepository(),
        LBX_BINARY,
      };
      const dir = tempDir("box-test-");
      const good = runStep(step.run, dir, env);
      expect(good.stderr).toBe("");
      expect(good.status).toBe(0);
      expect(good.githubPath).toBe(
        `${join(dir, "runner-temp", "lbx-release", "bin")}\n`,
      );
      expect(good.calls).toContain(
        `gh release download ${TAG} --repo ${boxRepository()} --dir ${join(dir, "runner-temp", "lbx-release")} --pattern ${LBX_BINARY} --pattern ${LBX_BINARY}.sha256`,
      );
      const wrongSum = runStep(step.run, tempDir("box-test-"), {
        ...env,
        LBX_SHA256: "9f".repeat(32),
      });
      expect(wrongSum.status).toBe(1);
      expect(wrongSum.stdout).toContain(
        `::error::${LBX_BINARY} of ${TAG} does not have the sha256 box.yml pins as lbx_sha256`,
      );
      expect(wrongSum.githubPath).toBe("");
      const wrongCommit = runStep(step.run, tempDir("box-test-"), {
        ...env,
        BOX_COMMIT: OTHER_COMMIT,
      });
      expect(wrongCommit.status).toBe(1);
      expect(wrongCommit.stdout).toContain(
        `::error::${boxRepository()} release ${TAG} names commit '${COMMIT}', but box.yml pins box_commit ${OTHER_COMMIT}; refusing to run`,
      );
      expect(wrongCommit.calls).not.toContain("release download");
    });

    it("pulls the pinned image after the binary, then runs against the fixture workspace", () => {
      const names = steps().map((s) => s.name ?? s.uses ?? s.run);
      const pull = byName(steps(), "Pull the pinned image");
      expect(pull.env.BOX_IMAGE).toBe("${{ steps.box.outputs.image }}");
      expect(
        names.indexOf("Download and verify the pinned release binary"),
      ).toBeLessThan(names.indexOf("Log in to ghcr.io"));
      expect(names.indexOf("Log in to ghcr.io")).toBeLessThan(
        names.indexOf("Pull the pinned image"),
      );
      const fixtureRun = steps().find(
        (s) =>
          typeof s.run === "string" &&
          s.run.includes("--workspace test/fixtures/workspace"),
      )!;
      expect(fixtureRun).toBeDefined();
      expect(names.indexOf("Pull the pinned image")).toBeLessThan(
        names.indexOf(fixtureRun.name),
      );
    });
  },
);

describe("the Box test workflow", () => {
  it("runs the hello job as a stub and smoke runs the pinned image with no network", () => {
    const steps: Record<string, any>[] =
      kitWorkflow("box-test.yml").jobs.test.steps;
    expect(byName(steps, "Run the hello job as a stub").run).toBe(
      "pnpm -C packages/agents exec node bin/flax-agents.mjs run-job hello --stub --workspace test/fixtures/workspace",
    );
    const smoke = byName(steps, "Smoke run through lbx --run");
    expect(smoke.env).toEqual({ BOX_IMAGE: "${{ steps.box.outputs.image }}" });
    expect(smoke.run).toContain("--no-network");
    expect(smoke.run).toContain("lbx --run --runtime docker");
    const pull = byName(steps, "Pull the pinned image");
    expect(pull.run).toContain("io.flax.agent-image.box-commit");
    expect(kitWorkflowText("box-test.yml")).not.toMatch(
      /relay|RELAY|git -C box|refs\/tags/,
    );
  });
});

describe("the kit action", () => {
  const action = (): Record<string, any> =>
    parse(readFileSync(join(KIT_ROOT, "action.yml"), "utf8"));

  it("takes the job, the workspace, the pinned box and the run arguments", () => {
    const inputs = action().inputs;
    expect(Object.keys(inputs).sort()).toEqual([
      "args",
      "box-image",
      "box-release",
      "box-repository",
      "box-sha256",
      "box-token",
      "job",
      "node-version",
      "provider-plugin",
      "workspace",
    ]);
    for (const name of [
      "job",
      "box-image",
      "box-repository",
      "box-release",
      "box-sha256",
    ])
      expect(inputs[name].required, name).toBe(true);
    expect(inputs["box-token"].default).toBe("");
    expect(inputs["provider-plugin"].default).toBe("");
    expect(inputs.workspace.default).toBe(".");
    expect(action().runs.using).toBe("composite");
  });

  it("refuses a pinned image whose provider plugin label is not the plugin the workspace names", () => {
    const step = byName(
      action().runs.steps,
      "Check the image carries the provider plugin",
    );
    // A docker that answers the two label reads from the environment.
    const withLabels = (plugin: string, version: string) => {
      const dir = tempDir("action-");
      const bin = join(dir, "fake-bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "docker"),
        [
          "#!/bin/sh",
          'case "$*" in',
          '  *provider-plugin-version*) printf "%s\\n" "$FAKE_PLUGIN_VERSION" ;;',
          '  *provider-plugin*) printf "%s\\n" "$FAKE_PLUGIN" ;;',
          "  *) exit 1 ;;",
          "esac",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      return runStep(step.run, dir, {
        BOX_IMAGE: "ghcr.io/notes-co/flax-agent@sha256:" + "ab".repeat(32),
        PROVIDER_PLUGIN: "pi-provider-acme",
        FAKE_PLUGIN: plugin,
        FAKE_PLUGIN_VERSION: version,
      });
    };
    const good = withLabels("pi-provider-acme", "1.2.3");
    expect(good.stderr).toBe("");
    expect(good.status).toBe(0);
    expect(good.stdout).toBe(
      "agent image provider plugin: pi-provider-acme 1.2.3\n",
    );
    const none = withLabels("", "");
    expect(none.status).toBe(1);
    expect(none.stdout).toContain(
      "::error::the pinned agent image carries the provider plugin 'none', but flax.yml agents.provider.plugin names pi-provider-acme; the kit's own image has no provider plugin",
    );
    const other = withLabels("pi-provider-other", "0.1.0");
    expect(other.status).toBe(1);
    expect(other.stdout).toContain(
      "carries the provider plugin 'pi-provider-other'",
    );
  });

  it("checks the job first, then verifies the release binary against lbx_sha256 before putting it on PATH and running", () => {
    const steps: Record<string, any>[] = action().runs.steps;
    const names = steps.map((s) => s.name ?? s.uses);
    expect(names).toEqual([
      "actions/setup-node@v6",
      "Check the job and the pinned box",
      "Log in to ghcr.io",
      "Pull the pinned box image",
      "Check the image carries the provider plugin",
      "Download the sandbox (lbx) release binary",
      "Run the job",
    ]);
    const plugin = byName(steps, "Check the image carries the provider plugin");
    expect(plugin.if).toBe("${{ inputs.provider-plugin != '' }}");
    expect(plugin.env).toEqual({
      BOX_IMAGE: "${{ inputs.box-image }}",
      PROVIDER_PLUGIN: "${{ inputs.provider-plugin }}",
    });
    const download = byName(steps, "Download the sandbox (lbx) release binary");
    expect(download.env).toEqual({
      GH_TOKEN:
        "${{ inputs.box-token != '' && inputs.box-token || github.token }}",
      BOX_REPOSITORY: "${{ inputs.box-repository }}",
      BOX_RELEASE: "${{ inputs.box-release }}",
      BOX_SHA256: "${{ inputs.box-sha256 }}",
    });
    const env = {
      BOX_REPOSITORY: boxRepository(),
      BOX_RELEASE: TAG,
      BOX_SHA256: SHA256,
    };
    const dir = tempDir("action-");
    const good = runStep(download.run, dir, env);
    expect(good.stderr).toBe("");
    expect(good.status).toBe(0);
    expect(good.githubPath).toBe(`${join(dir, "runner-temp", "box")}\n`);
    expect(existsSync(join(dir, "runner-temp", "box", "lbx"))).toBe(true);
    expect(good.calls).toBe(
      `gh release download ${TAG} --repo ${boxRepository()} --pattern ${LBX_BINARY} --dir ${join(dir, "runner-temp", "box")} --clobber\n`,
    );
    const wrongSum = runStep(download.run, tempDir("action-"), {
      ...env,
      BOX_SHA256: "9f".repeat(32),
    });
    expect(wrongSum.status).toBe(1);
    expect(wrongSum.stdout).toContain(
      `::error::${LBX_BINARY} of ${boxRepository()} release ${TAG} does not have the sha256 box.yml pins (lbx_sha256); refusing to run`,
    );
    expect(wrongSum.githubPath).toBe("");
    const badTag = runStep(download.run, tempDir("action-"), {
      ...env,
      BOX_RELEASE: "main",
    });
    expect(badTag.status).toBe(1);
    expect(badTag.stdout).toContain(
      "::error::box_release main is not a release tag vX.Y.Z",
    );
    expect(badTag.calls).toBe("");
    const run = byName(steps, "Run the job");
    expect(run.run).toBe(
      "node dist/run-job.mjs ${{ inputs.job }} --workspace . ${{ inputs.args }}",
    );
    expect(run["working-directory"]).toBe("${{ inputs.workspace }}");
    expect(byName(steps, "Check the job and the pinned box").run).toBe(
      "node dist/run-job.mjs ${{ inputs.job }} --preflight ${{ inputs.args }}",
    );
  });
});

describe("the network refusal check", () => {
  it("reads the release from box.yml for the workflow", () => {
    const result = spawnSync(
      join(KIT_ROOT, "node_modules", ".bin", "tsx"),
      [join(KIT_ROOT, "src", "net-check", "cli.ts"), "--box-outputs"],
      { cwd: makeRepo({ box: BOX }), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `release=${BOX.box_release}\ncommit=${BOX.box_commit}\nimage=${BOX.image}\n`,
    );
  });
});
