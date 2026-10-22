import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadWorkspace as loadFlaxWorkspace,
  section,
  WORKSPACE_FILE,
  WorkspaceError,
  type Workspace as FlaxWorkspace,
} from "@flax/core";

/**
 * The workspace: the repository that holds jobs/, tools/, the root YAMLs
 * and dist/, and one flax.yml at its root. flax.yml's shared keys (org,
 * github, environments) are read by every flax package; the `agents:`
 * section holds what this package needs. The kit itself (this package:
 * src, schema, images/agent, jobs templates) is the kit root; nothing under
 * it is read per workspace.
 */
export { WORKSPACE_FILE };
export const WORKSPACE_ENV = "FLAX_WORKSPACE";
/** The flax.yml section this package reads. */
export const SECTION = "agents";

export interface SandboxSource {
  /** owner/name of the sandbox (lbx) repository; its releases carry the launcher binary. */
  repo: string;
  /** The secret holding a token for a private sandbox repository; none for a public one. */
  tokenSecret?: string;
}

export type KeyMode = "litellm" | "static";

export interface Provider {
  /** The Pi provider name the box uses; an Anthropic Messages API behind the runner's forwarder. */
  name: string;
  /** Where the runner's forwarder sends model calls. litellm: defaults to gateway.yml url. static: required, the provider's Messages API base URL. */
  baseUrl?: string;
  /** litellm: per-run keys issued at the gateway (/key/generate). static: one key from MODEL_API_KEY, no per-run cap, no spend read back. */
  keyMode: KeyMode;
  /** The npm package of a Pi provider plugin the agent image installs under /opt/pi-extensions; none uses Pi's own provider of that name. */
  plugin?: string;
}

export interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  if?: string;
}

export interface Workspace {
  /** The organization's display name (flax.yml org). */
  orgName: string;
  /** The GitHub owner whose repositories tools read and pull requests go to (flax.yml github, else org). */
  github: string;
  /** The environments a check job runs against, in order; the first is the reference (flax.yml environments). */
  environments: string[];
  /** owner/name of the workspace repository itself (run links, maintainer notes, run reports). */
  repo: string;
  /** The organization project tools may read, with its Status values; none disables board tools. */
  board?: { number: number; statuses: string[] };
  /** The repository (name under the owner) whose issues are the product epics; none disables epic tools. */
  epicsRepo?: string;
  /** Kubernetes clusters tools may read: name to the secret holding its kubeconfig. */
  clusters: Record<string, string>;
  /** Where OpenObserve runs: the cluster and pod the tools port-forward to, and the hosts the net check probes. */
  openobserve?: {
    cluster: string;
    namespace: string;
    labelSelector: string;
    port: number;
    org: string;
    hosts: string[];
  };
  /** What every job together may spend a month. */
  budgetUsdPerMonth: number;
  /** The runs-on labels of every generated workflow. */
  runsOn: string[];
  /** Where lbx comes from. */
  sandbox: SandboxSource;
  /** The secret holding a token that reads the repository the @flax packages are installed from while it is private; none for a public one. */
  packagesTokenSecret?: string;
  /** The agent image repository, without a tag (box.yml pins a digest of it). */
  agentImage: string;
  /** Named network joins a job may ask for (job.yml network: <name>); the steps run before the job, and the leave steps after. */
  networkJoins: Record<
    string,
    { join: WorkflowStep[]; leave?: WorkflowStep[] }
  >;
  /** Named setup steps a job may ask for (job.yml setup: [<name>]). */
  setupSteps: Record<string, WorkflowStep[]>;
  /** The model provider. */
  provider: Provider;
  /** The secrets a job's media.ts may be given by name in media.secrets; the runner hands media.ts only the ones its job lists. */
  mediaSecrets: string[];
  /** Hosts a pull request body may link to (host names; subdomains included). */
  trustedLinkHosts: string[];
  /** How the agent is named in check runs, comments and pull request text. */
  displayName: string;
  /** The author of every commit a job writes. */
  commitAuthor: { name: string; email: string };
  /** Where videos go and the footer on each. */
  video?: { channel: string; footer: string };
  /** Repositories a pull request may never cite as evidence. */
  neverEvidenceRepos: string[];
  /** The reusable action every model job workflow calls: owner/repo/path@ref. */
  kitAction: string;
  /** Lint rules the pull request checker applies to a docs repository; none applies none. */
  docsLint?: {
    repo: string;
    sections: string[];
    componentTags: string[];
    always: string[];
    byTrait: Record<string, string[]>;
  };
}

/** What a flax.yml whose agents section says nothing gets: a stranger's safe defaults, nothing of ours. */
export const DEFAULTS: Omit<
  Workspace,
  "orgName" | "github" | "environments" | "repo"
> = {
  clusters: {},
  budgetUsdPerMonth: 100,
  runsOn: ["ubuntu-24.04"],
  sandbox: { repo: "notes-co/lbx" },
  agentImage: "ghcr.io/notes-co/flax-agent",
  networkJoins: {},
  setupSteps: {},
  provider: {
    name: "anthropic",
    keyMode: "static",
    baseUrl: "https://api.anthropic.com",
  },
  mediaSecrets: [],
  trustedLinkHosts: [],
  displayName: "Agent",
  commitAuthor: {
    name: "flax-agents",
    email: "flax-agents@users.noreply.github.com",
  },
  neverEvidenceRepos: [],
  kitAction: "notes-co/flax/packages/agents@main",
};

