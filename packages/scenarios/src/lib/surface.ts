import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Checkout } from "./repo.ts";
import {
  ENVS,
  type Env,
  type OutOfScope,
  type Sighting,
  type Source,
  type SurfaceFile,
  type SurfaceItem,
  type SurfaceName,
} from "./types.ts";

export interface BuildContext {
  /** Environments this run reads; builders for env-independent surfaces ignore it. */
  envs: Env[];
  now: () => string;
  checkout: (repo: string, ref?: string) => Promise<Checkout>;
  log: (msg: string) => void;
  /** Another surface's items as last built, for a builder that links to them; undefined when it has none. */
  items?: (surface: SurfaceName) => Promise<SurfaceItem[] | undefined>;
}

export interface Builder {
  surface: SurfaceName;
  build: (ctx: BuildContext) => Promise<SurfaceFile>;
}

export function repoSource(co: Checkout, path?: string): Source {
  return path === undefined
    ? { kind: "repo", repo: co.repo, ref: co.ref, commit: co.commit }
    : { kind: "repo", repo: co.repo, ref: co.ref, commit: co.commit, path };
}

export function urlSource(url: string): Source {
  return { kind: "url", url };
}

export function sighting(source: Source, readAt: string, env?: Env): Sighting {
  return env === undefined ? { source, readAt } : { env, source, readAt };
}

function envOrder(a: Env, b: Env): number {
  return ENVS.indexOf(a) - ENVS.indexOf(b);
}

/** 0 for a reading from no env, then the envs in reverse config order, so the first env (the reference one) ranks highest. */
function envRank(env: Env | undefined): number {
  return env === undefined ? 0 : ENVS.length - ENVS.indexOf(env);
}

function readingRank(item: SurfaceItem): number {
  return Math.max(0, ...item.seen.map((s) => envRank(s.env)));
}

/**
 * Combines readings of the same item (e.g. one API operation read from three envs) into one item.
 * Label, area and details come whole from one reading: the first env in the config, else the next, else an
 * env-less one (the first of equals). `envs` and `seen` are unions; env-less sightings sort first.
 */
export function mergeItems(items: SurfaceItem[]): SurfaceItem[] {
  const byId = new Map<string, { item: SurfaceItem; rank: number }>();
  for (const item of items) {
    const rank = readingRank(item);
    const prev = byId.get(item.id);
    if (!prev) {
      byId.set(item.id, {
        item: { ...item, envs: [...item.envs], seen: [...item.seen] },
        rank,
      });
      continue;
    }
    const merged: SurfaceItem =
      rank > prev.rank ? { ...item, envs: [], seen: [] } : prev.item;
    merged.envs = [...new Set([...prev.item.envs, ...item.envs])];
    merged.seen = [...prev.item.seen, ...item.seen];
    byId.set(item.id, { item: merged, rank: Math.max(rank, prev.rank) });
  }
  const out = [...byId.values()].map((v) => v.item);
  for (const item of out) {
    item.envs.sort(envOrder);
    item.seen.sort((a, b) => sightingOrder(a.env) - sightingOrder(b.env));
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Where coverage of an item is required: every env, minus each env whose source was read and
 * lacks the item. `lacks` holds an entry only for envs read successfully, so envs that failed or
 * were not read this run keep the requirement.
 */
export function requiredEnvs(
  id: string,
  lacks: Map<Env, (id: string) => boolean>,
): Env[] {
  return ENVS.filter((e) => !(lacks.get(e)?.(id) ?? false));
}

export function surfaceFile(
  surface: SurfaceName,
  builtAt: string,
  parts: {
    sources: Sighting[];
    items: SurfaceItem[];
    outOfScope?: OutOfScope[];
    notes?: string[];
  },
): SurfaceFile {
  const dupes = parts.items.filter((i) => i.surface !== surface);
  if (dupes.length > 0)
    throw new Error(
      `${surface}: item ${dupes[0]?.id} has surface ${dupes[0]?.surface}`,
    );
  return {
    surface,
    builtAt,
    sources: parts.sources,
    items: mergeItems(parts.items),
    outOfScope: parts.outOfScope ?? [],
    notes: parts.notes ?? [],
  };
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

/** Env-less sightings first, then config order. */
function sightingOrder(env: Env | undefined): number {
  return env === undefined ? -1 : ENVS.indexOf(env);
}
