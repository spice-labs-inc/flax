import type { ToolMapping } from "@flax/agents/tools-server/mapping";
import { timeRange } from "@flax/agents/tools-server/map-helpers";

const mapping: ToolMapping = {
  map: (args, { now }) => {
    const { start, end } = timeRange(args, 24, now);
    return {
      operation: "PrometheusRangeQuery",
      arguments: {
        query: args.query,
        start: start.toISOString(),
        end: end.toISOString(),
        step: String(
          typeof args.step_seconds === "number" ? args.step_seconds : 300,
        ),
      },
    };
  },
};

export default mapping;
