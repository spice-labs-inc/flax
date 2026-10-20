import { githubOrg, releaseTagRef } from "@flax/agents/tools-server/github";
import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => {
    const path = String(args.path);
    if (
      path
        .split("/")
        .some((part) => part === "" || part === ".." || part === ".")
    )
      throw new ToolRefusal("path must be a plain relative path");
    return {
      operation: "get_file_contents",
      arguments: {
        owner: githubOrg(),
        repo: args.repo,
        path,
        ref: releaseTagRef(String(args.tag)),
      },
    };
  },
};

export default mapping;
