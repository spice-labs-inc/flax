import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runMain } from "@flax/agents/collect/tools";
import { mediaSourceDir } from "@flax/agents/lib/job";
import {
  MEDIA_DIR_ENV,
  MEDIA_MODEL_ENV,
  MEDIA_MODEL_SOCKET_ENV,
} from "@flax/agents/lib/media";
import { workspaceRoot } from "@flax/agents/lib/workspace";
import { writeManifest } from "@flax/agents/media/manifest";

const run = promisify(execFile);
const ATLAS = "{{github}}/{{atlasRepo}}";
/** The wiring evaluation script, relative to the atlas checkout; it takes --socket, --model, --sample and --json. */
const EVAL_SCRIPT = "{{evalScript}}";
const SAMPLE = 20;

/** What the atlas's wiring evaluation writes with --json. */
export interface EvalResults {
  model: string;
  results: {
    doc: string;
    sectionsChanged?: boolean;
    cachedEdges: number;
    candidateEdges?: number;
    matched?: unknown[];
    extra?: unknown[];
    missing?: unknown[];
    error?: string;
  }[];
}

/** One candidate's numbers over every doc it answered. */
export interface EvalTotals {
  model: string;
  docs: number;
  failed: number;
  agree: number;
  extra: number;
  missing: number;
  /** Percent of the candidate's edges the cached answer has; undefined with no edges. */
  precision?: number;
  /** Percent of the cached answer's edges the candidate drew; undefined with no edges. */
  recall?: number;
}

export function evalTotals(results: EvalResults): EvalTotals {
  const ok = results.results.filter((r) => r.error === undefined);
  const count = (pick: (r: (typeof ok)[number]) => unknown[] | undefined) =>
    ok.reduce((n, r) => n + (pick(r)?.length ?? 0), 0);
  const agree = count((r) => r.matched);
  const extra = count((r) => r.extra);
  const missing = count((r) => r.missing);
  const pct = (n: number, d: number) =>
    d === 0 ? undefined : Math.round((100 * n) / d);
  const precision = pct(agree, agree + extra);
  const recall = pct(agree, agree + missing);
  return {
    model: results.model,
    docs: results.results.length,
    failed: results.results.length - ok.length,
    agree,
    extra,
    missing,
    ...(precision === undefined ? {} : { precision }),
    ...(recall === undefined ? {} : { recall }),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const mediaDir = required(MEDIA_DIR_ENV);
  const socket = required(MEDIA_MODEL_SOCKET_ENV);
  const model = required(MEDIA_MODEL_ENV);
  const atlas = join(workspaceRoot(), mediaSourceDir(ATLAS));
  const commit = (
    await run("git", ["-C", atlas, "rev-parse", "HEAD"])
  ).stdout.trim();
  const work = mkdtempSync(join(tmpdir(), "wiring-eval-"));
  const json = join(work, "wiring-eval.json");
  try {
    const { stdout } = await run(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        EVAL_SCRIPT,
        "--socket",
        socket,
        "--model",
        model,
        "--sample",
        String(SAMPLE),
        "--json",
        json,
      ],
      { cwd: atlas, maxBuffer: 16 * 1024 * 1024 },
    );
    process.stdout.write(stdout);
    writeFileSync(join(mediaDir, "wiring-eval.txt"), stdout);
    const results = JSON.parse(readFileSync(json, "utf8")) as EvalResults;
    const totals = evalTotals(results);
    if (totals.docs > 0 && totals.failed === totals.docs)
      throw new Error(`every doc failed with ${model}; see wiring-eval.txt`);
    await writeManifest(mediaDir, ["wiring-eval.txt"], {
      atlas: commit,
      totals,
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await runMain(import.meta.url, "{{name}}", main);
