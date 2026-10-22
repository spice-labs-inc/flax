import {
  ENV_LABEL,
  formatPacific,
  formatPacificDay,
  type Env,
  CONFIG,
} from "../data.ts";
import { KIND_LABEL, stepPlace, type FailureKind } from "../failureKind.ts";
import type { EnvNow, Failing } from "../now.ts";
import type { Version } from "../scenarios.ts";

/** "4:28 PM PDT": the time of day with its zone, for a run that finished today. */
export function clockWithZone(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CONFIG.timezone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

/** "at 4:28 PM PDT" today, "at 2:49 PM PDT on Oct 12" on another day. */
export function whenPhrase(iso: string, ref: number): string {
  const day = formatPacificDay(iso);
  const same = day === formatPacificDay(new Date(ref).toISOString());
  return same
    ? `at ${clockWithZone(iso)}`
    : `at ${clockWithZone(iso)} on ${day}`;
}

/** How long before a reference instant something happened, in round words. */
export function ago(iso: string, ref: number): string {
  const ms = ref - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const h = Math.round(ms / 3_600_000);
  if (h < 48) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(ms / 86_400_000);
  return `${d} days ago`;
}

/** One sentence that says what an env's last run found, at a timeline point. */
export function statement(e: EnvNow, ref: number): string {
  const label = ENV_LABEL[e.env];
  if (!e.run) return `${label} has no run at this point.`;
  const when = whenPhrase(e.run.finishedAt, ref);
  if (e.ran === 0) return `${label} ran ${when} but recorded no scenarios.`;
  const unreached = e.unreachable.length;
  const failed = e.failed - unreached;
  if (failed === 0) {
    if (unreached > 0)
      return `${unreached} of ${e.ran} scenarios could not reach ${label} ${when}; ${e.passed} verified.`;
    if (e.passed === 0) return `${label} verified nothing ${when}.`;
    return `All ${e.passed} scenarios verified on ${label} ${when}.`;
  }
  const oldest = e.failing[e.failing.length - 1]!;
  const sinceWord = failed === 1 ? "since" : "the oldest since";
  const head = `${failed} of ${e.ran} scenarios failing on ${label}, ${sinceWord} ${formatPacific(oldest.since)}.`;
  return unreached ? `${head} ${unreached} more could not reach it.` : head;
}

/** What the env's runs leave unchecked on the map, and why, so a clean run never reads as a perfect one. */
export function notCheckedText(e: EnvNow): string | undefined {
  const n = e.notChecked;
  if (!n.total) return undefined;
  const label = ENV_LABEL[e.env];
  const noFixtures =
    CONFIG.envs.find((x) => x.name === e.env)?.fixtures !== "always";
  const fixture = noFixtures ? n.fixture : 0;
  const admin = n.internalAdmin;
  const rest = n.elsewhere - fixture - admin;
  const parts = [
    fixture
      ? `for ${fixture}, every scenario that reaches ${fixture === 1 ? "it" : "them"} creates a fixture, which ${label} runs never do`
      : "",
    admin
      ? `${admin} ${admin === 1 ? "is" : "are"} reached only by scenarios ${label} runs leave out by tag`
      : "",
    rest
      ? `${rest} ${rest === 1 ? "is" : "are"} reached only by scenarios that do not run on ${label}`
      : "",
    n.partial
      ? `${n.partial} ${n.partial === 1 ? "is" : "are"} verified there for only part of what ${n.partial === 1 ? "it" : "they"} must prove`
      : "",
    n.skipped
      ? `${n.skipped} ${n.skipped === 1 ? "was" : "were"} skipped there`
      : "",
  ].filter(Boolean);
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join("; ")}; and ${parts[parts.length - 1]}`;
  const items = n.total === 1 ? "1 item" : `${n.total} items`;
  return `They leave ${items} on the map not checked on ${label}: ${list}.`;
}

/** Names in a sentence: "A", "A and B", "A, B and C", or the first few "and 3 more". */
export function nameList(names: string[], max = 4, more = "more"): string {
  const shown = names.length > max ? names.slice(0, max - 1) : names;
  const left = names.length - shown.length;
  if (left > 0) return `${shown.join(", ")} and ${left} ${more}`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** Who a failure blocks, in a sentence: the stations and personas its failing step stops, or that it stops none. */
export function blocksText(f: Failing): string {
  const { items, stations, personas } = f.blocks;
  const place = stepPlace(f.failedAt);
  if (!items.length)
    return `It fails ${place}, which touches nothing on the map, so it blocks no customer journey.`;
  const labels = items.map((it) => it.label);
  const named =
    items.length <= 3
      ? nameList(labels)
      : `${items.length} items, among them ${labels[0]} and ${labels[1]}`;
  const fails = f.blocks.atStep
    ? `Step ${f.failedAt + 1} touches ${named}.`
    : `It fails ${place}, and the map shows ${named} failing with it.`;
  if (!stations.length)
    return `${fails} No persona's journey uses ${items.length === 1 ? "it" : "them"}, so it blocks no customer journey.`;
  const who =
    personas.length === 1
      ? `1 persona: ${personas[0]!.name}`
      : `${personas.length} personas: ${nameList(personas.map((p) => p.name))}`;
  return `It blocks ${nameList(stations.map((s) => s.name))} for ${who}. ${fails}`;
}

