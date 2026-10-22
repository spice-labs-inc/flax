import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";

const KIND = { apiVersion: "helm.toolkit.fluxcd.io/v2", kind: "HelmRelease" };

const mapping: ToolMapping = {
  map: (args) => {
    if (args.name !== undefined) {
      if (args.namespace === undefined)
        throw new ToolRefusal("name needs a namespace");
      return {
        operation: "resources_get",
        arguments: {
          cluster: args.cluster,
          ...KIND,
          namespace: args.namespace,
          name: args.name,
        },
      };
    }
    return {
      operation: "resources_list",
      arguments: {
        cluster: args.cluster,
        ...KIND,
        ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
      },
    };
  },
};

export default mapping;
