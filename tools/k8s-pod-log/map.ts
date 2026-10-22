import type { ToolMapping } from "@flax/agents/tools-server/mapping";
import { pick } from "@flax/agents/tools-server/map-helpers";

const mapping: ToolMapping = {
  map: (args) => ({
    operation: "pods_log",
    arguments: {
      ...pick(args, {
        cluster: "cluster",
        namespace: "namespace",
        name: "name",
        container: "container",
        previous: "previous",
      }),
      tail: typeof args.tail === "number" ? args.tail : 100,
    },
  }),
};

export default mapping;
