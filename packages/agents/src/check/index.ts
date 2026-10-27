import type { Problem } from "../lib/problem.ts";
import { loadRepo, type Repo } from "../lib/repo.ts";
import { agentImageCheck } from "./agent-image.ts";
import { allowlistsCheck } from "./allowlists.ts";
import { boxCheck } from "./box.ts";
import { boxImageCheck } from "./box-image.ts";
import { checkJobsCheck } from "./check-jobs.ts";
import { bundleManifestCheck } from "./bundle.ts";
import { budgetCheck } from "./budget.ts";
import { folderCheck } from "./folder.ts";
import { gatewayCheck } from "./gateway.ts";
import { generatedCheck } from "./generated.ts";
import { githubHostsCheck } from "./github-hosts.ts";
import { linkHostsCheck } from "./link-hosts.ts";
import { jobSchemaCheck } from "./job-schema.ts";
import { jobOptionsCheck } from "./job-options.ts";
import { liveModeCheck } from "./live-mode.ts";
import { mcpServersCheck } from "./mcp-servers.ts";
import { mediaCheck } from "./media.ts";
import { secretsCheck } from "./secrets.ts";
import { toolsCheck } from "./tools.ts";
import { triggersCheck } from "./triggers.ts";
import { workspaceCheck } from "./workspace.ts";
import type { Check } from "./types.ts";

export const CHECKS: readonly Check[] = [
  workspaceCheck,
  jobSchemaCheck,
  folderCheck,
  allowlistsCheck,
  mediaCheck,
  jobOptionsCheck,
  checkJobsCheck,
  toolsCheck,
  triggersCheck,
  budgetCheck,
  generatedCheck,
  liveModeCheck,
  secretsCheck,
  boxCheck,
  boxImageCheck,
  agentImageCheck,
  mcpServersCheck,
  gatewayCheck,
  githubHostsCheck,
  linkHostsCheck,
  bundleManifestCheck,
];

export async function runChecks(
  repo: Repo,
  checks: readonly Check[] = CHECKS,
): Promise<Problem[]> {
  const problems: Problem[] = [];
  for (const check of checks) problems.push(...(await check.run(repo)));
  return problems;
}

export async function checkRepo(root: string): Promise<Problem[]> {
  return runChecks(loadRepo(root));
}
