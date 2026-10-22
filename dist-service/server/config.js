import { loadWorkspace, section } from "@flax/core";
import { isRecord } from "@flax/contract";
import { workspaceRoot } from "@flax/scenarios/config";
const str = (v, d) => (typeof v === "string" ? v : d);
/** The `explorer:` section of flax.yml with defaults; the shared keys give the repo its default owner. */
export function explorerConfig(dir = workspaceRoot()) {
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
                extraJobs: Array.isArray(r["extraJobs"])
                    ? r["extraJobs"].filter((j) => typeof j === "string")
                    : [],
            }
            : null,
    };
}
//# sourceMappingURL=config.js.map