/** The whole workspace a missing flax.yml stands for. */
export const FALLBACK: Workspace = {
  orgName: "example-org",
  github: "example-org",
  environments: ["test", "live"],
  repo: "example-org/agents",
  ...DEFAULTS,
};

const OPTIONAL_KEYS = [
  "board",
  "epicsRepo",
  "packagesTokenSecret",
  "openobserve",
  "video",
  "docsLint",
];
const KNOWN_KEYS = new Set([
  ...Object.keys(DEFAULTS),
  "repo",
  ...OPTIONAL_KEYS,
]);

let rootOverride: string | undefined;
let cached: { root: string; workspace: Workspace } | undefined;

/** The workspace root: --workspace, else FLAX_WORKSPACE, else the current directory. */
export function workspaceRoot(flag?: string | undefined): string {
  if (flag !== undefined && flag !== "") rootOverride = resolve(flag);
  const env = process.env[WORKSPACE_ENV];
  return (
    rootOverride ??
    (env !== undefined && env !== "" ? resolve(env) : process.cwd())
  );
}

export function setWorkspaceRoot(dir: string): void {
  rootOverride = resolve(dir);
  cached = undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The agents section of a parsed flax.yml over the defaults, with what is wrong with it. */
export function agentsSection(
  flax: FlaxWorkspace,
  data: Record<string, unknown>,
): { workspace: Workspace; problems: string[] } {
  const problems: string[] = [];
  for (const key of Object.keys(data))
    if (!KNOWN_KEYS.has(key))
      problems.push(`${WORKSPACE_FILE}: unknown key agents.${key}`);
  const github = flax.github ?? flax.org;
  const repo =
    typeof data["repo"] === "string" ? data["repo"] : `${github}/agents`;
  const merged: Workspace = {
    orgName: flax.org,
    github,
    environments: flax.environments.map((e) => e.id),
    repo,
    ...DEFAULTS,
    ...(data as Partial<Workspace>),
  };
  if (!/^[A-Za-z0-9-]+$/.test(merged.github))
    problems.push(`${WORKSPACE_FILE}: github must be a GitHub login`);
  if (!merged.repo.startsWith(`${merged.github}/`))
    problems.push(
      `${WORKSPACE_FILE}: agents.repo must be under ${merged.github}/`,
    );
  if (
    merged.packagesTokenSecret !== undefined &&
    !/^[A-Z][A-Z0-9_]*$/.test(merged.packagesTokenSecret)
  )
    problems.push(
      `${WORKSPACE_FILE}: agents.packagesTokenSecret must be a secret name`,
    );
  const p = merged.provider;
  if (!isObject(p) || typeof p.name !== "string" || p.name === "")
    problems.push(`${WORKSPACE_FILE}: agents.provider.name is required`);
  else if (p.keyMode !== "litellm" && p.keyMode !== "static")
    problems.push(
      `${WORKSPACE_FILE}: agents.provider.keyMode must be litellm or static`,
    );
  else if (
    p.keyMode === "static" &&
    !/^https:\/\/[^/\s]+/.test(p.baseUrl ?? "")
  )
    problems.push(
      `${WORKSPACE_FILE}: agents.provider.baseUrl must be an https URL when keyMode is static`,
    );
  for (const [name, join] of Object.entries(merged.networkJoins))
    if (!isObject(join) || !Array.isArray(join.join))
      problems.push(
        `${WORKSPACE_FILE}: agents.networkJoins.${name} needs a join step list`,
      );
  for (const [name, steps] of Object.entries(merged.setupSteps))
    if (!Array.isArray(steps))
      problems.push(
        `${WORKSPACE_FILE}: agents.setupSteps.${name} must be a step list`,
      );
  return { workspace: merged, problems };
}

/** Reads <root>/flax.yml; a missing file is the fallback workspace with a problem saying so. */
export function loadWorkspace(root: string): {
  workspace: Workspace;
  problems: string[];
} {
  if (!existsSync(join(root, WORKSPACE_FILE)))
    return { workspace: FALLBACK, problems: [] };
  let flax: FlaxWorkspace;
  try {
    flax = loadFlaxWorkspace(root);
  } catch (err) {
    const message =
      err instanceof WorkspaceError
        ? err.message
        : `${WORKSPACE_FILE}: ${(err as Error).message}`;
    return { workspace: FALLBACK, problems: [message] };
  }
  let data: Record<string, unknown>;
  try {
    data = section(flax, SECTION);
  } catch (err) {
    return { workspace: FALLBACK, problems: [(err as Error).message] };
  }
  return agentsSection(flax, data);
}

/** The workspace of the current process, read once from the workspace root. */
export function workspace(): Workspace {
  const root = workspaceRoot();
  if (cached === undefined || cached.root !== root)
    cached = { root, workspace: loadWorkspace(root).workspace };
  return cached.workspace;
}

/** owner/name for a repository named without its owner. */
export function orgRepo(name: string): string {
  return name.includes("/") ? name : `${workspace().github}/${name}`;
}

/** The regular expression source matching a GitHub URL under the owner. */
export function orgGithubUrlPattern(): string {
  return `^https://github\\.com/${workspace().github.replaceAll(".", "\\.")}/[A-Za-z0-9._#/-]{1,200}$`;
}

/** Takes --workspace <dir> out of an argument list, setting the workspace root; the rest is returned. */
export function takeWorkspaceFlag(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--workspace") {
      setWorkspaceRoot(argv[++i] ?? ".");
      continue;
    }
    if (a.startsWith("--workspace=")) {
      setWorkspaceRoot(a.slice("--workspace=".length));
      continue;
    }
    out.push(a);
  }
  return out;
}
