import { githubOrg, openPrQuery } from "@flax/agents/tools-server/github";
import type { ToolMapping } from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => ({
    operation: "search_pull_requests",
    arguments: {
      owner: githubOrg(),
      query:
        args.author === undefined
          ? openPrQuery()
          : `${openPrQuery()} author:${String(args.author)}`,
      sort: "created",
      order: "desc",
      perPage: typeof args.per_page === "number" ? args.per_page : 30,
      page: typeof args.page === "number" ? args.page : 1,
      fields: [
        "number",
        "title",
        "draft",
        "html_url",
        "user",
        "created_at",
        "repository_url",
      ],
    },
  }),
};

export default mapping;
