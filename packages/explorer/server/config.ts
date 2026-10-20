import { loadWorkspace, section } from "@flax/core";
import { isRecord } from "@flax/contract";
import { workspaceRoot } from "@flax/scenarios/config";

/** Where scheduled runs leave their results as GitHub workflow artifacts, for the service's fallback and the refresh. */
export interface ResultsSource {
  /** `owner/name` of the repository whose workflow uploads the artifacts. */
  repo: string;
  /** The workflow file name, for listing runs in progress. */
  workflow: string;
  /** The job name the artifacts are named after: `<job>-<env>`, `<job>-shadow-<env>`. */
  job: string;
}

export interface ExplorerConfig {
  title: string;
  description: string;
  /** The port the service listens on. */
  port: number;
  results: ResultsSource | null;
}

const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);

/** The `explorer:` section of flax.yml with defaults; the shared keys give the repo its default owner. */
export function explorerConfig(dir = workspaceRoot()): ExplorerConfig {
  const ws = loadWorkspace(dir);
  const e = section(ws, "explorer");
  const r = isRecord(e["results"]) ? e["results"] : undefined;
  const repo = r ? str(r["repo"], "") : "";
  return {
    title: str(e["title"], `${ws.org} scenarios`),
    description: str(e["description"], ""),
    port: typeof e["port"] === "number" ? e["port"] : 8081,
    results: r
      ? {
          repo: repo.includes("/") ? repo : `${ws.github ?? ws.org}/${repo}`,
          workflow: str(r["workflow"], "scenario-checks.yml"),
          job: str(r["job"], "scenario-checks"),
        }
      : null,
  };
}
