import type { ToolMapping } from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => ({
    operation: "StreamSchema",
    arguments: { stream_name: args.stream },
  }),
};

export default mapping;
