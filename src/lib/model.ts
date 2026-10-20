import { DATA_FILES, type DataFileName } from "@flax/contract";
import {
  coverageModel,
  type BoardFile,
  type CoverageData,
  type HistoryFile,
  ENVS,
} from "./data.ts";
import { featuresModel } from "./features.ts";
import { nowModel } from "./now.ts";
import { personaDefsModel, type DatasetFile } from "./personaDefs.ts";
import { personasModel } from "./personas.ts";
import { planningModel } from "./planning.ts";
import { proofModel } from "./proof.ts";
import { scenariosModel, type ScenariosFile } from "./scenarios.ts";
import { verdictModel } from "./verdict.ts";

export { DATA_FILES, type DataFileName };

export interface DataFiles {
  coverage: CoverageData;
  journeys: DatasetFile;
  history: HistoryFile;
  scenarios: ScenariosFile;
  shots: Record<string, string>;
  board: BoardFile;
}

/** Which data version the files are: a service build's name, or the one baked into a single-file page. */
export interface Manifest {
  version: string;
  builtAt: string;
}

export class DataError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasArrays = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  isObject(v) && keys.every((k) => Array.isArray(v[k]));

/**
 * The files as the model reads them; a screenshot named by a path is served under `base`. Only their outer
 * shape is checked here: every file comes from the same data build at one version, which writes them from typed
 * code, so a file with the right outer shape has the rest of it.
 */
export function dataFiles(
  raw: Record<DataFileName, unknown>,
  base = "",
): DataFiles {
  const coverage = raw["coverage.json"];
  const journeys = raw["journeys.json"];
  const history = raw["history.json"];
  const scenarios = raw["scenarios.json"];
  const shots = raw["shots.json"];
  const board = raw["board.json"];
  if (!hasArrays(coverage, ["surfaces", "items"]))
    throw new DataError("coverage.json is not a coverage file");
  if (!hasArrays(journeys, ["personas", "stations", "journeys", "orphans"]))
    throw new DataError("journeys.json is not a journeys file");
  if (!hasArrays(history, ["scenarios", "planned", "snapshots"]))
    throw new DataError("history.json is not a history file");
  if (!hasArrays(scenarios, ["runs", "scenarios", "features"]))
    throw new DataError("scenarios.json is not a scenarios file");
  if (!isObject(shots))
    throw new DataError("shots.json is not a set of screenshots");
  const shotUrls: Record<string, string> = {};
  for (const [k, v] of Object.entries(shots)) {
    if (typeof v !== "string") continue;
    if (v.startsWith("data:image/")) shotUrls[k] = v;
    else if (base && /^shots\/[\w.-]+$/.test(v)) shotUrls[k] = `${base}/${v}`;
  }
  if (!hasArrays(board, ["items", "bugs"]))
    throw new DataError("board.json is not a board file");
  return {
    coverage: coverage as unknown as CoverageData,
    journeys: journeys as unknown as DatasetFile,
    history: alignHistory(history as unknown as HistoryFile, ENVS),
    scenarios: scenarios as unknown as ScenariosFile,
    shots: shotUrls,
    board: board as unknown as BoardFile,
  };
}

/** Everything the explorer shows, built once per data version and handed down from the layout's load. */
export function createModel(files: DataFiles) {
  const cov = coverageModel(files.coverage, files.history, files.board);
  const defs = personaDefsModel(files.journeys);
  const pers = personasModel(cov, defs);
  const scen = scenariosModel(cov, files.scenarios, files.shots);
  const verdicts = verdictModel(cov, scen);
  const proof = proofModel(cov, pers, scen);
  const feats = featuresModel(cov, scen, pers, files.scenarios.features);
  const now = nowModel(cov, scen, feats, pers);
  const planning = planningModel(cov, scen, pers, defs, feats);
  return {
    ...cov,
    ...defs,
    ...pers,
    ...scen,
    ...verdicts,
    ...proof,
    ...feats,
    ...now,
    ...planning,
  };
}

export type Model = ReturnType<typeof createModel>;

/** A status string's characters for one thing, taken from the file's env order into `envs` order; an env the file lacks reads "0". */
function realign(
  text: string,
  from: readonly string[],
  envs: readonly string[],
): string {
  const width = from.length;
  const count = width === 0 ? 0 : Math.floor(text.length / width);
  let out = "";
  for (let i = 0; i < count; i++)
    for (const env of envs) {
      const at = from.indexOf(env);
      out += at < 0 ? "0" : (text[i * width + at] ?? "0");
    }
  return out;
}

/**
 * A history file in this page's env order. A file built for another order (its `envs` field says which,
 * as an older data build or another workspace's configuration wrote it) has each snapshot's per-env
 * strings permuted; a file that names no envs is taken as already in order.
 */
export function alignHistory(
  history: HistoryFile,
  envs: readonly string[],
): HistoryFile {
  const from = Array.isArray(history.envs) ? history.envs : undefined;
  if (
    !from ||
    (from.length === envs.length && from.every((e, i) => e === envs[i]))
  )
    return history;
  return {
    ...history,
    envs: [...envs],
    snapshots: history.snapshots.map((s) => ({
      ...s,
      status: realign(s.status, from, envs),
      scen: realign(s.scen, from, envs),
      planned: realign(s.planned, from, envs),
    })),
  };
}
