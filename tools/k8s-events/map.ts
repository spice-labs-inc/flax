import { limitEvents } from "@flax/agents/tools-server/kubernetes";
import type { ToolMapping } from "@flax/agents/tools-server/mapping";

const limit = (args: Record<string, unknown>) =>
  typeof args.limit === "number" ? args.limit : 100;

const mapping: ToolMapping = {
  map: (args) => {
    const fields = [
      ...(args.object_name === undefined
        ? []
        : [`involvedObject.name=${String(args.object_name)}`]),
      ...(args.warnings_only === true ? ["type=Warning"] : []),
    ];
    return {
      operation: "events_list",
      arguments: {
        cluster: args.cluster,
        ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
        ...(fields.length === 0 ? {} : { fieldSelector: fields.join(",") }),
      },
    };
  },
  result: (text, args) => limitEvents(text, limit(args)),
};

export default mapping;
