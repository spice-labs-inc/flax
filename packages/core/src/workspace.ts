// The flax workspace file. A workspace is a directory holding your content (jobs, atlas pages,
// scenarios, personas) and one `flax.yml` at its root. Shared keys sit at the top level; each
// package reads its own section (`agents:`, `atlas:`, `scenarios:`, `explorer:`) and may define
// that section's shape itself. This loader only parses the file and validates the shared keys.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

export const WORKSPACE_FILE = "flax.yml";

export interface Environment {
  id: string;
  label?: string;
}

export interface Workspace {
  /** Absolute path of the workspace directory. */
  dir: string;
  /** Short organization name used in defaults and titles (never an internal codename). */
  org: string;
  /** GitHub owner the workspace's repositories live under, when any. */
  github?: string;
  /** Environments in order: the first one is the reference environment. */
  environments: Environment[];
  /** Per-package sections, left untyped here; each package validates its own. */
  sections: Record<string, unknown>;
}

export class WorkspaceError extends Error {}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceError(`${what} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

export function parseWorkspace(text: string, dir: string): Workspace {
  const root = asRecord(parse(text) ?? {}, WORKSPACE_FILE);
  const org = root["org"];
  if (typeof org !== "string" || org.length === 0) throw new WorkspaceError(`${WORKSPACE_FILE}: org is required`);
  const github = root["github"];
  if (github !== undefined && typeof github !== "string") throw new WorkspaceError(`${WORKSPACE_FILE}: github must be a string`);
  const rawEnvs = root["environments"];
  if (!Array.isArray(rawEnvs) || rawEnvs.length === 0) throw new WorkspaceError(`${WORKSPACE_FILE}: environments must list at least one environment`);
  const environments: Environment[] = rawEnvs.map((entry, index) => {
    if (typeof entry === "string") return { id: entry };
    const record = asRecord(entry, `environments[${index}]`);
    const id = record["id"];
    if (typeof id !== "string" || id.length === 0) throw new WorkspaceError(`environments[${index}].id is required`);
    const label = record["label"];
    return label === undefined ? { id } : { id, label: String(label) };
  });
  const seen = new Set<string>();
  for (const env of environments) {
    if (seen.has(env.id)) throw new WorkspaceError(`${WORKSPACE_FILE}: environment ${env.id} is listed twice`);
    seen.add(env.id);
  }
  const sections: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (key === "org" || key === "github" || key === "environments") continue;
    sections[key] = value;
  }
  return { dir: resolve(dir), org, github: typeof github === "string" ? github : undefined, environments, sections };
}

export function loadWorkspace(dir: string): Workspace {
  const path = join(dir, WORKSPACE_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new WorkspaceError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseWorkspace(text, dir);
}

/** The section a package owns, or an empty mapping when the workspace has none. */
export function section(workspace: Workspace, name: string): Record<string, unknown> {
  const value = workspace.sections[name];
  return value === undefined ? {} : asRecord(value, `${WORKSPACE_FILE}: ${name}`);
}
