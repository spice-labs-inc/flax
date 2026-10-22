import { toolFile } from "../lib/paths.ts";
import { firstLine, problem, type Problem } from "../lib/problem.ts";
import { loadMapping } from "../tools-server/mapping.ts";
import type { Check } from "./types.ts";

/** Each folder under tools/ holds a tool.yml that passes the schema and limits, and a map.ts that loads. */
export const toolsCheck: Check = {
  id: "tools",
  title: "tools are well formed",
  async run(repo) {
    const problems: Problem[] = repo.tools.flatMap((tool) => tool.problems);
    for (const tool of repo.tools) {
      if (tool.spec === undefined) continue;
      try {
        await loadMapping(repo.root, tool.name);
      } catch (err) {
        problems.push(problem(toolFile(tool.name, "map.ts"), firstLine(err)));
      }
    }
    return problems;
  },
};
