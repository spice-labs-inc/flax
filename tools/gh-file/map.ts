import { githubOrg, MAIN_REF } from "@flax/agents/tools-server/github";
import {
  fileLineRange,
  slimDirectory,
} from "@flax/agents/tools-server/map-helpers";
import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";

const num = (value: unknown) => (typeof value === "number" ? value : undefined);

const mapping: ToolMapping = {
  map: (args, context) => {
    const path = String(args.path);
    if (
      path
        .split("/")
        .some((part) => part === "" || part === ".." || part === ".")
    )
      throw new ToolRefusal("path must be a plain relative path");
    const repo = String(args.repo);
    // A named ref wins; otherwise the commit the job pins the repository to, otherwise main.
    const ref =
      typeof args.ref === "string" ? args.ref : context.commits.get(repo);
    return {
      operation: "get_file_contents",
      arguments: {
        owner: githubOrg(),
        repo,
        path,
        ...(ref === undefined || ref === "main"
          ? { ref: MAIN_REF }
          : { sha: ref }),
      },
    };
  },
  result: (text, args) =>
    fileLineRange(
      slimDirectory(text),
      num(args.start_line),
      num(args.line_count),
    ),
};

export default mapping;
