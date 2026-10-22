import {
  DEFAULT_BLAME_LINES,
  githubOrg,
  isPlainPath,
} from "@flax/agents/tools-server/github";
import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => {
    if (!isPlainPath(args.path))
      throw new ToolRefusal("path must be a plain relative path");
    return {
      operation: "commit_blame",
      arguments: {
        owner: githubOrg(),
        repo: args.repo,
        sha: args.sha,
        path: args.path,
        start_line: typeof args.start_line === "number" ? args.start_line : 1,
        line_count:
          typeof args.line_count === "number"
            ? args.line_count
            : DEFAULT_BLAME_LINES,
      },
    };
  },
};

export default mapping;
