import type { Check } from "./types.ts";

/** mcp-servers.yml pins every MCP server binary by exact release and sha256. */
export const mcpServersCheck: Check = {
  id: "mcp-servers",
  title: "mcp-servers.yml pins the MCP server binaries",
  run: (repo) => repo.mcpServerProblems,
};
