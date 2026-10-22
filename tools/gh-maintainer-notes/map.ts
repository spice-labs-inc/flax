import { githubOrg, notesRepo } from "@flax/agents/tools-server/github";
import type { ToolMapping } from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => ({
    operation: "maintainer_notes_list",
    arguments: {
      owner: githubOrg(),
      repo: notesRepo(),
      job: args.job,
      days: typeof args.days === "number" ? args.days : 7,
    },
  }),
};

export default mapping;
