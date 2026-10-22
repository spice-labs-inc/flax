import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATA_FILES,
  isRecord,
  type BoardEntry,
  type BoardFile,
  type DataFileName,
} from "@flax/contract";
import { resolveJourneys } from "@flax/scenarios/dataset/journeys";
import { loadDatasetFiles } from "@flax/scenarios/dataset/load";
import { validateDataset } from "@flax/scenarios/dataset/schema";
import { config } from "@flax/scenarios/config";
import { ENVS } from "@flax/scenarios/lib/types";
import {
  coverageAfter,
  coverageFile,
  historyFile,
  journeysFile,
  readRuns,
  readDocumentation,
  readSurfaces,
} from "./data.ts";
import { scenariosFile, withinBudget } from "./scenarios.ts";
import { usageFile } from "./usage.ts";

export { DATA_FILES, type DataFileName };

export interface BuildInput {
  /** The workspace: surface/, features/, personas/, journeys/ (paths from the config). */
  root: string;
  /** `<env>/<run id>/` directories as `pnpm results:fetch` leaves them. */
  resultsDir: string;
  /** The workspace commit the dataset is at. */
  commit: string;
  now: string;
  board: BoardFile;
  /** The usage history the service keeps (@flax/contract/usage); without it, the file flax.yml names under explorer.usage.history, if any. */
  usage?: unknown;
  /** Downscales failure screenshots in headless Chromium; without it they stay full size. */
  shrink?: <T extends { mediaType: string; base64: string }>(
    shots: T[],
  ) => Promise<{ shots: T[]; shrunk: boolean }>;
  log: (line: string) => void;
}

export class NoRuns extends Error {}

const SHOT_BUDGET = 2_000_000;

/** Every data file, built from the dataset and the runs on disk; throws when the dataset has errors or there are no runs. */
export async function buildData(
  input: BuildInput,
): Promise<Record<DataFileName, unknown>> {
  const { root, resultsDir, commit, now, log } = input;
  const files = readSurfaces(root);
  const documentation = readDocumentation(root);
  const runs = readRuns(resultsDir);
  if (runs.length === 0) throw new NoRuns(`no runs under ${resultsDir}`);

  const coverage = coverageAfter(files, runs, now);
  log(`coverage.json: ${coverage.items.length} items from ${runs.length} runs`);

  const { errors, dataset } = validateDataset(await loadDatasetFiles(root));
  if (errors.length > 0)
    throw new Error(
      `the dataset has errors; pnpm dataset lists them:\n${errors.join("\n")}`,
    );
  const resolved = resolveJourneys(dataset, coverage);
  log(
    `journeys.json: ${dataset.personas.length} personas, ${resolved.journeys.length} journeys, ${resolved.stations.length} stations, ${resolved.orphans.length} orphans`,
  );

  const history = historyFile(root, files, runs, commit, now);
  log(
    `history.json: ${history.snapshots.length} points from ${runs.length} runs (${ENVS.map((e) => `${e} ${runs.filter((r) => r.env === e).length}`).join(", ")}), ${history.scenarios.length} scenarios, ${history.planned.length} planned`,
  );

  const scen = scenariosFile(root, resultsDir, runs, history.scenarios);
  const small = input.shrink
    ? await input.shrink(scen.shots)
    : { shots: scen.shots, shrunk: false };
  const { kept, dropped } = withinBudget(small.shots, SHOT_BUDGET);
  for (const d of scen.file.scenarios)
    for (const recs of Object.values(d.records))
      for (const r of recs) if (r.shot && dropped.has(r.shot)) delete r.shot;
  const shotKb = kept.reduce((n, s) => n + s.base64.length, 0) / 1024;
  log(
    `scenarios.json: ${scen.file.scenarios.length} scenarios; shots.json: ${kept.length} failure screenshots (${shotKb.toFixed(0)} KB${small.shrunk ? ", downscaled" : ""})${dropped.size ? `, ${dropped.size} older ones over the budget left out` : ""}`,
  );

  const open = (xs: BoardEntry[]) =>
    xs.filter((e) => e.state === "open").length;
  log(
    `board.json: ${open(input.board.items)} of ${input.board.items.length} planned issues open, ${open(input.board.bugs)} of ${input.board.bugs.length} bugs open`,
  );

  const usage = usageData(
    input,
    coverage.items.map((i) => i.id),
    log,
  );

  return {
    "coverage.json": coverageFile(coverage, files, documentation, runs),
    "journeys.json": journeysFile(dataset.personas, resolved, commit),
    "history.json": history,
    "scenarios.json": scen.file,
    "shots.json": Object.fromEntries(
      kept.map((s) => [s.key, `data:${s.mediaType};base64,${s.base64}`]),
    ),
    "board.json": input.board,
    "usage.json": usage,
  };
}

