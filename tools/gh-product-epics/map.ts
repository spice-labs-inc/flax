import {
  EPIC_FIELDS,
  epicsRepo,
  githubOrg,
  MAX_ACTIVITY_DAYS,
} from "@flax/agents/tools-server/github";
import type { ToolMapping } from "@flax/agents/tools-server/mapping";
import { refuseWith, sinceDay } from "@flax/agents/tools-server/map-helpers";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;

const epicUrl = (number: unknown) =>
  `https://github.com/${githubOrg()}/${epicsRepo()}/issues/${String(number)}`;

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((l) => (isObject(l) ? text(l.name) : text(l)))
    .filter((l): l is string => l !== undefined);
}

/** One epic as the tool returns it: no body, author or assignees. */
export function epic(issue: Record<string, unknown>) {
  return {
    number: issue.number,
    title: text(issue.title) ?? "",
    state: (text(issue.state) ?? "").toLowerCase(),
    ...(text(issue.state_reason) === undefined
      ? {}
      : { stateReason: issue.state_reason }),
    labels: labelNames(issue.labels),
    url: epicUrl(issue.number),
    createdAt: text(issue.created_at) ?? "",
    updatedAt: text(issue.updated_at) ?? "",
    ...(text(issue.closed_at) === undefined
      ? {}
      : { closedAt: issue.closed_at }),
  };
}

const mapping: ToolMapping = {
  map: (args, { now }) => {
    if (args.number !== undefined) {
      refuseWith(
        args,
        ["state", "since", "after", "per_page"],
        "lists epics, so cannot be used with number",
      );
      return {
        operation: "issue_read",
        arguments: {
          method: "get",
          owner: githubOrg(),
          repo: epicsRepo(),
          issue_number: args.number,
        },
      };
    }
    const since =
      args.since === undefined
        ? undefined
        : sinceDay(args.since, now, MAX_ACTIVITY_DAYS);
    return {
      operation: "list_issues",
      arguments: {
        owner: githubOrg(),
        repo: epicsRepo(),
        ...(args.state === undefined
          ? {}
          : { state: String(args.state).toUpperCase() }),
        ...(since === undefined ? {} : { since: `${since}T00:00:00Z` }),
        orderBy: "UPDATED_AT",
        direction: "DESC",
        perPage: typeof args.per_page === "number" ? args.per_page : 50,
        ...(args.after === undefined ? {} : { after: args.after }),
        fields: EPIC_FIELDS,
      },
    };
  },
  result: (answer, args) => {
    const parsed: unknown = JSON.parse(answer);
    if (!isObject(parsed)) throw new Error("the epic answer is not an object");
    if (args.number !== undefined) return JSON.stringify(epic(parsed));
    if (!Array.isArray(parsed.issues))
      throw new Error("the epic answer has no issues");
    const page = isObject(parsed.pageInfo) ? parsed.pageInfo : {};
    return JSON.stringify({
      epics: parsed.issues.filter(isObject).map(epic),
      ...(typeof parsed.totalCount === "number"
        ? { totalCount: parsed.totalCount }
        : {}),
      hasNextPage: page.hasNextPage === true,
      ...(page.hasNextPage === true && typeof page.endCursor === "string"
        ? { nextCursor: page.endCursor }
        : {}),
    });
  },
};

export default mapping;
