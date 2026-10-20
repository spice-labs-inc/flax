import { spawnSync } from "node:child_process";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { boxCheck } from "../src/check/box.ts";
import { runChecks } from "../src/check/index.ts";
import { generate } from "../src/generate/generate.ts";
import { loadBox, UNPINNED_MESSAGE } from "../src/lib/box.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { BOX, formatted, jobFiles, makeRepo, run } from "./helpers.ts";

const ZEROS = "0".repeat(64);
const PLACEHOLDER = {
  pinned: false,
  box_release: "v0.0.0",
  box_commit: "0".repeat(40),
  lbx_sha256: ZEROS,
  image: `ghcr.io/notes-co/flax-agent@sha256:${ZEROS}`,
};

const IMAGE_PATTERN = "^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$";

describe("box.yml", () => {
  it("accepts a pinned box", async () => {
    expect(await run(boxCheck, makeRepo())).toEqual([]);
    expect(loadBox(makeRepo()).box).toEqual(BOX);
  });

  it("accepts the agent image", async () => {
    const image = `ghcr.io/notes-co/flax-agent@sha256:${"ef".repeat(32)}`;
    const root = makeRepo({ box: { ...BOX, image } });
    expect(await run(boxCheck, root)).toEqual([]);
    expect(loadBox(root).box?.image).toBe(image);
  });

  it("only warns while the placeholders are unpinned", async () => {
    const root = makeRepo({
      jobs: { demo: jobFiles("demo") },
      box: PLACEHOLDER,
    });
    expect(await run(boxCheck, root)).toEqual([
      `warning: box.yml: pinned: ${UNPINNED_MESSAGE}`,
    ]);
    expect(loadBox(root).box).toEqual(PLACEHOLDER);
  });

  it("ships as unpinned placeholders or a real pin", () => {
    const shipped = parse(readFileSync(join(FIXTURE_WORKSPACE, "box.yml"), "utf8"));
    if (!shipped.pinned) expect(shipped).toEqual(PLACEHOLDER);
    expect(loadRepo(FIXTURE_WORKSPACE).box).toBeDefined();
  });

  it("fails when pinned is true but a value is still a placeholder", async () => {
    const root = makeRepo({
      box: { ...PLACEHOLDER, pinned: true, image: BOX.image },
    });
    expect(await run(boxCheck, root)).toEqual([
      "box.yml: box_release: is still the all-zeros placeholder; paste the published value or set pinned: false",
      "box.yml: box_commit: is still the all-zeros placeholder; paste the published value or set pinned: false",
      "box.yml: lbx_sha256: is still the all-zeros placeholder; paste the published value or set pinned: false",
    ]);
    expect(loadBox(root).box).toBeUndefined();
  });

  it.each<[Record<string, unknown>, string]>([
    [
      { box_commit: "abc123" },
      'box.yml: box_commit: "abc123" must match ^[0-9a-f]{40}$',
    ],
    [
      { image: "lbx:docker" },
      `box.yml: image: "lbx:docker" must match ${IMAGE_PATTERN}`,
    ],
    [
      { image: `ghcr.io/notes-co/flax-agent:v1.2.3` },
      `box.yml: image: "ghcr.io/notes-co/flax-agent:v1.2.3" must match ${IMAGE_PATTERN}`,
    ],
    [
      { image: `ghcr.io/notes-co/flax-agent@sha256:${ZEROS}` },
      "box.yml: image: is still the all-zeros placeholder; paste the published value or set pinned: false",
    ],
    [
      { lbx_sha256: "9f".repeat(31) },
      `box.yml: lbx_sha256: "${"9f".repeat(31)}" must match ^[0-9a-f]{64}$`,
    ],
    [{ pinned: "yes" }, "box.yml: pinned: must be boolean"],
    [{ extra: 1 }, "box.yml: extra: is not an allowed key"],
    [{ sockets: true }, "box.yml: sockets: is not an allowed key"],
    [
      { relay: `ghcr.io/notes-co/lbx-relay@sha256:${ZEROS}` },
      "box.yml: relay: is not an allowed key",
    ],
    ...["1.2.3", "v01.2.3", "v1.2", "v1.2.3-rc.1", "v1.2.3 ", "V1.2.3"].map(
      (tag): [Record<string, unknown>, string] => [
        { box_release: tag },
        `box.yml: box_release: ${JSON.stringify(tag)} must match ^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$`,
      ],
    ),
  ])("fails on malformed values %o", async (override, message) => {
    expect(
      await run(boxCheck, makeRepo({ box: { ...BOX, ...override } })),
    ).toEqual([message]);
  });

  it("requires box_release, pinned or not", async () => {
    const { box_release: _, ...unreleased } = BOX;
    for (const box of [unreleased, { ...unreleased, pinned: false }]) {
      const root = makeRepo({ box });
      expect(await run(boxCheck, root)).toEqual([
        "box.yml: box_release: is required",
      ]);
      expect(loadBox(root).box).toBeUndefined();
    }
  });

  it("fails when missing or not YAML", async () => {
    expect(await run(boxCheck, makeRepo({ box: null }))).toEqual([
      "box.yml: is missing",
    ]);
    const root = makeRepo({ box: null, files: { "box.yml": "pinned: [" } });
    expect((await run(boxCheck, root))[0]).toMatch(
      /^box\.yml: is not valid YAML: /,
    );
  });

  it("a warning alone does not fail flax agents check", async () => {
    const root = makeRepo({
      jobs: { demo: jobFiles("demo") },
      box: PLACEHOLDER,
    });
    await generate(loadRepo(root));
    expect(formatted(await runChecks(loadRepo(root)))).toEqual([
      `warning: box.yml: pinned: ${UNPINNED_MESSAGE}`,
    ]);
    const cli = spawnSync(
      join(KIT_ROOT, "node_modules", ".bin", "tsx"),
      [join(KIT_ROOT, "src", "check", "cli.ts")],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, GITHUB_ACTIONS: "true" },
      },
    );
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain(
      `::warning file=box.yml::warning: box.yml: pinned: ${UNPINNED_MESSAGE}`,
    );
    expect(cli.stdout).toContain("All checks passed for 1 job (1 warning).");
  });
});
