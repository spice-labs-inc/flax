import { githubOrg } from "@flax/agents/tools-server/github";
import type { ToolMapping } from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => ({
    operation: "get_job_logs",
    arguments: {
      owner: githubOrg(),
      repo: args.repo,
      job_id: args.job_id,
      return_content: true,
      tail_lines: typeof args.tail === "number" ? args.tail : 100,
    },
  }),
};

export default mapping;
