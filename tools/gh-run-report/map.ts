import { githubOrg, notesRepo } from "@flax/agents/tools-server/github";
import type { ToolMapping } from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => ({
    operation: "run_report_read",
    arguments: {
      owner: githubOrg(),
      repo: notesRepo(),
      job: args.job,
      run_id: args.run_id,
    },
  }),
};

export default mapping;
