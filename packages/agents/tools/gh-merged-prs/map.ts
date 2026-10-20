import {
  githubOrg,
  MAX_MERGED_DAYS,
  mergedPrQuery,
} from "@flax/agents/tools-server/github";
import {
  ToolRefusal,
  type ToolMapping,
} from "@flax/agents/tools-server/mapping";
import { CLOCK_SKEW_MS } from "@flax/agents/tools-server/map-helpers";

const DAY_MS = 24 * 3600 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const mapping: ToolMapping = {
  map: (args, { now }) => {
    const since = String(args.since);
    const ms = Date.parse(`${since}T00:00:00Z`);
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== since)
      throw new ToolRefusal("since must be a real day, as YYYY-MM-DD");
    if (ms > now.getTime() + CLOCK_SKEW_MS)
      throw new ToolRefusal("since may not be in the future");
    if (now.getTime() - ms > (MAX_MERGED_DAYS + 1) * DAY_MS)
      throw new ToolRefusal(
        `since may be at most ${MAX_MERGED_DAYS} days back`,
      );
    return {
      operation: "search_pull_requests",
      arguments: {
        owner: githubOrg(),
        query: mergedPrQuery(since),
        sort: "updated",
        order: "desc",
        perPage: typeof args.per_page === "number" ? args.per_page : 30,
        page: typeof args.page === "number" ? args.page : 1,
        fields: [
          "number",
          "title",
          "html_url",
          "closed_at",
          "pull_request",
          "repository_url",
          "user",
        ],
      },
    };
  },
  // A whole user object is about a kilobyte of profile links; keep only
  // what the collectors read, so a page of results fits the size limit.
  result: (answer) => {
    const parsed: unknown = JSON.parse(answer);
    if (!isObject(parsed) || !Array.isArray(parsed.items))
      throw new Error("the search answer has no items");
    return JSON.stringify({
      ...parsed,
      items: parsed.items.filter(isObject).map(mergedPr),
    });
  },
};

function mergedPr(pr: Record<string, unknown>) {
  const user = isObject(pr.user) ? pr.user : {};
  const pull = isObject(pr.pull_request) ? pr.pull_request : {};
  return {
    number: pr.number,
    title: pr.title,
    html_url: pr.html_url,
    closed_at: pr.closed_at,
    repository_url: pr.repository_url,
    pull_request: { merged_at: pull.merged_at },
    user: { login: user.login, type: user.type },
  };
}

export default mapping;
