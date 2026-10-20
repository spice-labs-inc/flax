import { execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { runMain } from "@flax/agents/collect/tools";
import { mediaSourceDir } from "@flax/agents/lib/job";
import {
  MEDIA_DIR_ENV,
  MEDIA_MODEL_ENV,
  MEDIA_MODEL_FALLBACK_ENV,
  MEDIA_MODEL_SOCKET_ENV,
  MEDIA_ORG_READ_ENV,
} from "@flax/agents/lib/media";
import { workspaceRoot } from "@flax/agents/lib/workspace";
import { writeManifest } from "@flax/agents/media/manifest";
import type { ProposedMedia } from "@flax/agents/output-check/pr";

const run = promisify(execFile);
const log = (line: string) =>
  console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

export const ATLAS = "{{github}}/{{atlasRepo}}";
/** The script in the atlas repository that clones the documented repositories beside the atlas and regenerates the map. */
export const REFRESH_SCRIPT = "{{refreshScript}}";
/**
 * Secrets of job.yml media.secrets the refresh script gets by name, such as
 * an API token it fetches survey data with. None by default: the script
 * works from the repositories alone.
 */
export const SCRIPT_SECRETS: readonly string[] = [];

/** The file the pull request is pinned to: it gives delivery the atlas commit and never changes in a refresh. */
export const ATLAS_PIN_PATH = "viz/package.json";

/** Where in the atlas a refresh may write, and the media file each goes in. */
const MEDIA_DIRS: readonly { repo: string; media: string }[] = [
  { repo: "viz/data/", media: "data/" },
  { repo: "viz/cache/wiring/wiring/", media: "wiring/" },
  { repo: "viz/cache/flows/", media: "flows/" },
];

/** The lines of a file's text, without the final newline. */
export function textLines(text: string): string[] {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return text === "" ? [] : body.split("\n");
}

/** The media file for an atlas path the refresh changed, or undefined for one it may not deliver. */
export function atlasMediaFile(repoPath: string): string | undefined {
  if (!repoPath.endsWith(".json")) return undefined;
  for (const d of MEDIA_DIRS) {
    if (!repoPath.startsWith(d.repo)) continue;
    const rest = repoPath.slice(d.repo.length);
    if (rest === "" || !/^[A-Za-z0-9._-]+$/.test(rest)) return undefined;
    return `${d.media}${rest}`;
  }
  return undefined;
}

/** The changed paths `git status --porcelain` printed, untracked and modified alike; renames and deletions are refused. */
export function changedPaths(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of textLines(porcelain)) {
    if (line.trim() === "") continue;
    const code = line.slice(0, 2);
    const path = line.slice(3);
    if (code.includes("R") || code.includes("D"))
      throw new Error(
        `the refresh renamed or deleted ${path}, which it never should`,
      );
    out.push(path);
  }
  return out.sort();
}

/**
 * The refresh script's wiring settings: with a media model socket, extract
 * through it, keying new answers by the stage's model and asking the
 * fallback model, if the stage has one, for a doc that model gives up on;
 * without one, from the cache only.
 */
export function wiringEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const socket = env[MEDIA_MODEL_SOCKET_ENV] ?? "";
  if (socket === "") return { EXTRACT_WIRING: "0" };
  const model = env[MEDIA_MODEL_ENV] ?? "";
  if (model === "") throw new Error(`${MEDIA_MODEL_ENV} is not set`);
  const fallback = env[MEDIA_MODEL_FALLBACK_ENV] ?? "";
  return {
    EXTRACT_WIRING: "1",
    [MEDIA_MODEL_SOCKET_ENV]: socket,
    ATLAS_WIRING_MODEL: model,
    ...(fallback === "" ? {} : { ATLAS_WIRING_FALLBACK_MODEL: fallback }),
  };
}

/** What a refresh run reports in media.json data. */
export interface AtlasMapSummary {
  before?: { nodes: number; edges: number; steps: number };
  after?: { nodes: number; edges: number; steps: number };
  /** Docs whose wiring was extracted again because their sections changed. */
  reextracted: string[];
  /** Docs whose sections changed but kept their previous wiring this run (no model call left, or the call failed). */
  waiting: string[];
  /** Docs that still have no wiring in the cache. */
  noWiring: string[];
  /** Docs whose new wiring renamed a node a curated flow uses, so they kept their previous wiring. */
  keptForFlows?: string[];
  /** Docs whose new wiring the fallback model made, after the wiring model gave up on them. */
  fallback?: { model: string; docs: string[] };
  advisoriesAsOf?: string;
}