/** A card's failure kinds, each with the evidence from every env that reads that way. */
export function kindLines(
  envs: Failing[],
): { kind: FailureKind; label: string; texts: string[] }[] {
  const out: { kind: FailureKind; label: string; texts: string[] }[] = [];
  for (const f of envs) {
    const line = out.find((l) => l.kind === f.kind.kind);
    if (line) line.texts.push(f.kind.text);
    else
      out.push({
        kind: f.kind.kind,
        label: KIND_LABEL[f.kind.kind],
        texts: [f.kind.text],
      });
  }
  return out;
}

/** "Staging and Test". */
export function envList(envs: Env[]): string {
  return nameList(envs.map((e) => ENV_LABEL[e]));
}

/** A scenario name read as a sentence: it ends with a period. */
export function sentence(name: string): string {
  const t = name.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** "api ae8d1f0, built Oct 13, 11:37 AM PDT; dashboard 5ee8fee": what a run ran against. */
export function buildText(versions: Version[]): string {
  return versions
    .map((v) => {
      let s = v.service;
      if (v.release) s += ` ${v.release.slice(0, 7)}`;
      if (v.builtAt) s += `, built ${formatPacific(v.builtAt)}`;
      return s;
    })
    .join("; ");
}

/** Who a card's failure blocks, one sentence per set of envs it blocks alike; each names its envs when they differ. */
export function cardBlocks(envs: Failing[]): string[] {
  const sets = new Map<string, Failing[]>();
  for (const f of envs) {
    const key = f.blocks.items.map((it) => it.idx).join(",");
    sets.set(key, [...(sets.get(key) ?? []), f]);
  }
  if (sets.size === 1) return [blocksText(envs[0]!)];
  return [...sets.values()].map((list) => {
    const text = blocksText(list[0]!);
    return `On ${envList(list.map((f) => f.env))}, ${text[0]!.toLowerCase()}${text.slice(1)}`;
  });
}

/** What the runs ran against, once when every env ran the same builds. */
export function cardBuilds(envs: Failing[]): string[] {
  const withBuilds = envs.filter((f) => f.versions.length);
  const texts = new Set(withBuilds.map((f) => buildText(f.versions)));
  if (texts.size === 0) return [];
  if (texts.size === 1) return [`Ran against ${[...texts][0]}.`];
  return withBuilds.map(
    (f) => `${ENV_LABEL[f.env]} ran against ${buildText(f.versions)}.`,
  );
}
