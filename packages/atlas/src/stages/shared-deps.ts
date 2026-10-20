// Stage 6 (code): the shared-dependency layer.
//
// Emits an edge between two components when a survey found both containing the
// same items. The other layers read relationships out of documents; this one
// measures them, so its edges are marked `derived` and the viewer says so. A
// shared transitive jar is not an architectural relationship and should not be
// read as one.
//
// Input is the containment snapshot named by sources.containment in flax.yml
// (data/containment.json by default), committed by whatever fetches it from your
// inventory tool. It is stale by design and the generator never reaches the
// network. With no snapshot present the stage emits nothing and says so: it
// must never break a run for people who only edit the atlas.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphEdge } from '../model/types.ts';
import type { Ctx, Stage } from '../pipeline/machine.ts';
import { config } from '../config.ts';
import type { ComponentIndex } from './components.ts';
import { assertTargetsExist, componentForSubject, readSubjectMap } from './subject-map.ts';

/**
 * An item held by at most this many components is distinctive: close to a
 * fingerprint of a real relationship rather than of the ambient ecosystem. A
 * pair must share at least one of these before it gets an edge at all, which is
 * what stops "everyone depends on log4j" from connecting the whole map.
 */
const RARE_MAX = 3;

/**
 * Items held by more than this fraction of mapped components are excluded
 * outright. They are the JVM and the Rust standard ecosystem, and their IDF
 * weight rounds to noise anyway; dropping them early also keeps the pair
 * enumeration from going quadratic over things that can never matter.
 */
const UBIQUITY = 0.5;

/** How many of the most distinctive shared items each edge carries for display. */
const TOP_SHARED = 8;

/**
 * The package ecosystems this layer reads, as an allowlist rather than a list of
 * exclusions: an unrecognised purl type is far more likely to be a new flavour of
 * image furniture than a new way of declaring a dependency.
 *
 * What the exclusions cost us, and why each is right here:
 *
 * - `apk` / `deb` / `rpm` are the base image. Two services sharing alpine's
 *   busybox share a FROM line, not a dependency, and left in they dominate
 *   everything — base-image choice partitions components into alpine/ubuntu/
 *   debian clusters, and inside a cluster those packages look rare enough to
 *   pass the distinctiveness gate on their own.
 * - `generic/x509` and `generic/pgp` are trust material, not code.
 * - `github` is a GitHub Action used by a workflow. Real shared tooling, but it
 *   is CI configuration rather than anything that ships.
 * - `golang` appears only as vendored tooling inside images here — Go module
 *   coordinates were turning up inside Java and Scala components. Add it back
 *   the day we actually ship something written in Go.
 */
const APP_ECOSYSTEMS = new Set(['maven', 'cargo', 'npm', 'pypi', 'gem', 'nuget']);

/** Whether a package says something about the application rather than its base. */
function isApplicationPackage(purl: string): boolean {
  if (!purl.startsWith('pkg:')) return false;
  const slash = purl.indexOf('/', 4);
  const type = purl.slice(4, slash === -1 ? undefined : slash);
  return APP_ECOSYSTEMS.has(type);
}

interface Snapshot {
  fetchedAt: string;
  source: { api: string; org?: string; project: string };
  items: string[];
  purls: Array<string | null>;
  subjects: Array<{ subject: string; total: number; items: number[] }>;
}


