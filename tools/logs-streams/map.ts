import type { ToolMapping } from "@flax/agents/tools-server/mapping";
import { pick } from "@flax/agents/tools-server/map-helpers";

const mapping: ToolMapping = {
  map: (args) => ({
    operation: "StreamList",
    arguments: pick(args, { keyword: "keyword", has_fields: "fields" }),
  }),
};

export default mapping;
