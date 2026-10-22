import { githubOrg } from "@flax/agents/tools-server/github";
import type { ToolMapping } from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => ({
    operation: "compare_commits",
    arguments: {
      owner: githubOrg(),
      repo: args.repo,
      base: args.base,
      head: args.head,
      patch_lines: typeof args.patch_lines === "number" ? args.patch_lines : 0,
    },
  }),
};

export default mapping;
