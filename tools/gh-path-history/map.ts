import {
  branchProblem,
  DEFAULT_PATH_COMMITS,
  FULL_SHA,
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
    const ref = typeof args.ref === "string" ? args.ref : "main";
    if (!FULL_SHA.test(ref)) {
      const problem = branchProblem(ref);
      if (problem !== undefined)
        throw new ToolRefusal(
          `${problem}; ref takes a branch name or a full commit sha`,
        );
    }
    return {
      operation: "path_history",
      arguments: {
        owner: githubOrg(),
        repo: args.repo,
        path: args.path,
        ref,
        count:
          typeof args.count === "number" ? args.count : DEFAULT_PATH_COMMITS,
      },
    };
  },
};

export default mapping;
