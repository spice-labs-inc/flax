// The kit's JSON schemas, imported so that a bundle carries them: the
// bundled runner runs before a workspace installs its packages, so nothing
// may be read from the package directory at run time.
import boxSchema from "../../schema/box.schema.json" with { type: "json" };
import gatewaySchema from "../../schema/gateway.schema.json" with { type: "json" };
import githubHostsSchema from "../../schema/github-log-hosts.schema.json" with { type: "json" };
import jobSchema from "../../schema/job.schema.json" with { type: "json" };
import linkHostsSchema from "../../schema/link-hosts.schema.json" with { type: "json" };
import mcpServersSchema from "../../schema/mcp-servers.schema.json" with { type: "json" };
import mediaSchema from "../../schema/media.schema.json" with { type: "json" };
import patchSetToolQuotesSchema from "../../schema/patch-set-tool-quotes.schema.json" with { type: "json" };
import patchSetSchema from "../../schema/patch-set.schema.json" with { type: "json" };
import scenarioSchema from "../../schema/scenario.schema.json" with { type: "json" };
import toolSchema from "../../schema/tool.schema.json" with { type: "json" };

export const BOX_SCHEMA: object = boxSchema;
export const GATEWAY_SCHEMA: object = gatewaySchema;
export const GITHUB_HOSTS_SCHEMA: object = githubHostsSchema;
export const JOB_SCHEMA: object = jobSchema;
export const LINK_HOSTS_SCHEMA: object = linkHostsSchema;
export const MCP_SERVERS_SCHEMA: object = mcpServersSchema;
export const MEDIA_SCHEMA: object = mediaSchema;
export const PATCH_SET_TOOL_QUOTES_SCHEMA: object = patchSetToolQuotesSchema;
export const PATCH_SET_SCHEMA: object = patchSetSchema;
export const SCENARIO_SCHEMA: object = scenarioSchema;
export const TOOL_SCHEMA: object = toolSchema;
