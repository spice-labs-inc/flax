import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";
import { micros, timeRange } from "@flax/agents/tools-server/map-helpers";

const mapping: ToolMapping = {
  map: (args, { now }) => {
    if (typeof args.filter === "string" && args.filter.includes(";"))
      throw new ToolRefusal("filter may not contain a semicolon");
    const { start, end } = timeRange(args, 24, now);
    return {
      operation: "GetLatestTraces",
      arguments: {
        stream_name: args.stream,
        start_time: micros(start),
        end_time: micros(end),
        size: typeof args.limit === "number" ? args.limit : 20,
        ...(args.filter === undefined ? {} : { filter: args.filter }),
      },
    };
  },
};

export default mapping;
