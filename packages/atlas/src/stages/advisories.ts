// Stage 7 (code): advisories, attached to the components that carry them.
//
// They are an ATTRIBUTE of a component, not a participant in the architecture.
// Drawn as nodes they became peers of the central API and made the map about
// vulnerabilities instead of about the system; a component carries advisories
// the same way it carries a language or a status.
//
// So this stage emits no nodes and no edges. It hangs a list of advisory ids on
// each component and puts one catalogue of the advisories themselves on the
// graph, which the viewer uses to size and colour nodes in the advisory view.
//
// Unlike every other stage, this one is about an INSTANT rather than a state of
// affairs. Containment changes when code changes; an advisory published this
// morning changes the answer without anything of ours moving. So the capture's
// `asOf` rides through to the viewer and is shown wherever these counts are, and
// a stale capture has to read as stale rather than as calm.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdvisoryRecord } from '../model/types.ts';
import type { Ctx, Stage } from '../pipeline/machine.ts';
import { config } from '../config.ts';
import type { ComponentIndex } from './components.ts';
import { componentForSubject, readSubjectMap } from './subject-map.ts';

interface Containment {
  fetchedAt: string;
  complete?: boolean;
  items: string[];
  subjects: Array<{ subject: string; total: number; items: number[] }>;
}

interface Advisories {
  capturedAt: string;
  asOf: string;
  complete?: boolean;
  affected: Array<[number, string[]]>;
  advisories: Record<
    string,
    {
      summary?: string;
      details?: string;
      severity?: string;
      score?: number;
      package?: string;
      url?: string;
      fixed?: string[];
    }
  >;
}

export interface AdvisoryResult {
  /** component id -> the advisory ids it carries */
  byComponent: Record<string, string[]>;
  /** every advisory named above, once */
  catalogue: Record<string, AdvisoryRecord>;
  /** The instant the capture speaks about, or undefined when there is none. */
  asOf?: string;
  complete?: boolean;
}

const EMPTY: AdvisoryResult = { byComponent: {}, catalogue: {} };

export const advisories: Stage = {
  id: 'advisories',
  kind: 'code',
  title: 'Advisories from the committed capture',
  async run(ctx: Ctx): Promise<AdvisoryResult> {
    const advPath = join(ctx.vizRoot, config().sources.advisories);
    const snapPath = join(ctx.vizRoot, config().sources.containment);
    if (!existsSync(advPath) || !existsSync(snapPath)) {
      ctx.log(`        no ${config().sources.advisories} (a committed advisory capture) beside ${config().sources.containment}; skipped`);
      return EMPTY;
    }

    const snap: Containment = JSON.parse(readFileSync(snapPath, 'utf8'));
    const adv: Advisories = JSON.parse(readFileSync(advPath, 'utf8'));
    const idx = ctx.out.components as ComponentIndex;
    const map = readSubjectMap(ctx.vizRoot);
    const byId = new Map(idx.nodes.map((n) => [n.id, n]));
    const byLabel = new Map(idx.nodes.map((n) => [n.label.toLowerCase(), n.id]));

    if (!adv.complete) {
      ctx.log('        ! this capture is marked incomplete; its counts are a floor, not a total');
    }

    const affected = new Map(adv.affected);

    // component -> advisory id -> the packages it came in through
    const carried = new Map<string, Map<string, Set<string>>>();
    for (const s of snap.subjects) {
      if (map.ignored(s.subject)) continue;
      const component = componentForSubject(s.subject, map, byId, byLabel);
      if (!component) continue;
      if (!carried.has(component)) carried.set(component, new Map());
      const per = carried.get(component)!;
      for (const item of s.items) {
        for (const id of affected.get(item) ?? []) {
          if (!per.has(id)) per.set(id, new Set());
          per.get(id)!.add(snap.items[item]);
        }
      }
    }

    const byComponent: Record<string, string[]> = {};
    const catalogue: Record<string, AdvisoryRecord> = {};
    const bands: Record<string, number> = {};

    for (const [component, per] of carried) {
      if (!per.size) continue;
      // Worst first, so a component's list opens on what matters.
      const ids = [...per.keys()].sort(
        (a, b) => (adv.advisories[b]?.score ?? 0) - (adv.advisories[a]?.score ?? 0),
      );
      byComponent[component] = ids;

      for (const id of ids) {
        const meta = adv.advisories[id] ?? {};
        if (!catalogue[id]) {
          const severity = meta.severity ?? 'unrated';
          bands[severity] = (bands[severity] ?? 0) + 1;
          catalogue[id] = {
            id,
            severity,
            score: meta.score,
            summary: meta.summary?.replace(/\s+/g, ' ').trim(),
            details: meta.details?.replace(/\s+/g, ' ').trim(),
            // The package is the useful name; the id is a lookup key.
            package: meta.package ?? shortPurl([...per.get(id)!][0]),
            purls: [...per.get(id)!],
            url: meta.url,
            fixedIn: meta.fixed?.length ? [...new Set(meta.fixed)] : undefined,
          };
        } else {
          for (const p of per.get(id)!) {
            if (!catalogue[id].purls.includes(p)) catalogue[id].purls.push(p);
          }
        }
      }
    }

    const counts = Object.entries(bands)
      .sort()
      .map(([k, v]) => `${v} ${k}`)
      .join(', ');
    ctx.log(
      `        ${Object.keys(catalogue).length} advisories over ${Object.keys(byComponent).length} components` +
        (counts ? ` (${counts})` : ''),
    );
    return { byComponent, catalogue, asOf: adv.asOf, complete: adv.complete };
  },
};

/** "pkg:cargo/openssl@0.10.64" reads better than the whole coordinate string. */
function shortPurl(purl: string): string {
  const at = purl.lastIndexOf('@');
  const body = at > 0 ? purl.slice(0, at) : purl;
  return body.split('/').pop() ?? body;
}
