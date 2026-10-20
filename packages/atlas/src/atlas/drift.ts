// `flax atlas drift`: docs whose analyzed_commit is behind their repository's head,
// and whether the drift is noise (version pins, regenerated data) that only
// needs a stamp. It asks `gh api` directly, one call per doc.

import { execFileSync } from "node:child_process";
import { config } from "../config.ts";
import { fsSource, readDocs } from "./doc.ts";

export interface ComparedFile {
  filename: string;
  status: string;
  patch?: string;
}

const IMAGE_LINE = /^[+-]\s*image:\s/;

/**
 * Drift that cannot change what a doc says: in a repo listed under
 * docs.driftNoise, only files matching its `paths` patterns, plus files under
 * `imagePinsIn` whose every changed line is an image: pin. Anything else, an
 * unknown repository or a missing comparison is real.
 */
export function isNoise(
  repo: string,
  files: ComparedFile[] | undefined,
): boolean {
  const rule = config().docs.driftNoise[repo];
  if (!rule || !files || files.length === 0) return false;
  const paths = rule.paths.map((p) => new RegExp(p));
  const pins = (rule.imagePinsIn ?? []).map((p) => new RegExp(p));
  return files.every((f) => {
    if (paths.some((re) => re.test(f.filename))) return true;
    if (
      !pins.some((re) => re.test(f.filename)) ||
      f.status !== "modified" ||
      f.patch === undefined
    )
      return false;
    const changed = f.patch
      .split("\n")
      .filter(
        (l) =>
          (l.startsWith("+") || l.startsWith("-")) &&
          !l.startsWith("+++") &&
          !l.startsWith("---"),
      );
    return changed.length > 0 && changed.every((l) => IMAGE_LINE.test(l));
  });
}

const gh = (path: string, jq: string): string =>
  execFileSync("gh", ["api", path, "--jq", jq], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 << 20,
  }).trim();

/** The head sha of a repository's default branch, or undefined. */
export function headOf(repo: string): string | undefined {
  try {
    const sha = gh(`repos/${repo}/commits?per_page=1`, ".[0].sha");
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

export function compare(
  repo: string,
  base: string,
  head: string,
): ComparedFile[] | undefined {
  try {
    const out = gh(
      `repos/${repo}/compare/${base}...${head}`,
      "[.files[] | {filename, status, patch}]",
    );
    return out ? (JSON.parse(out) as ComparedFile[]) : undefined;
  } catch {
    return undefined;
  }
}

export interface DriftLine {
  name: string;
  analyzed: string;
  head: string;
  noise: boolean;
}

/** The GitHub reads drift needs; a test passes fakes. */
export interface DriftApi {
  headOf: typeof headOf;
  compare: typeof compare;
}

export function findDrift(
  root: string,
  classify: boolean,
  api: DriftApi = { headOf, compare },
): { drifted: DriftLine[]; unresolved: string[] } {
  const org = config().org.github;
  const drifted: DriftLine[] = [];
  const unresolved: string[] = [];
  for (const d of readDocs(fsSource(root))) {
    if (String(d.fm.analysis_source ?? "") === "local-stale") continue;
    const name = String(d.fm.name ?? d.name);
    const repo = String(d.fm.repo ?? `${org}/${name}`);
    const analyzed = String(d.fm.analyzed_commit ?? "").split(" ")[0];
    if (!analyzed) continue;
    const head = api.headOf(repo);
    if (!head) {
      unresolved.push(name);
      continue;
    }
    if (head.startsWith(analyzed)) continue;
    const noise =
      classify && config().docs.driftNoise[name]
        ? isNoise(name, api.compare(repo, analyzed, head))
        : false;
    drifted.push({ name, analyzed, head, noise });
  }
  return { drifted, unresolved };
}

export function cmdDrift(
  root: string,
  o: { log: (s: string) => void; noise: boolean },
): number {
  const { drifted, unresolved } = findDrift(root, o.noise);
  for (const u of unresolved) o.log(`UNRESOLVABLE ${u}`);
  for (const d of drifted)
    o.log(`${d.name} ${d.analyzed} ${d.head}${d.noise ? " noise" : ""}`);
  o.log(
    `drift: ${drifted.length} docs behind their repo (${drifted.filter((d) => d.noise).length} noise), ${unresolved.length} unresolvable`,
  );
  return drifted.some((d) => !d.noise) ? 1 : 0;
}
