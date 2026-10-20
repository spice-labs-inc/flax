import {
  DEFAULT_TREE_PATHS,
  githubOrg,
  isPlainPath,
} from "@flax/agents/tools-server/github";
import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => {
    const prefix =
      typeof args.prefix === "string"
        ? args.prefix.replace(/\/+$/, "")
        : undefined;
    if (prefix !== undefined && !isPlainPath(prefix))
      throw new ToolRefusal("prefix must be a plain relative path");
    return {
      operation: "commit_tree",
      arguments: {
        owner: githubOrg(),
        repo: args.repo,
        sha: args.sha,
        ...(prefix === undefined ? {} : { prefix }),
        max_paths:
          typeof args.max_paths === "number"
            ? args.max_paths
            : DEFAULT_TREE_PATHS,
      },
    };
  },
};

export default mapping;