/**
 * The counts and wiring lines out of the refresh script's log. The wiring
 * lines are the atlas generator's own; the counts come from two lines the
 * script prints around it, `current: N nodes, M edges, K flow steps` before
 * and `regenerated: ...` after, and `advisories as of YYYY-MM-DD` when it
 * fetched advisories. A line the script does not print leaves its field
 * unset.
 */
export function summarize(log: string): AtlasMapSummary {
  const counts = (label: string) => {
    const m = log.match(
      new RegExp(`${label}: (\\d+) nodes, (\\d+) edges, (\\d+) flow steps`),
    );
    return m === null
      ? undefined
      : { nodes: Number(m[1]), edges: Number(m[2]), steps: Number(m[3]) };
  };
  const re = log.match(/\d+ re-extracted because their sections changed: (.+)/);
  const waiting = [
    ...log.matchAll(
      /^\s+! ([A-Za-z0-9._-]+): re-extraction (?:failed|deferred)/gm,
    ),
  ].map((m) => m[1]!);
  const noWiring = [...log.matchAll(/^\s+! ([A-Za-z0-9._-]+): wiring\//gm)].map(
    (m) => m[1]!,
  );
  const kept = log.match(
    /\d+ kept their previous wiring because the new answer breaks a curated flow: (.+?)\. /,
  );
  const keptForFlows =
    kept === null ? [] : kept[1]!.split(", ").map((s) => s.trim());
  const fallback = log.match(/\d+ answered by the fallback model (\S+): (.+)/);
  const asOf = log.match(/advisories as of (\d{4}-\d{2}-\d{2})/);
  const before = counts("current");
  const after = counts("regenerated");
  return {
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    reextracted:
      re === null
        ? []
        : re[1]!
            .split(", ")
            .map((s) => s.trim())
            .filter((d) => !keptForFlows.includes(d)),
    waiting: waiting.sort(),
    noWiring,
    ...(keptForFlows.length === 0 ? {} : { keptForFlows }),
    ...(fallback === null
      ? {}
      : {
          fallback: {
            model: fallback[1]!,
            docs: fallback[2]!.split(", ").map((s) => s.trim()),
          },
        }),
    ...(asOf === null ? {} : { advisoriesAsOf: asOf[1]! }),
  };
}

export interface PinnedDocsPage {
  repo: string;
  path: string;
  commit: string;
  lines: string[];
}

/** What media.json data.pr holds for the kit: the pages as read, and the answer built from them. */
export interface DocsPr {
  pages: PinnedDocsPage[];
  answer: {
    pages: {
      repo: string;
      path: string;
      decision: "patch";
      reason: string;
      patch: string;
    }[];
    media: ProposedMedia[];
  };
  /** What a person should know: what was kept or left out and why. */
  notes: string[];
}

/**
 * The pull request: the changed viz data and wiring cache files, pinned to
 * the atlas commit the run read. Nothing changed, nothing to deliver.
 */
export function buildAtlasMapPr(o: {
  commit: string;
  pin: string[];
  changed: readonly string[];
  notes: string[];
}): DocsPr {
  const media = o.changed.map((path) => {
    const file = atlasMediaFile(path);
    if (file === undefined)
      throw new Error(
        `the refresh changed ${path}, outside what it may deliver`,
      );
    return { repo: ATLAS, path, file };
  });
  if (media.length === 0)
    return { pages: [], answer: { pages: [], media: [] }, notes: o.notes };
  return {
    pages: [
      {
        repo: ATLAS,
        path: ATLAS_PIN_PATH,
        commit: o.commit,
        lines: o.pin,
      },
    ],
    answer: { pages: [], media },
    notes: o.notes,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`${name} is not set`);
  return value;
}

/** Runs the atlas's own refresh script, its output to the log and kept for the summary. */
function refresh(cwd: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [REFRESH_SCRIPT], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      out += text;
      process.stdout.write(text);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(
              `${REFRESH_SCRIPT} exited ${code}: ${
                textLines(out)
                  .filter((l) => l.includes("FAILED"))
                  .pop() ?? "see the log"
              }`,
            ),
          ),
    );
  });
}

