import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";

const mapping: ToolMapping = {
  map: (args, { now, readChannels }) => {
    const channel = readChannels.find(
      (c) => c.name === args.channel || c.id === args.channel,
    );
    if (channel === undefined)
      throw new ToolRefusal(
        `${String(args.channel)} is not a channel this tool may read; it may read ${readChannels.map((c) => c.name).join(", ") || "none"}`,
      );
    const hours = typeof args.hours === "number" ? args.hours : 24;
    const oldest = ((now.getTime() - hours * 3600 * 1000) / 1000).toFixed(6);
    const common = {
      channel: channel.id,
      oldest,
      limit: typeof args.limit === "number" ? args.limit : 50,
    };
    return args.thread_ts === undefined
      ? { operation: "conversations.history", arguments: common }
      : {
          operation: "conversations.replies",
          arguments: { ...common, ts: args.thread_ts },
        };
  },
};

export default mapping;
