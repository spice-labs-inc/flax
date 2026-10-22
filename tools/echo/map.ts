import type { ToolMapping } from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args) => ({ operation: "echo", arguments: { text: args.text } }),
};

export default mapping;
