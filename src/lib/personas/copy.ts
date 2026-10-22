import { CONFIG, ENV_LABEL, ENV_ORDER, type Env } from "../data.ts";
import { STATE_LABEL, type Station, type StationState } from "../personas.ts";

const WORDS = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
  "Twenty",
];

/** A count as a word for a sentence that opens a page: "Eleven"; past twenty, digits. */
export function countWord(n: number): string {
  return WORDS[n] ?? String(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const EDITION_NAME: Record<string, string> =
  CONFIG.vocabulary.editionTitles;

export function editionName(id: string): string {
  return EDITION_NAME[id] ?? id;
}

/** What a matrix cell holds, for its title: "Discover for Consumer: Reads the score (Verified); Opens the trend (Failing)". */
export function cellTitle(
  persona: string,
  stage: string,
  stations: { station: Station; state: StationState }[],
): string {
  if (!stations.length)
    return `${stage} for ${persona}: no station at this stage`;
  const list = stations
    .map((s) => `${s.station.name} (${STATE_LABEL[s.state].toLowerCase()})`)
    .join("; ");
  return `${stage} for ${persona}: ${list}`;
}

/** The environments of a station, read out in config order: "Reads the score: Live failing, Staging verified, Test verified". */
export function hexLabel(
  name: string,
  byEnv: Record<Env, StationState>,
): string {
  const parts = ENV_ORDER.map(
    (env) => `${ENV_LABEL[env]} ${STATE_LABEL[byEnv[env]].toLowerCase()}`,
  );
  return `${name}: ${parts.join(", ")}`;
}

/** Stations in journey order, grouped under each run of one stage so the stage headings keep the journey's order. */
export function groupByStage<T extends { station: Station }>(
  stations: T[],
): { stage: Station["stage"]; start: number; stations: T[] }[] {
  const groups: { stage: Station["stage"]; start: number; stations: T[] }[] =
    [];
  stations.forEach((s, i) => {
    const last = groups[groups.length - 1];
    if (last && last.stage === s.station.stage) last.stations.push(s);
    else groups.push({ stage: s.station.stage, start: i + 1, stations: [s] });
  });
  return groups;
}

export function isHttp(s: string): boolean {
  return /^https?:\/\//.test(s);
}
