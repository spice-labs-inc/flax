import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { loadWorkspace, WORKSPACE_FILE, type Workspace } from "./workspace.ts";
import { join } from "node:path";
import { parse } from "yaml";
import { describeErrors, jobSchemaValidator } from "./ajv.ts";
import { loadAllowlists, type Allowlists } from "./allowlists.ts";
import { loadBox, type Box } from "./box.ts";
import type { JobConfig } from "./job.ts";
import { loadGateway, type Gateway } from "./gateway.ts";
import { loadGithubHosts, type GithubHosts } from "./github-hosts.ts";
import { loadLinkHosts, type LinkHosts } from "./link-hosts.ts";
import { loadServerPins, type ServerPins } from "./mcp-servers.ts";
import { jobFile, JOBS_DIR } from "./paths.ts";
import { firstLine, problem, type Problem } from "./problem.ts";
import { byCodePoint } from "./sort.ts";
import { loadTools, type ToolEntry } from "./tools.ts";

export interface JobEntry {
  /** The folder name under jobs/. */
  name: string;
  /** Set only when job.yml parsed, matched the schema and names its own folder. */
  config?: JobConfig;
  /** Why job.yml could not be accepted. A missing job.yml is reported by the folder check. */
  problems: Problem[];
}

export interface Repo {
  root: string;
  /** The flax.yml agents section, or the defaults when the file is missing. */
  workspace: Workspace;
  workspaceProblems: Problem[];
  jobs: JobEntry[];
  /** Entries directly under jobs/ that are not plain directories. */
  strayEntries: string[];
  allowlists: Allowlists;
  allowlistProblems: Problem[];
  /** Every folder under tools/, with its problems. */
  tools: ToolEntry[];
  /** Set when box.yml matches its schema, pinned or not. */
  box?: Box;
  boxProblems: Problem[];
  /** Set when mcp-servers.yml passed its checks. */
  mcpServers?: ServerPins;
  mcpServerProblems: Problem[];
  /** Set when gateway.yml matches its schema. */
  gateway?: Gateway;
  /** The gateway CA root, set when the file is a valid CA certificate. */
  gatewayCa?: string;
  gatewayProblems: Problem[];
  /** Set when github-log-hosts.yml matches its schema. */
  githubHosts?: GithubHosts;
  githubHostProblems: Problem[];
  /** Set when link-hosts.yml matches its schema. */
  linkHosts?: LinkHosts;
  linkHostProblems: Problem[];
}

export function loadJob(root: string, name: string): JobEntry {
  const file = jobFile(name, "job.yml");
  const path = join(root, file);
  if (!existsSync(path) || !lstatSync(path).isFile())
    return { name, problems: [] };
  let data: unknown;
  try {
    data = parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      name,
      problems: [problem(file, `is not valid YAML: ${firstLine(err)}`)],
    };
  }
  const validate = jobSchemaValidator();
  if (!validate(data)) {
    return {
      name,
      problems: describeErrors(validate.errors).map((e) =>
        problem(file, e.message, e.field),
      ),
    };
  }
  const config = data as JobConfig;
  if (config.name !== name) {
    return {
      name,
      problems: [
        problem(
          file,
          `"${config.name}" must equal the folder name "${name}"`,
          "name",
        ),
      ],
    };
  }
  return { name, config, problems: [] };
}

export function loadRepo(root: string): Repo {
  const jobs: JobEntry[] = [];
  const strayEntries: string[] = [];
  const dir = join(root, JOBS_DIR);
  if (existsSync(dir)) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      byCodePoint(a.name, b.name),
    );
    for (const entry of entries) {
      if (entry.isDirectory()) jobs.push(loadJob(root, entry.name));
      else strayEntries.push(entry.name);
    }
  }
  const { workspace, problems: workspaceProblems } = loadWorkspace(root);
  const { allowlists, problems } = loadAllowlists(root);
  const { box, problems: boxProblems } = loadBox(root);
  const { pins, problems: mcpServerProblems } = loadServerPins(root);
  const { gateway, caPem, problems: gatewayProblems } = loadGateway(root, new Date(), workspace.provider, workspace.budgetUsdPerMonth);
  const { hosts: githubHosts, problems: githubHostProblems } =
    loadGithubHosts(root);
  const { hosts: linkHosts, problems: linkHostProblems } = loadLinkHosts(root);
  return {
    root,
    workspace,
    workspaceProblems: workspaceProblems.map((p) => problem(WORKSPACE_FILE, p)),
    jobs,
    strayEntries,
    allowlists,
    allowlistProblems: problems,
    tools: loadTools(root),
    ...(box === undefined ? {} : { box }),
    boxProblems,
    ...(pins === undefined ? {} : { mcpServers: pins }),
    mcpServerProblems,
    ...(gateway === undefined ? {} : { gateway }),
    ...(caPem === undefined ? {} : { gatewayCa: caPem }),
    gatewayProblems,
    ...(githubHosts === undefined ? {} : { githubHosts }),
    githubHostProblems,
    ...(linkHosts === undefined ? {} : { linkHosts }),
    linkHostProblems,
  };
}

export function validJobs(repo: Repo): (JobEntry & { config: JobConfig })[] {
  return repo.jobs.filter(
    (j): j is JobEntry & { config: JobConfig } => j.config !== undefined,
  );
}
