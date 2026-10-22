import {
  DEFAULT_GREP_MATCHES,
  grepPatternProblem,
} from "@flax/agents/tools-server/code-grep";
import { githubOrg } from "@flax/agents/tools-server/github";
import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => {
    const pattern = String(args.pattern);
    const fixed = args.fixed_string === true;
    const ignoreCase = args.ignore_case === true;
    if (!fixed) {
      const problem = grepPatternProblem(pattern, ignoreCase);
      if (problem !== undefined) throw new ToolRefusal(problem);
    }
    return {
      operation: "commit_grep",
      arguments: {
        owner: githubOrg(),
        repo: args.repo,
        sha: args.sha,
        pattern,
        fixed_string: fixed,
        ignore_case: ignoreCase,
        ...(typeof args.path_glob === "string"
          ? { path_glob: args.path_glob }
          : {}),
        max_matches:
          typeof args.max_matches === "number"
            ? args.max_matches
            : DEFAULT_GREP_MATCHES,
      },
    };
  },
};

export default mapping;
