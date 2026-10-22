import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";
import { micros, timeRange } from "@flax/agents/tools-server/map-helpers";
import { selectProblem } from "@flax/agents/tools-server/openobserve";

const mapping: ToolMapping = {
  map: (args, { now }) => {
    const sql = String(args.sql).trim();
    const problem = selectProblem(sql);
    if (problem !== undefined) throw new ToolRefusal(problem);
    const { start, end } = timeRange(args, 24, now);
    return {
      operation: "SearchTracesSQL",
      arguments: {
        sql,
        start_time: micros(start),
        end_time: micros(end),
        size: typeof args.limit === "number" ? args.limit : 100,
      },
    };
  },
};

export default mapping;
