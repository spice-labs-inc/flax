// Keeps one re-extracted doc from failing a whole refresh.
//
// A curated flow names graph nodes by id, and a doc's new wiring answer can
// name the same thing differently ("NIST/RFC/EU" where the last answer said
// "NIST/RFC/EU spec sites"), so a step that resolved yesterday stops resolving.
// A doc whose new answer does that keeps its previous answer, exactly as a
// failed re-extraction does, and the run says which doc, which step and what
// the new answer called the node instead. A step that does not resolve even
// with every previous answer is real drift, and still fails the run.

import type { PreviousWiring, WiringResult, WiringStageResult } from './wiring.ts';

export interface BrokenStep {
  flow: string;
  /** 1-based, as the log and the flow files count them. */
  step: number;
  from: string;
  to: string;
  /** The step's names that matched no node. */
  missing: string[];
}

export interface Probe {
  broken: BrokenStep[];
  /** The node a raw name resolves to in this graph. */
  nodeOf: (name: string) => string | undefined;
}

export interface Held {
  doc: string;
  steps: BrokenStep[];
}

const stepKey = (s: BrokenStep) => `${s.flow}#${s.step}`;

/** The wiring with these docs carrying their previous answer instead of this run's. */
export function withPrevious(wire: WiringStageResult, docs: string[]): WiringStageResult {
  const prev = docs.map((d) => [d, wire.replaced?.[d]] as const).filter((p): p is [string, PreviousWiring] => !!p[1]);
  if (!prev.length) return wire;
  const swapped = new Set(prev.map(([d]) => d));
  const keep = <T extends { origin?: string }>(xs: T[]) => xs.filter((x) => !x.origin || !swapped.has(x.origin));
  const replaced = { ...wire.replaced };
  for (const d of swapped) delete replaced[d];
  return {
    ...wire,
    edges: [...keep(wire.edges), ...prev.flatMap(([, p]) => p.answer.edges)],
    infra: [...keep(wire.infra), ...prev.flatMap(([, p]) => p.answer.infra)],
    keys: { ...wire.keys, ...Object.fromEntries(prev.map(([d, p]) => [d, p.key])) },
    sections: { ...wire.sections, ...Object.fromEntries(prev.map(([d, p]) => [d, p.sections])) },
    replaced,
  };
}

/** One doc's answer, as the wiring carries it. */
function answerOf(wire: WiringStageResult, doc: string): WiringResult {
  return { edges: wire.edges.filter((e) => e.origin === doc), infra: wire.infra.filter((i) => i.origin === doc) };
}

function namesIn(a: WiringResult): Set<string> {
  return new Set([...a.infra.map((i) => i.id), ...a.edges.flatMap((e) => [e.from, e.to])]);
}

/**
 * What the previous answer called a node the new one lost, and the names the
 * new answer likely used in its place: new declarations of the same kind,
 * narrowed to the far ends of edges drawn from the same place when any are.
 */
export function renamed(previous: WiringResult, next: WiringResult, lost: (name: string) => boolean): { was: string[]; now: string[] } {
  const was = [...namesIn(previous)].filter(lost);
  if (!was.length) return { was, now: [] };
  const old = namesIn(previous);
  const byEdge = new Set<string>();
  for (const e of previous.edges) {
    for (const [end, other] of [['to', 'from'], ['from', 'to']] as const) {
      if (!was.includes(e[end])) continue;
      for (const n of next.edges) {
        if (n.layer === e.layer && n[other] === e[other] && !old.has(n[end])) byEdge.add(n[end]);
      }
    }
  }
  const kinds = new Set(previous.infra.filter((i) => was.includes(i.id)).map((i) => i.kind));
  const byKind = next.infra.filter((i) => kinds.has(i.kind) && !old.has(i.id)).map((i) => i.id);
  const both = byKind.filter((n) => byEdge.has(n));
  const now = both.length ? both : byKind.length ? byKind : [...byEdge];
  return { was, now: [...new Set(now)].slice(0, 3) };
}

/**
 * The wiring to emit: this run's, except that a re-extracted doc whose new
 * answer breaks a flow step keeps its previous one. `probe` resolves a wiring
 * against the rest of the graph without logging.
 */
export async function keepFlowsResolving(
  wire: WiringStageResult,
  probe: (w: WiringStageResult) => Promise<Probe>,
  log: (msg: string) => void,
): Promise<{ wire: WiringStageResult; held: Held[] }> {
  const docs = Object.keys(wire.replaced ?? {}).sort();
  if (!docs.length) return { wire, held: [] };
  const now = (await probe(wire)).broken;
  if (!now.length) return { wire, held: [] };

  // Broken even with every previous answer: not this run's doing.
  const drift = new Set((await probe(withPrevious(wire, docs))).broken.map(stepKey));
  const caused = now.filter((s) => !drift.has(stepKey(s)));
  if (!caused.length) return { wire, held: [] };

  const fixedBy = new Map<string, { steps: BrokenStep[]; probe: Probe }>();
  for (const doc of docs) {
    const p = await probe(withPrevious(wire, [doc]));
    const still = new Set(p.broken.map(stepKey));
    const steps = caused.filter((s) => !still.has(stepKey(s)));
    if (steps.length) fixedBy.set(doc, { steps, probe: p });
  }
  let keep = [...fixedBy.keys()];
  const left = new Set((await probe(withPrevious(wire, keep))).broken.map(stepKey));
  const together = caused.filter((s) => left.has(stepKey(s)));
  // A step only the previous answers of several docs restore together.
  if (together.length) keep = docs;

  const held: Held[] = [];
  for (const doc of keep) {
    const steps = fixedBy.get(doc)?.steps ?? [];
    held.push({ doc, steps });
    const p = fixedBy.get(doc)?.probe;
    for (const s of steps) {
      const target = s.missing.map((m) => p?.nodeOf(m)).find(Boolean);
      const hint = target
        ? renamed(wire.replaced![doc].answer, answerOf(wire, doc), (n) => p!.nodeOf(n) === target)
        : { was: [], now: [] };
      const named = hint.was.length
        ? `; the previous answer called it ${hint.was.map((n) => `"${n}"`).join(', ')}` +
          (hint.now.length ? `, the new one ${hint.now.map((n) => `"${n}"`).join(' or ')}` : ', the new one has nothing in its place')
        : '';
      log(
        `        ! ${doc}: its new wiring breaks flow "${s.flow}" step ${s.step} (${s.from} -> ${s.to}): ` +
          `no node matches ${s.missing.join(' and ')}${named}; keeping the previous answer`,
      );
    }
  }
  for (const s of together) {
    log(
      `        ! flow "${s.flow}" step ${s.step} (${s.from} -> ${s.to}) resolves only with the previous answers of ` +
        `${docs.join(', ')} together; keeping them all`,
    );
  }
  log(
    `        ${keep.length} kept their previous wiring because the new answer breaks a curated flow: ${keep.join(', ')}. ` +
      'Add an ALIASES entry in viz/src/stages/resolve.ts or update the flow in viz/flows/. Until then each run ' +
      'keeps the previous answer; the new one stays cached and the doc stays queued, so the first run after the ' +
      'fix uses it (no model call while the wiring model is the same)',
  );
  return { wire: withPrevious(wire, keep), held };
}