/** usage.json, or null when flax.yml has no usage view or no history has arrived yet. */
function usageData(
  input: BuildInput,
  itemIds: string[],
  log: (line: string) => void,
): unknown {
  const cfg = config().usage;
  if (!cfg) return null;
  let raw = input.usage;
  if (raw === undefined && cfg.history) {
    const path = join(input.root, cfg.history);
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8"));
  }
  if (raw === undefined) {
    log("usage.json: no usage history yet, so pages show live use only");
    return null;
  }
  const u = usageFile(raw, itemIds, ENVS, config().timezone);
  const used = Object.keys(u.items).length - u.unmapped.length;
  log(
    `usage.json: ${u.env} use of ${used} items from ${u.firstDay} to ${u.lastDay}${u.unmapped.length ? `; ${u.unmapped.length} keys the map has no item for, counted under their own key: ${u.unmapped.join(", ")}` : ""}`,
  );
  return u;
}

/** The files into `dir`, each screenshot as its own image under shots/ so shots.json only names a path per key. */
export function writeData(
  dir: string,
  data: Record<DataFileName, unknown>,
): void {
  mkdirSync(dir, { recursive: true });
  for (const name of DATA_FILES) {
    const body =
      name === "shots.json" ? shotFiles(dir, data[name]) : data[name];
    writeFileSync(join(dir, name), JSON.stringify(body));
  }
}

export const SHOT_EXT: Record<string, string> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg",
};

function shotFiles(dir: string, shots: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(shots)) return out;
  let n = 0;
  for (const [key, v] of Object.entries(shots)) {
    if (typeof v !== "string") continue;
    const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(v);
    const ext = m && SHOT_EXT[m[1]!];
    if (!m || !ext) {
      out[key] = v;
      continue;
    }
    if (n === 0) mkdirSync(join(dir, "shots"), { recursive: true });
    const path = `shots/${++n}.${ext}`;
    writeFileSync(join(dir, path), Buffer.from(m[2]!, "base64"));
    out[key] = path;
  }
  return out;
}

/** shots.json with each image file read back in as a data URL, for a page that carries its data inside it. */
export function inlineShots(dir: string): Record<string, string> {
  const shots = JSON.parse(
    readFileSync(join(dir, "shots.json"), "utf8"),
  ) as unknown;
  const out: Record<string, string> = {};
  if (!isRecord(shots)) return out;
  for (const [key, v] of Object.entries(shots)) {
    if (typeof v !== "string") continue;
    const ext = /^shots\/[\w-]+\.(\w+)$/.exec(v)?.[1];
    const type = ext && Object.keys(SHOT_EXT).find((t) => SHOT_EXT[t] === ext);
    out[key] = type
      ? `data:${type};base64,${readFileSync(join(dir, v)).toString("base64")}`
      : v;
  }
  return out;
}

/** The board with each issue's state from a boardQuery answer; an issue the answer does not name is unknown. */
export function withBoardStates(
  board: BoardFile,
  answer: unknown,
  checkedAt: string,
): BoardFile {
  const data = isRecord(answer) ? answer["data"] : undefined;
  const stateOf = (i: number): BoardEntry["state"] => {
    const repo = isRecord(data) ? data[`i${i}`] : undefined;
    const issue = isRecord(repo) ? repo["issue"] : undefined;
    const state = isRecord(issue) ? issue["state"] : undefined;
    return state === "OPEN"
      ? "open"
      : state === "CLOSED"
        ? "closed"
        : "unknown";
  };
  let i = 0;
  const mark = <T extends BoardEntry>(e: T): T => ({
    ...e,
    state: stateOf(i++),
  });
  const items = board.items.map(mark);
  const bugs = board.bugs.map(mark);
  return { ...board, checkedAt, items, bugs };
}
