import { githubOrg } from "@flax/agents/tools-server/github";
import type { ToolMapping } from "@flax/agents/tools-server/mapping";
import { refuseWith } from "@flax/agents/tools-server/map-helpers";

export const RELEASE_FIELDS = [
  "tag_name",
  "name",
  "html_url",
  "published_at",
  "prerelease",
  "draft",
];

const mapping: ToolMapping = {
  map: (args) => {
    if (args.latest === true) {
      refuseWith(
        args,
        ["per_page"],
        "lists releases, so cannot be used with latest",
      );
      return {
        operation: "get_latest_release",
        arguments: { owner: githubOrg(), repo: args.repo },
      };
    }
    return {
      operation: "list_releases",
      arguments: {
        owner: githubOrg(),
        repo: args.repo,
        perPage: typeof args.per_page === "number" ? args.per_page : 5,
        page: 1,
        fields: RELEASE_FIELDS,
      },
    };
  },
};

export default mapping;
