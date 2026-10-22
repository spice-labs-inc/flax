import { githubOrg } from "@flax/agents/tools-server/github";
import type { ToolMapping } from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => ({
    operation: "list_commits",
    arguments: {
      owner: githubOrg(),
      repo: args.repo,
      sha: "main",
      perPage: typeof args.per_page === "number" ? args.per_page : 30,
      page: 1,
      fields: ["sha", "html_url", "commit"],
    },
  }),
};

export default mapping;
