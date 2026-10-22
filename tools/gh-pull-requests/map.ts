import { githubOrg } from "@flax/agents/tools-server/github";
import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";
import { refuseWith } from "@flax/agents/tools-server/map-helpers";

const mapping: ToolMapping = {
  map: (args) => {
    const common = {
      owner: githubOrg(),
      repo: args.repo,
      perPage: typeof args.per_page === "number" ? args.per_page : 20,
      page: typeof args.page === "number" ? args.page : 1,
    };
    if (args.number !== undefined) {
      refuseWith(
        args,
        ["state", "base"],
        "filter the list, so cannot be used with number",
      );
      return {
        operation: "pull_request_read",
        arguments: {
          ...common,
          method: args.view ?? "get",
          pullNumber: args.number,
        },
      };
    }
    if (args.view !== undefined) throw new ToolRefusal("view needs a number");
    return {
      operation: "list_pull_requests",
      arguments: {
        ...common,
        state: args.state ?? "open",
        ...(args.base === undefined ? {} : { base: args.base }),
      },
    };
  },
};

export default mapping;