export const sharedDeps: Stage = {
  id: 'sharedDeps',
  kind: 'code',
  title: 'Shared-dependency layer from portfolio containment',
  async run(ctx: Ctx): Promise<GraphEdge[]> {
    const snapPath = join(ctx.vizRoot, config().sources.containment);
    if (!existsSync(snapPath)) {
      ctx.log(`        no ${config().sources.containment} (a committed containment snapshot); layer skipped`);
      return [];
    }
    const snap: Snapshot = JSON.parse(readFileSync(snapPath, 'utf8'));
    const idx = ctx.out.components as ComponentIndex;
    const map = readSubjectMap(ctx.vizRoot);

    const byId = new Map(idx.nodes.map((n) => [n.id, n]));
    const byLabel = new Map(idx.nodes.map((n) => [n.label.toLowerCase(), n.id]));

    // Validate every curated target up front, not lazily when a subject happens
    // to match. A mapping pointing at a component that no longer exists is a bug
    // whether or not the registry currently mentions the subject.
    assertTargetsExist(map, byId);

    // -- subject -> component ------------------------------------------------
    const itemsOf = new Map<string, Set<number>>(); // component id -> item indices
    const subjectsOf = new Map<string, string[]>(); // component id -> subjects folded in
    const unmapped: string[] = [];
    let autoMatched = 0;

    for (const s of snap.subjects) {
      if (map.ignored(s.subject)) continue;

      const explicit = map.explicit.get(s.subject);
      const component = componentForSubject(s.subject, map, byId, byLabel);
      if (!component) {
        unmapped.push(s.subject);
        continue;
      }
      if (!explicit) autoMatched++;

      if (!itemsOf.has(component)) {
        itemsOf.set(component, new Set());
        subjectsOf.set(component, []);
      }
      const set = itemsOf.get(component)!;
      for (const i of s.items) set.add(i);
      subjectsOf.get(component)!.push(s.subject);
    }

    const mapped = [...itemsOf.keys()].sort();
    ctx.log(
      `        ${mapped.length} components mapped from ${snap.subjects.length} subjects ` +
        `(${autoMatched} by name, ${map.explicit.size} curated)`,
    );
    if (unmapped.length) {
      ctx.log(`        ! ${unmapped.length} subjects map to nothing and are not ignored:`);
      for (const s of unmapped.slice(0, 20)) ctx.log(`        !   ${s}`);
      if (unmapped.length > 20) ctx.log(`        !   ...and ${unmapped.length - 20} more`);
      ctx.log('        ! add them to subjects.md under ## mappings or ## ignore');
    }
    if (mapped.length < 2) {
      ctx.log('        fewer than two components mapped — nothing can be shared; layer skipped');
      return [];
    }

    // -- which components hold each item -------------------------------------
    const holders = new Map<number, string[]>();
    for (const c of mapped) {
      for (const i of itemsOf.get(c)!) {
        const list = holders.get(i);
        if (list) list.push(c);
        else holders.set(i, [c]);
      }
    }

    const ubiquitousAt = Math.max(2, Math.floor(mapped.length * UBIQUITY));
    let ubiquitous = 0;
    let baseImage = 0;
    const distinctive: Array<{ item: number; held: string[]; weight: number }> = [];
    for (const [item, held] of holders) {
      if (held.length < 2) continue;
      if (!isApplicationPackage(snap.purls[item] ?? snap.items[item])) {
        baseImage++;
        continue;
      }
      if (held.length > ubiquitousAt) {
        ubiquitous++;
        continue;
      }
      distinctive.push({ item, held, weight: 1 / Math.log(1 + held.length) });
    }
    ctx.log(`        ${baseImage} shared items excluded as base-image or trust material`);
    ctx.log(
      `        ${distinctive.length} distinctive shared items; ` +
        `${ubiquitous} excluded as ubiquitous (held by more than ${ubiquitousAt} of ${mapped.length})`,
    );

    // -- pairwise accumulation -----------------------------------------------
    interface Pair {
      a: string;
      b: string;
      shared: number;
      rare: number;
      score: number;
      top: Array<{ item: number; held: number }>;
    }
    const pairs = new Map<string, Pair>();
    for (const d of distinctive) {
      const held = [...d.held].sort();
      for (let i = 0; i < held.length; i++) {
        for (let j = i + 1; j < held.length; j++) {
          const key = `${held[i]} ${held[j]}`;
          let p = pairs.get(key);
          if (!p) {
            p = { a: held[i], b: held[j], shared: 0, rare: 0, score: 0, top: [] };
            pairs.set(key, p);
          }
          p.shared++;
          p.score += d.weight;
          if (d.held.length <= RARE_MAX) p.rare++;
          p.top.push({ item: d.item, held: d.held.length });
        }
      }
    }

    // -- emit ----------------------------------------------------------------
    const name = (i: number) => snap.purls[i] ?? snap.items[i];
    const fetched = snap.fetchedAt.slice(0, 10);
    const edges: GraphEdge[] = [];

    /** A purl minus its version. Everything after the last @ is the version. */
    const coordOf = (s: string) => {
      const at = s.lastIndexOf('@');
      return at > 0 ? s.slice(0, at) : s;
    };

    for (const p of [...pairs.values()].sort((x, y) => y.score - x.score)) {
      if (p.rare === 0) continue; // the rarity gate: no distinctive item, no edge

      // The join is on gitoid, so every version of a library is its own item.
      // Listing them one per row buries eight distinct libraries under eight
      // versions of one, so the display collapses to the package coordinate and
      // keeps the rarest version as the representative.
      const groups = new Map<string, { item: number; held: number; versions: number }>();
      for (const t of p.top) {
        const key = coordOf(name(t.item));
        const g = groups.get(key);
        if (!g) groups.set(key, { item: t.item, held: t.held, versions: 1 });
        else {
          g.versions++;
          if (t.held < g.held) {
            g.item = t.item;
            g.held = t.held;
          }
        }
      }
      const ranked = [...groups.values()].sort(
        (x, y) => x.held - y.held || name(x.item).localeCompare(name(y.item)),
      );
      const top = ranked.slice(0, TOP_SHARED);
      const only = top.filter((t) => t.held === 2).length;

      edges.push({
        id: `shared:${p.a}~${p.b}`,
        source: p.a,
        target: p.b,
        layer: 'shared-deps',
        label: `${p.shared} in common`,
        detail:
          `${p.a} and ${p.b} both contain ` +
          `${p.shared} distinctive item${p.shared === 1 ? '' : 's'}, ` +
          `${p.rare} of which at most ${RARE_MAX} components have` +
          (only ? `, and ${only} of the ones listed are held by these two alone` : '') +
          '.',
        anchor: `data/containment.json (project ${snap.source.project}, fetched ${fetched})`,
        derived: true,
        shared: top.map((t) =>
          t.versions > 1 ? `${coordOf(name(t.item))} (${t.versions} versions)` : name(t.item),
        ),
        sharedTotal: groups.size,
      });
    }

    ctx.log(`        ${edges.length} shared-dependency edges from ${pairs.size} candidate pairs`);
    return edges;
  },
};