async function main(): Promise<void> {
  const mediaDir = required(MEDIA_DIR_ENV);
  const orgRead = required(MEDIA_ORG_READ_ENV);
  const source = join(workspaceRoot(), mediaSourceDir(ATLAS));
  if (!existsSync(join(source, REFRESH_SCRIPT)))
    throw new Error(
      `${mediaSourceDir(ATLAS)} has no ${REFRESH_SCRIPT}; list ${ATLAS} in media.sources`,
    );
  const commit = (
    await run("git", ["-C", source, "rev-parse", "HEAD"])
  ).stdout.trim();
  const socket = process.env[MEDIA_MODEL_SOCKET_ENV] ?? "";
  const extract = socket !== "";
  log(
    `atlas ${commit.slice(0, 12)}, wiring ${extract ? "extracted for new and changed docs" : "from the cache only (no media model)"}`,
  );

  // The script clones every documented repository beside the atlas, so the
  // atlas goes in a work directory of its own; the checkout stays read only.
  const work = mkdtempSync(join(tmpdir(), "atlas-map-"));
  const atlas = join(work, "atlas");
  try {
    cpSync(source, atlas, { recursive: true });

    const basic = Buffer.from(`x-access-token:${orgRead}`).toString("base64");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? work,
      GIT_TERMINAL_PROMPT: "0",
      // Sibling clones and the visibility stage read with the org read token; no credential lands on disk.
      GH_TOKEN: orgRead,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      CLONE_SIBLINGS: "1",
      ...Object.fromEntries(SCRIPT_SECRETS.map((s) => [s, required(s)])),
      // The generator asks the socket itself, 2 calls at a time, and keys each new answer by the model that made it.
      ...wiringEnv(process.env),
    };
    const output = await refresh(atlas, env);
    const summary = summarize(output);

    const porcelain = (
      await run("git", [
        "-C",
        atlas,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        "viz/data",
        "viz/cache",
      ])
    ).stdout;
    const changed = changedPaths(porcelain);
    const files: string[] = [];
    for (const path of changed) {
      const file = atlasMediaFile(path);
      if (file === undefined)
        throw new Error(
          `the refresh changed ${path}, outside what it may deliver`,
        );
      mkdirSync(dirname(join(mediaDir, file)), { recursive: true });
      copyFileSync(join(atlas, path), join(mediaDir, file));
      files.push(file);
    }
    const notes: string[] = [];
    if (summary.reextracted.length > 0)
      notes.push(
        `wiring extracted again for ${summary.reextracted.join(", ")} (their sections changed)`,
      );
    if (summary.waiting.length > 0)
      notes.push(
        `wiring kept for ${summary.waiting.join(", ")} although their sections changed; the next run tries again`,
      );
    if (summary.keptForFlows !== undefined)
      notes.push(
        `wiring kept for ${summary.keptForFlows.join(", ")} because the new wiring renames a node a curated flow uses; add an alias in the resolve stage or update the flow in viz/flows/`,
      );
    if (summary.noWiring.length > 0)
      notes.push(`no wiring yet for ${summary.noWiring.join(", ")}`);
    if (summary.fallback !== undefined)
      notes.push(
        `wiring for ${summary.fallback.docs.join(", ")} made by the fallback model ${summary.fallback.model}, after the wiring model gave up on ${summary.fallback.docs.length === 1 ? "it" : "them"}`,
      );
    log(
      `${changed.length} files changed${summary.after ? `; ${summary.after.nodes} nodes, ${summary.after.edges} edges, ${summary.after.steps} flow steps` : ""}`,
    );
    await writeManifest(mediaDir, files, {
      atlas: commit,
      summary,
      pr: buildAtlasMapPr({
        commit,
        pin: textLines(readFileSync(join(source, ATLAS_PIN_PATH), "utf8")),
        changed,
        notes,
      }),
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await runMain(import.meta.url, "{{name}}", main);
