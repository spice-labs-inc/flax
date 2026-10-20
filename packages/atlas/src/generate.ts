// `flax atlas generate`: assemble the stages and run the machine.
//
//   --no-cache          re-run every AI stage instead of reusing cached answers
//   --reuse-wiring      on a prompt-hash miss, reuse the cached extraction for that
//                       doc instead of calling the model (data-only refresh)
//   --reextract-changed like --reuse-wiring, but call the model for new docs and
//                       for docs whose wiring sections changed since their answer
//                       (data/wiring-sections.json); a model or prompt change alone
//                       re-extracts nothing
//   --max-extractions N at most N docs call the model this run; the others keep
//                       their previous answer (or stay without one) until a later run
//   --only a,b,c        restrict to these repos (debugging)
//   --workspace <dir>   the directory holding flax.yml (default: the current directory)
//   --viz <path>        the directory holding data/, cache/, flows/ and prompts/
//                       (default: atlas.viz in flax.yml, `viz` under the atlas root)

import { resolve as resolvePath } from "node:path";
import { loadAtlas } from "./config.ts";
import type { Ctx, Stage } from "./pipeline/machine.ts";

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else args[key] = true;
  }
  return args;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const workspaceDir =
    typeof args.workspace === "string"
      ? resolvePath(args.workspace)
      : process.cwd();
  const {
    config: cfg,
    atlasRoot,
    vizRoot: configuredViz,
  } = loadAtlas(workspaceDir);
  const vizRoot =
    typeof args.viz === "string" ? resolvePath(args.viz) : configuredViz;

  // The model env names come from the config, so the pipeline loads after it.
  const { runPipeline } = await import("./pipeline/machine.ts");
  const { pickBackend, MODEL } = await import("./pipeline/llm.ts");
  const { readAtlas } = await import("./stages/read-atlas.ts");
  const { buildEdges, components, visibility } =
    await import("./stages/components.ts");
  const { manifests } = await import("./stages/manifests.ts");
  const { wiring } = await import("./stages/wiring.ts");
  const { sharedDeps } = await import("./stages/shared-deps.ts");
  const { advisories } = await import("./stages/advisories.ts");
  const { deployments } = await import("./stages/deployments.ts");
  const { infra } = await import("./stages/infra.ts");
  const { flows } = await import("./stages/flows.ts");
  const { coAdvisory } = await import("./stages/co-advisory.ts");
  const { tenancy } = await import("./stages/tenancy.ts");
  const { layout } = await import("./stages/layout.ts");
  const { layout2d } = await import("./stages/layout2d.ts");
  const { emit, resolve } = await import("./stages/resolve.ts");

  const STAGES: Stage[] = [
    readAtlas, // code: parse frontmatter + sections
    visibility, // code: public / internal / private from GitHub
    components, // code: repos -> components
    buildEdges, // code: depends_on -> build layer
    manifests, // code: cross-check depends_on against real manifests
    wiring, // ai:   prose -> network / queue / data layers
    sharedDeps, // code: portfolio containment -> the shared-dependency layer
    advisories, // code: advisory capture -> advisory nodes
    infra, // code: environments, fleet, delivery layer
    deployments, // code: gitops overlays -> what is deployed where
    flows, // code: curated guided flows from flows/*.md
    resolve, // code: canonicalise, resolve, drop unresolvable
    coAdvisory, // code: who is exposed to the same advisory as who
    // code: tenancy split and plane fixes, only when the config asks for them
    ...(cfg.map.tenancy || Object.keys(cfg.map.planeFix).length
      ? [tenancy]
      : []),
    layout, // code: precompute 3D positions offline
    layout2d, // code: precompute the grouped 2D layouts offline
    emit, // code: write graph.json + report.json
  ];

  const ctx: Ctx = {
    atlasRoot,
    vizRoot,
    out: {},
    only:
      typeof args.only === "string"
        ? args.only.split(",").map((s) => s.trim())
        : undefined,
    noCache: args["no-cache"] === true,
    reuseStale:
      args["reuse-wiring"] === true || args["reextract-changed"] === true,
    reextractChanged: args["reextract-changed"] === true,
    maxExtractions:
      typeof args["max-extractions"] === "string"
        ? Number(args["max-extractions"])
        : undefined,
    log: (m) => console.log(m),
  };

  console.log(`${cfg.site.title}: map generator`);
  console.log(`  atlas   ${atlasRoot}`);
  console.log(`  viz     ${vizRoot}`);
  console.log(`  model   ${MODEL || "(none set)"} via ${pickBackend()}`);
  console.log(`  cache   ${ctx.noCache ? "disabled" : "enabled"}`);
  console.log(
    `  wiring  ${ctx.reextractChanged ? "re-extract new docs and docs whose sections changed, reuse the rest" : ctx.reuseStale ? "reuse cached on prompt change" : "re-extract on prompt change"}${ctx.maxExtractions === undefined ? "" : `, at most ${ctx.maxExtractions} docs ask the model`}`,
  );
  console.log("");

  await runPipeline(STAGES, ctx);
  return 0;
}
