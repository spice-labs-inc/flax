import type { ToolMapping } from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => ({
    operation: "namespaces_list",
    arguments: {
      cluster: args.cluster,
      ...(args.phase === undefined ? {} : { phase: args.phase }),
    },
  }),
};

export default mapping;
