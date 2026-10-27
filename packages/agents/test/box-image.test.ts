import { describe, expect, it } from "vitest";
import { boxCheck } from "../src/check/box.ts";
import { boxImageCheck } from "../src/check/box-image.ts";
import { UNPINNED_MESSAGE } from "../src/lib/box.ts";
import { DEFAULTS } from "../src/lib/workspace.ts";
import { BOX, FLAX_TEXT, makeRepo, run } from "./helpers.ts";

const AGENT_IMAGE_LINE = "agentImage: ghcr.io/notes-co/flax-agent";
const DIGEST = `@sha256:${"ab".repeat(32)}`;

/** The fixture flax.yml with its agents.agentImage line replaced (or removed, for an empty string). */
function flaxWith(line: string): string {
  expect(FLAX_TEXT).toContain(AGENT_IMAGE_LINE);
  return FLAX_TEXT.replace(AGENT_IMAGE_LINE, line);
}

function mismatch(pinned: string, expected: string): string {
  return `box.yml: image: is a digest of ${pinned}, but flax.yml agents.agentImage is ${expected}; pin a digest of ${expected} in box.yml, or set agents.agentImage in flax.yml to ${pinned}`;
}

describe("box.yml image and flax.yml agents.agentImage", () => {
  it("passes when the pinned image is a digest of agents.agentImage", async () => {
    expect(await run(boxImageCheck, makeRepo())).toEqual([]);
    const flax = flaxWith(
      "agentImage: registry.notes-co.example:5000/agents/box",
    );
    const box = {
      ...BOX,
      image: `registry.notes-co.example:5000/agents/box${DIGEST}`,
    };
    expect(await run(boxImageCheck, makeRepo({ flax, box }))).toEqual([]);
  });

  it.each([
    "ghcr.io/notes-co/other-agent",
    "ghcr.io/other-co/flax-agent",
    "docker.io/notes-co/flax-agent",
    "ghcr.io/notes-co/flax-agent/extra",
    "ghcr.io/notes-co/flax",
  ])("fails when the pinned image is in %s", async (repository) => {
    const box = { ...BOX, image: `${repository}${DIGEST}` };
    expect(await run(boxImageCheck, makeRepo({ box }))).toEqual([
      mismatch(repository, "ghcr.io/notes-co/flax-agent"),
    ]);
  });

  it("compares the repository exactly, case and tag included", async () => {
    for (const agentImage of [
      "ghcr.io/Notes-Co/flax-agent",
      "ghcr.io/notes-co/flax-agent:v1.2.3",
    ]) {
      const flax = flaxWith(`agentImage: ${agentImage}`);
      expect(await run(boxImageCheck, makeRepo({ flax }))).toEqual([
        mismatch("ghcr.io/notes-co/flax-agent", agentImage),
      ]);
    }
  });

  it("compares with the default agents.agentImage when flax.yml leaves it out", async () => {
    const flax = flaxWith("");
    expect(await run(boxImageCheck, makeRepo({ flax }))).toEqual([]);
    const box = { ...BOX, image: `ghcr.io/acme/flax-agent${DIGEST}` };
    expect(await run(boxImageCheck, makeRepo({ flax, box }))).toEqual([
      mismatch("ghcr.io/acme/flax-agent", DEFAULTS.agentImage),
    ]);
  });

  it("leaves a missing box.yml or a missing image to the box check", async () => {
    const missing = makeRepo({ box: null });
    expect(await run(boxImageCheck, missing)).toEqual([]);
    expect(await run(boxCheck, missing)).toEqual(["box.yml: is missing"]);
    const { image: _, ...imageless } = BOX;
    const noImage = makeRepo({ box: imageless });
    expect(await run(boxImageCheck, noImage)).toEqual([]);
    expect(await run(boxCheck, noImage)).toEqual([
      "box.yml: image: is required",
    ]);
  });

  it("leaves an unpinned box alone", async () => {
    const box = {
      ...BOX,
      pinned: false,
      image: `ghcr.io/other-co/flax-agent${DIGEST}`,
    };
    const root = makeRepo({ box });
    expect(await run(boxImageCheck, root)).toEqual([]);
    expect(await run(boxCheck, root)).toEqual([
      `warning: box.yml: pinned: ${UNPINNED_MESSAGE}`,
    ]);
  });
});
