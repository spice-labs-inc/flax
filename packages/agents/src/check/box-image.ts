import { BOX_FILE } from "../lib/paths.ts";
import { problem } from "../lib/problem.ts";
import { WORKSPACE_FILE } from "../lib/workspace.ts";
import type { Check } from "./types.ts";

/** A pinned box.yml names a digest in the repository flax.yml agents.agentImage names, compared exactly. */
export const boxImageCheck: Check = {
  id: "box-image",
  title: "box.yml pins a digest of flax.yml agents.agentImage",
  run: (repo) => {
    if (repo.box === undefined || !repo.box.pinned) return [];
    const pinned = repo.box.image.split("@sha256:")[0];
    const expected = repo.workspace.agentImage;
    if (pinned === expected) return [];
    return [
      problem(
        BOX_FILE,
        `is a digest of ${pinned}, but ${WORKSPACE_FILE} agents.agentImage is ${expected}; pin a digest of ${expected} in ${BOX_FILE}, or set agents.agentImage in ${WORKSPACE_FILE} to ${pinned}`,
        "image",
      ),
    ];
  },
};
