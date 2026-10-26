import {
  BOARD_FIELD_NAMES,
  boardNumber,
  boardQuery,
  githubOrg,
  MAX_ACTIVITY_DAYS,
} from "@flax/agents/tools-server/github";
import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";
import { sinceDay } from "@flax/agents/tools-server/map-helpers";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;

/** One board item as the tool returns it: no ids, author or assignees. */
export function boardItem(item: Record<string, unknown>) {
  const content = isObject(item.content) ? item.content : {};
  const fields = Array.isArray(item.fields) ? item.fields.filter(isObject) : [];
  const status = fields.find((f) => f.name === "Status")?.value;
  const repo = text(content.repository);
  return {
    ...(repo === undefined ? {} : { repo: repo.split("/").pop() }),
    ...(typeof content.number === "number" ? { number: content.number } : {}),
    title: text(content.title) ?? "",
    type: text(item.content_type) ?? "",
    ...(text(content.state) === undefined ? {} : { state: content.state }),
    status: isObject(status) ? (text(status.name) ?? null) : null,
    ...(text(content.html_url) === undefined ? {} : { url: content.html_url }),
    addedAt: text(item.created_at) ?? "",
    changedAt: text(item.updated_at) ?? "",
    ...(text(content.closed_at) === undefined
      ? {}
      : { closedAt: content.closed_at }),
  };
}

const mapping: ToolMapping = {
  map: (args, { now }) => {
    const statuses = Array.isArray(args.statuses)
      ? (args.statuses as string[])
      : undefined;
    const since =
      args.since === undefined
        ? undefined
        : sinceDay(args.since, now, MAX_ACTIVITY_DAYS);
    if (
      since === undefined &&
      (statuses === undefined || statuses.length === 0)
    )
      throw new ToolRefusal("give since, statuses or both");
    return {
      operation: "projects_list",
      arguments: {
        method: "list_project_items",
        owner: githubOrg(),
        owner_type: "org",
        project_number: boardNumber(),
        field_names: BOARD_FIELD_NAMES,
        query: boardQuery(since, statuses),
        perPage: typeof args.per_page === "number" ? args.per_page : 50,
        ...(args.after === undefined ? {} : { after: args.after }),
      },
    };
  },
  result: (answer) => {
    const parsed: unknown = JSON.parse(answer);
    if (!isObject(parsed) || !Array.isArray(parsed.items))
      throw new Error("the board answer has no items");
    const page = isObject(parsed.pageInfo) ? parsed.pageInfo : {};
    return JSON.stringify({
      items: parsed.items.filter(isObject).map(boardItem),
      hasNextPage: page.hasNextPage === true,
      ...(page.hasNextPage === true && typeof page.nextCursor === "string"
        ? { nextCursor: page.nextCursor }
        : {}),
    });
  },
};

export default mapping;
