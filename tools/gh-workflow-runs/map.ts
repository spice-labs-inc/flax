import { githubOrg } from "@flax/agents/tools-server/github";
import type { ToolMapping } from "@flax/agents/tools-server/mapping";
import { pick, refuseWith } from "@flax/agents/tools-server/map-helpers";

const mapping: ToolMapping = {
  map: (args) => {
    const common = {
      owner: githubOrg(),
      repo: args.repo,
      perPage: typeof args.per_page === "number" ? args.per_page : 20,
      page: typeof args.page === "number" ? args.page : 1,
    };
    if (args.run_id !== undefined) {
      refuseWith(
        args,
        ["workflow", "branch", "event", "status"],
        "filter runs, so cannot be used with run_id",
      );
      return {
        operation: "actions_list",
        arguments: {
          ...common,
          method: "list_workflow_jobs",
          resource_id: String(args.run_id),
          workflow_jobs_filter: { filter: "latest" },
        },
      };
    }
    const filter = pick(args, {
      branch: "branch",
      event: "event",
      status: "status",
    });
    return {
      operation: "actions_list",
      arguments: {
        ...common,
        method: "list_workflow_runs",
        ...(args.workflow === undefined ? {} : { resource_id: args.workflow }),
        ...(Object.keys(filter).length === 0
          ? {}
          : { workflow_runs_filter: filter }),
      },
    };
  },
};

export default mapping;
