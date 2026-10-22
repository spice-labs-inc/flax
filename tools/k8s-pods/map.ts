import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";
import { refuseWith } from "@flax/agents/tools-server/map-helpers";

const mapping: ToolMapping = {
  map: (args) => {
    if (args.name !== undefined) {
      if (args.namespace === undefined)
        throw new ToolRefusal("name needs a namespace");
      refuseWith(args, ["label_selector"], "cannot be used with name");
      return {
        operation: "pods_get",
        arguments: {
          cluster: args.cluster,
          namespace: args.namespace,
          name: args.name,
        },
      };
    }
    return {
      operation: "pods_list",
      arguments: {
        cluster: args.cluster,
        ...(args.namespace === undefined
          ? {}
          : { fieldSelector: `metadata.namespace=${String(args.namespace)}` }),
        ...(args.label_selector === undefined
          ? {}
          : { labelSelector: args.label_selector }),
      },
    };
  },
};

export default mapping;
