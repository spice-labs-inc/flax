// Stages 8-9 (code): canonicalise the model's output, resolve every endpoint to
// a real node, drop what does not resolve, and emit graph.json.
//
// This stage is why the AI stages are safe to trust: anything the model invents
// that does not land on a known node is dropped and counted, not drawn.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdvisoryRecord, Flow, Graph, GraphEdge, GraphNode, NodeKind, Plane } from '../model/types.ts';
import type { Ctx, Stage } from '../pipeline/machine.ts';
import type { ComponentIndex } from './components.ts';
import type { AdvisoryResult } from './advisories.ts';
import type { InfraResult } from './infra.ts';
import type { ManifestResult } from './manifests.ts';
import type { RawInfra, WiringResult, WiringStageResult } from './wiring.ts';
import { keepFlowsResolving, type BrokenStep, type Probe } from './flow-guard.ts';
import { config } from '../config.ts';

/** Names too generic to be one shared node; scoped to the repo that named them. */
const GENERIC_ = () => new Set(config().map.resolve.generic);

/** Variant spellings the docs use for the same real thing. */
const ALIASES_ = (): Record<string, string> => config().map.resolve.aliases;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function prefixFor(kind: RawInfra['kind']): string {
  return { queue: 'q', broker: 'broker', store: 'store', external: 'ext', registry: 'reg' }[kind];
}

/** Queue names are templated per project; collapse the uuid so they merge. */
function canonicalQueueName(id: string): string {
  return id
    .replace(/\{[^}]*\}/g, '{uuid}')
    .replace(/project-[0-9a-f-]{8,}-/i, 'project-{uuid}-');
}


/**
 * Rejects "infrastructure" that is really a detail: a CLI flag, a local path, a
 * config key, a k8s object name, a single file. These belong in an edge's label
 * or anchor, not as their own node, and left in they bury the real topology.
 */
function isJunkInfra(id: string): boolean {
  const s = id.trim();
  if (!s || s.length > 64) return true;
  if (/^[-.~/]/.test(s)) return true;                 // flag, hidden file, path
  if (/:\/\//.test(s)) return true;                    // a URL, not a service name
  if (/^#/.test(s)) return true;                      // slack channel
  if (/\$\{|\{\{/.test(s)) return true;                 // unexpanded template
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(s)) return true; // a uuid instance
  if (/\.(json|jsonl|log|txt|ya?ml|toml|jfr|md|lock|gz)$/i.test(s)) return true;
  if (/(^|[-_.])(dir|file|path|workdir|tempdir|staging_dir)$/i.test(s)) return true;
  if (/\/$/.test(s)) return true;                       // a bucket prefix, not a store
  if (/\b(prefix|directory|folder|subdir)\b/i.test(s)) return true;
  if (/(^|[-_ ])(index|output|input|scratch|work)([-_ ](dir|directory))$/i.test(s)) return true;
  if (/(-creds|-secret|-secrets|secretsmanager|secrets-manager|existingsecret)$/i.test(s)) return true;
  if (/\.svc(\.cluster\.local)?(:\d+)?$/i.test(s)) return true;   // in-cluster address
  if (/^(localstorage|sessionstorage|tempdir|cache|database|db|repo|public|generic-http)$/i.test(s)) return true;
  const own = config().org.ownHosts;
  if (own.length && new RegExp(`\\.(${own.map((h) => h.replace(/\./g, '\\.')).join('|')})(:\\d+)?$`, 'i').test(s)) return true; // the org's own hosts
  if (/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,}$/.test(s) && !/\.(com|org|net|io|dev|ai|app)$/.test(s)) return true; // config key
  return false;
}


/**
 * Shared services get described by whichever repo the extractor read first,
 * which produces one caller's view of a thing many callers use differently
 * (the web app reaches an identity provider for sign-in; the API reaches it to
 * validate tokens). These are
 * the canonical descriptions for nodes that more than one component talks to.
 * Per-edge labels still carry each caller's specific usage.
 */
const CANONICAL_ = (): Record<string, { label?: string; role: string }> => config().map.resolve.canonical;

/**
 * Public clients do not reach the API directly: their traffic enters the
 * cluster through a gateway, which is what the routes attach to. The extractor
 * reads per-repo docs, so it records "the web app calls the API" and never
 * sees the hop in between. Insert it, so the picture matches the path a
 * request actually takes.
 */
function routeThroughGateway(edges: GraphEdge[], nodes: Map<string, GraphNode>): GraphEdge[] {
  const gw = config().map.resolve.gateway;
  if (!gw || !nodes.has(gw.node)) return edges;
  const out: GraphEdge[] = [];
  for (const e of edges) {
    const client = gw.clients[e.source];
    if (e.layer === 'network' && client && e.target === gw.target) {
      out.push({
        ...e,
        id: `network:${e.source}->gateway:${e.id.split(':').pop()}`,
        target: gw.node,
        detail: client.note,
        unverified: client.unverified || e.unverified,
      });
      continue;
    }
    out.push(e);
  }
  return out;
}

/**
 * Every environment has its own copy of the same infrastructure, and the docs
 * name them per environment ("test backup bucket", "live-db"). One node per
 * environment triples the clutter and says nothing extra, so strip the
 * qualifier and let the environment layer carry that distinction.
 *
 * Components are exempt: infra-test and infra-live really are separate
 * repos, not one repo seen twice.
 */
function stripEnvQualifier(name: string): string {
  let s = name;
  for (const env of config().map.resolve.envTokens) {
    s = s.replace(new RegExp(`(^|[-_ /])${env}([-_ /]|$)`, 'gi'), '$1$2');
  }
  s = s.replace(/[-_ ]{2,}/g, '-').replace(/^[-_ /]+|[-_ /]+$/g, '').trim();
  return s || name;
}


/**
 * Stores must be named after the thing an engineer would look up: a bucket by
 * its bucket name, a database by its schema. The extractor names them however
 * each doc happened to phrase it ("PostgreSQL", "Object storage", three
 * spellings of the same bucket), so fold them here.
 */
const STORE_MERGE_ = (): Record<string, string> => config().map.resolve.storeMerge;

/** id -> the name it should carry, and what it actually is. */
const STORE_NAMES_ = (): Record<string, { label: string; role?: string }> => config().map.resolve.storeNames;

/** A component's own database, so the generic node stops absorbing everything. */
const OWNED_DB_ = (): Record<string, string> => config().map.resolve.ownedDb;

function tidyStores(edges: GraphEdge[], nodes: Map<string, GraphNode>): GraphEdge[] {
  const STORE_MERGE = STORE_MERGE_();
  const STORE_NAMES = STORE_NAMES_();
  const OWNED_DB = OWNED_DB_();
  const remap = (id: string) => STORE_MERGE[id] ?? id;

  // fold merged ids into one node, keeping the best role text
  for (const [from, to] of Object.entries(STORE_MERGE)) {
    const src = nodes.get(from);
    if (!src) continue;
    if (!nodes.has(to)) nodes.set(to, { ...src, id: to });
    else if (src.role && !nodes.get(to)!.role) nodes.get(to)!.role = src.role;
    nodes.delete(from);
  }

  for (const [id, naming] of Object.entries(STORE_NAMES)) {
    const n = nodes.get(id);
    if (!n) continue;
    n.label = naming.label;
    if (naming.role) n.role = naming.role;
    n.curated = true;
  }

  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const e of edges) {
    let source = remap(e.source);
    let target = remap(e.target);
    // "component -> PostgreSQL" is really "component -> its own database"
    if (target === 'store:postgres' && OWNED_DB[source] && nodes.has(OWNED_DB[source])) target = OWNED_DB[source];
    if (source === 'store:postgres' && OWNED_DB[target] && nodes.has(OWNED_DB[target])) source = OWNED_DB[target];
    if (source === target) continue;
    const id = `${e.layer}:${source}->${target}:${norm(e.label).slice(0, 24)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...e, id, source, target });
  }
  return out;
}

/** One pass of the resolve stage over the wiring in ctx.out.wiring. */
const once = {
  async run(ctx: Ctx) {
    const idx = ctx.out.components as ComponentIndex;
    const inf = ctx.out.infra as InfraResult;
    const wire = ctx.out.wiring as WiringResult;
    const buildEdges = ctx.out.buildEdges as GraphEdge[];
    const sharedEdges = (ctx.out.sharedDeps as GraphEdge[]) ?? [];
    const deployEdges = ((ctx.out.deployments as { edges: GraphEdge[] } | undefined)?.edges) ?? [];
    const advisory = (ctx.out.advisories as AdvisoryResult) ?? { byComponent: {}, catalogue: {} };
    const flowList = ctx.out.flows as Flow[];

    const nodes = new Map<string, GraphNode>();
    for (const n of [...idx.nodes, ...inf.nodes]) nodes.set(n.id, n);
    const ALIASES = ALIASES_();
    const CANONICAL = CANONICAL_();
    const GENERIC = GENERIC_();
    const STORE_MERGE = STORE_MERGE_();
    const EXTERNAL = config().map.externalPlane;
    const DEFAULT_PLANE = config().planes[0].id;

    // -- canonicalise the model-declared infrastructure ----------------------
    // Which docs sit in the sample plane, so infra they alone declared can
    // follow them there. Only a SOLE declarer counts: something several docs
    // name is shared, whoever mentioned it first.
    const declarers = new Map<string, Set<string>>();
    for (const raw of wire.infra) {
      if (!raw.origin) continue;
      if (!declarers.has(raw.id)) declarers.set(raw.id, new Set());
      declarers.get(raw.id)!.add(raw.origin);
    }
    /**
     * Infrastructure only one doc ever named belongs to that doc's plane.
     *
     * A store or registry defaults to the product plane and an external to the
     * third-party plane, which is right for things many components share — Vault,
     * an identity provider, the registry. It is wrong for anything private to one
     * repo: a test fixture's rig of fake registries turns up in the runtime view
     * as services we call, and so does a side project's own git server.
     *
     * Named by two or more docs, it is genuinely shared and keeps the default.
     */
    const planeOfDoc = new Map(idx.nodes.map((n) => [n.repo ?? n.id, n.plane]));
    /**
     * Anything we have explicitly curated as a shared service. Docker Hub, npm
     * and Maven Central are third parties whoever happened to mention them, and
     * following their sole declarer filed Docker Hub under PQC — a worse answer
     * than the default rather than a better one.
     */
    const WELL_KNOWN = new Set([...Object.values(ALIASES), ...Object.keys(CANONICAL)]);
    /**
     * An id that names a real host on the public internet: two or more dotted
     * labels, optionally followed by a path.
     *
     * Distinguishes `reg:hub.docker.com` from `reg:artifactory`. The first is a
     * specific service somebody calls; the second is a category the PQC docs
     * discuss, and it belongs beside the doc that discusses it.
     */
    const PUBLIC_HOST = /^(?:reg|ext):[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/|$)/i;
    const ownerPlane = (raw: RawInfra, id: string): Plane | undefined => {
      if (WELL_KNOWN.has(id)) return undefined;
      // A public host is a third party whoever happens to reach it. Following
      // the sole caller filed Docker Hub, CRAN DB and the CocoaPods trunk under
      // Product, alongside the services we actually build.
      if ((raw.kind === 'external' || raw.kind === 'registry') && PUBLIC_HOST.test(id)) return undefined;
      const who = declarers.get(raw.id);
      if (!who?.size) return undefined;
      // One declarer, or several that agree: either way the thing belongs to a
      // single part of the org and should sit there.
      const planes = new Set([...who].map((doc) => planeOfDoc.get(doc)).filter(Boolean));
      return planes.size === 1 ? ([...planes][0] as Plane) : undefined;
    };

    const canonical = new Map<string, string>(); // raw id -> node id
    const junk: string[] = [];
    for (const raw of wire.infra) {
      const cleaned = raw.kind === 'queue' ? canonicalQueueName(raw.id) : stripEnvQualifier(raw.id);
      const key = norm(cleaned);

      // The model sometimes labels a sibling component "external". Never let an
      // infra declaration shadow a real component — map it onto the component.
      const asComponent =
        (nodes.has(raw.id) && nodes.get(raw.id)!.kind !== 'queue' ? raw.id : undefined) ??
        idx.componentsOf[raw.id.toLowerCase()]?.[0] ??
        [...nodes.keys()].find((n) => norm(n) === key && !n.includes(':'));
      if (asComponent && raw.kind !== 'queue') {
        canonical.set(raw.id, asComponent);
        canonical.set(key, asComponent);
        continue;
      }
      let id: string;
      if (ALIASES[key]) id = ALIASES[key];
      else if (GENERIC.has(cleaned.toLowerCase())) id = `${prefixFor(raw.kind)}:${cleaned.toLowerCase().replace(/\s+/g, '-')}`;
      else id = `${prefixFor(raw.kind)}:${cleaned.toLowerCase().replace(/\s+/g, '-')}`;

      if (isJunkInfra(cleaned) && !ALIASES[key]) {
        junk.push(`${raw.kind}: ${raw.id}`);
        continue;
      }

      canonical.set(raw.id, id);
      canonical.set(key, id);
      if (!nodes.has(id)) {
        const kindMap: Record<RawInfra['kind'], NodeKind> = { queue: 'queue', broker: 'broker', store: 'store', external: 'external', registry: 'registry' };
        nodes.set(id, {
          id,
          label: raw.kind === 'queue' ? cleaned : stripEnvQualifier(raw.label),
          kind: kindMap[raw.kind],
          // Infrastructure declared only by a fixture rig is part of that rig,
          // not part of our third-party surface. Left external, a fixture's seven
          // fake registries and the proxy fronting them sit in the runtime view
          // looking like services we call, and the proxy, fronting all seven, looks
          // like one of the busiest things on the map.
          plane:
            ownerPlane(raw, id) ??
            (raw.kind === 'external' || raw.kind === 'registry' ? EXTERNAL : DEFAULT_PLANE),
          status: 'active',
          visibility: 'n/a',
          role: raw.role && cleaned !== raw.id ? `${raw.role} One per environment.` : raw.role,
          curated: false,
        });
      } else if (raw.role && !nodes.get(id)!.role) {
        nodes.get(id)!.role = raw.role;
      }
    }

    for (const [id, c] of Object.entries(CANONICAL)) {
      const node = nodes.get(id);
      if (!node) continue;
      node.role = c.role;
      if (c.label) node.label = c.label;
      node.curated = true;
    }

    // -- endpoint resolution -------------------------------------------------
    const lookup = (rawId: string): string | undefined => {
      if (nodes.has(rawId)) return rawId;
      const key = norm(rawId);
      if (canonical.has(rawId)) return canonical.get(rawId);
      if (canonical.has(key)) return canonical.get(key);
      if (ALIASES[key] && nodes.has(ALIASES[key])) return ALIASES[key];
      // A queue named slightly differently than declared.
      const q = `q:${canonicalQueueName(rawId).toLowerCase().replace(/\s+/g, '-')}`;
      if (nodes.has(q)) return q;
      // A repo name where a component was meant.
      const primary = idx.componentsOf[rawId.toLowerCase()]?.[0];
      if (primary && nodes.has(primary)) return primary;
      // Case-insensitive component match.
      for (const id of nodes.keys()) if (norm(id) === key) return id;
      return undefined;
    };

    const dropped: Array<{ edge: string; reason: string; origin?: string }> = [];
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();

    const add = (e: GraphEdge) => {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      edges.push(e);
    };

    for (const e of buildEdges) {
      if (nodes.has(e.source) && nodes.has(e.target)) add(e);
      else dropped.push({ edge: `${e.source}->${e.target}`, reason: 'build endpoint missing' });
    }

    for (const raw of wire.edges) {
      const source = lookup(raw.from);
      const target = lookup(raw.to);
      if (!source || !target) {
        dropped.push({ edge: `${raw.from} -> ${raw.to}`, reason: !source ? `unknown source "${raw.from}"` : `unknown target "${raw.to}"`, origin: raw.origin });
        continue;
      }
      if (source === target) {
        dropped.push({ edge: `${raw.from} -> ${raw.to}`, reason: 'self edge after canonicalisation', origin: raw.origin });
        continue;
      }
      add({
        id: `${raw.layer}:${source}->${target}:${norm(raw.label).slice(0, 24)}`,
        source,
        target,
        layer: raw.layer,
        label: raw.label,
        detail: raw.detail,
        anchor: raw.anchor ? `${raw.origin ? `${raw.origin}: ` : ''}${raw.anchor}` : undefined,
        unverified: raw.unverified,
      });
    }

    for (const e of inf.edges) {
      if (nodes.has(e.source) && nodes.has(e.target)) add(e);
      else dropped.push({ edge: `${e.source}->${e.target}`, reason: 'delivery endpoint missing' });
    }

    for (const e of deployEdges) {
      if (nodes.has(e.source) && nodes.has(e.target)) add(e);
      else dropped.push({ edge: `${e.source}->${e.target}`, reason: 'deployment endpoint missing' });
    }

    for (const e of sharedEdges) {
      if (nodes.has(e.source) && nodes.has(e.target)) add(e);
      else dropped.push({ edge: `${e.source}->${e.target}`, reason: 'shared-deps endpoint missing' });
    }

    // Reaching a broker is a queue relationship, never a network call.
    //
    // The model reads `RABBITMQ_HOST` / `RABBITMQ_PORT` out of a config file and
    // emits a network edge for it, the same way it would for an HTTP host. But
    // the useful claim about a broker is always WHICH queue, and that lives on
    // the queue layer. Where the component already has queue edges the network
    // one is pure duplication and goes; where it has none, it becomes the queue
    // edge, so "uses the broker" survives even when the queue was not extracted.
    const brokers = new Set([...nodes.values()].filter((n) => n.kind === 'broker').map((n) => n.id));
    const hasQueueEdge = new Set(
      edges.filter((e) => e.layer === 'queue').map((e) => `${e.source}|${e.target}`),
    );
    const componentQueues = new Set(
      edges
        .filter((e) => e.layer === 'queue')
        .flatMap((e) => [e.source, e.target])
        .filter((id) => !brokers.has(id)),
    );
    let brokerCalls = 0;
    const debrokered = edges.filter((e) => {
      if (e.layer !== 'network' || !brokers.has(e.target)) return true;
      brokerCalls++;
      if (hasQueueEdge.has(`${e.source}|${e.target}`) || componentQueues.has(e.source)) return false;
      e.layer = 'queue';
      return true;
    });
    if (brokerCalls) ctx.log(`        ${brokerCalls} broker "network calls" reclassified or dropped`);
    edges.length = 0;
    edges.push(...debrokered);

    // Waypoints and forwarding hops. A gateway is never anybody's destination,
    // and an API's calls to a backing service are forwards on behalf of a caller
    // further back: the web app asking for a report is really asking the
    // service that renders it. Marking
    // them lets selection light the two ends of a path at once instead of
    // stopping at the thing in the middle.
    let transits = 0;
    for (const id of config().map.resolve.transit) {
      const transitNode = nodes.get(id);
      if (transitNode) {
        transitNode.transit = true;
        transits++;
      }
    }
    let proxied = 0;
    for (const e of edges) {
      if (e.layer === 'network' && config().map.resolve.proxyEdges.some((p) => p.source === e.source && p.target === e.target)) {
        e.proxy = true;
        proxied++;
      }
    }
    ctx.log(`        ${transits} transit nodes, ${proxied} proxy hops marked`);

    const tidied = tidyStores(edges, nodes);
    const routed = routeThroughGateway(tidied, nodes);
    edges.length = 0;
    edges.push(...routed);

    // -- flows ---------------------------------------------------------------
    const keptFlows: Flow[] = [];
    const broken: BrokenStep[] = [];
    let droppedSteps = 0;
    for (const f of flowList) {
      const steps = f.steps
        .map((s, i) => {
          const from = lookup(s.from);
          const to = lookup(s.to);
          if (!from || !to) {
            droppedSteps++;
            // Name it. A count alone is unactionable: "10 flow steps no longer
            // resolve" stops the nightly refresh publishing and tells whoever
            // reads it nothing about which journey broke or which end of the
            // hop went missing. The atlas moved under a curated narrative, and
            // fixing that means knowing WHICH claim it can no longer support.
            const missing = [!from ? s.from : null, !to ? s.to : null].filter((m): m is string => !!m);
            broken.push({ flow: f.id, step: i + 1, from: s.from, to: s.to, missing });
            ctx.log(`        ! flow "${f.id}" step ${i + 1} (${s.from} -> ${s.to}): no node matches ${missing.join(' and ')}`);
            return null;
          }
          return { ...s, from, to };
        })
        .filter(Boolean) as Flow['steps'];
      if (steps.length >= 3) keptFlows.push({ ...f, steps });
    }

    // Say what kind of thing a name is, in the name. "prod" and "job_queue" and
    // "notes-blob" read as three unrelated words otherwise; the shape language
    // carries the same information but only once you have learned it.
    //
    // Stores also say WHAT THEY ARE: "store:bucket:user-data-<project_id>" and
    // "store:postgres:spicy". A bucket and a Postgres database and a Vault are
    // three different things with three different failure modes and three
    // different ways in, and calling all of them "store:" hides exactly the
    // distinction someone reading a data-flow diagram is looking for.
    //
    // The engine comes from the ROLE text first, because that is where it is
    // stated in prose ("the API's Postgres database"), and only then from the id:
    // an id like "store:notes-db" says nothing about what notes-db is.
    const engineOf = (n: GraphNode): string | null => {
      const hay = `${n.id} ${n.label} ${n.role ?? ''}`;
      if (/\bvault\b/i.test(hay)) return 'vault';
      if (/\bredis\b/i.test(hay)) return 'redis';
      if (/\bsqlite\b|\blibsql\b|\bsqld\b/i.test(hay)) return 'sqlite';
      if (/\bpostgres\b|\bpostgresql\b|\brdb\b/i.test(hay)) return 'postgres';
      if (/\bh2\b/i.test(hay)) return 'h2';
      if (/bucket|blob|s3|\br2\b|minio|object storage|object store/i.test(hay)) return 'bucket';
      return null;
    };

    for (const n of nodes.values()) {
      const word = n.kind === 'queue' ? 'queue' : n.kind === 'env' ? 'env' : n.kind === 'store' ? 'store' : null;
      if (!word || n.label.toLowerCase().startsWith(`${word}:`)) continue;
      // "queue:queue-activity-log" says it twice. Strip the kind word when the
      // name already opens with it, so the prefix adds information instead of
      // stuttering.
      let bare = n.label.replace(new RegExp(`^${word}[-_]`, 'i'), '');
      const engine = n.kind === 'store' ? engineOf(n) : null;
      if (!engine) {
        n.label = `${word}:${bare}`;
        continue;
      }
      // Same anti-stutter rule, one level down: the engine is in the prefix now,
      // so a name that already carries it says it twice — "store:postgres:pulp-db
      // (postgres)", "store:sqlite:Kellnr sqlite".
      bare = bare
        .replace(new RegExp(String.raw`\s*\(${engine}\)\s*$`, 'i'), '')
        .replace(new RegExp(String.raw`[\s-]+${engine}$`, 'i'), '')
        .trim();
      // And where the name was ONLY the engine, the prefix has already said
      // everything there is to say: "store:vault", not "store:vault:Vault".
      n.label = bare && bare.toLowerCase() !== engine ? `${word}:${engine}:${bare}` : `${word}:${engine}`;
    }

    // Advisories hang on the component that carries them.
    let carrying = 0;
    for (const [component, ids] of Object.entries(advisory.byComponent)) {
      const node = nodes.get(component);
      if (!node) continue;
      node.advisoryIds = ids;
      carrying++;
    }
    if (carrying) ctx.log(`        ${carrying} components carry advisories`);

    // Prune components that ended up with no edge at all and no story to tell:
    // keep them, but mark degree so the viewer can offer "hide isolated".
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    ctx.log(`        ${nodes.size} nodes, ${edges.length} edges kept; ${dropped.length} edges + ${droppedSteps} flow steps dropped`);
    ctx.log(`        ${junk.length} detail-level "infra" declarations rejected`);
    const nodeOf = (name: string) => {
      const id = lookup(name);
      return id && (STORE_MERGE[id] ?? id);
    };
    return { nodes: [...nodes.values()], edges, flows: keptFlows, dropped, junk, degree: Object.fromEntries(degree), advisoriesAsOf: advisory.asOf, advisories: advisory.catalogue, broken, nodeOf };
  },
};

export const resolve: Stage = {
  id: 'resolve',
  kind: 'code',
  title: 'Canonicalise, resolve endpoints, drop unresolvable claims',
  async run(ctx: Ctx) {
    // A pass edits the nodes and edges it is handed, so a probe gets its own copies.
    const probe = async (wiring: WiringStageResult): Promise<Probe> => {
      const { components, infra, buildEdges, sharedDeps, deployments } = ctx.out;
      const own = structuredClone({ components, infra, buildEdges, sharedDeps, deployments });
      const r = await once.run({ ...ctx, log: () => {}, out: { ...ctx.out, ...own, wiring } });
      return { broken: r.broken, nodeOf: r.nodeOf };
    };
    const kept = await keepFlowsResolving(ctx.out.wiring as WiringStageResult, probe, ctx.log);
    // emit writes the wiring keys and sections, which must follow a doc that kept its previous answer.
    ctx.out.wiring = kept.wire;
    const { broken: _broken, nodeOf: _nodeOf, ...resolved } = await once.run(ctx);
    return resolved;
  },
};

/** The advisory fields the viewer actually reads, and nothing else. */
function trimAdvisories(all: Record<string, AdvisoryRecord>): Record<string, AdvisoryRecord> {
  const out: Record<string, AdvisoryRecord> = {};
  for (const [id, a] of Object.entries(all)) {
    out[id] = { id: a.id, severity: a.severity, score: a.score, summary: a.summary, package: a.package, purls: [], url: a.url, fixedIn: a.fixedIn };
  }
  return out;
}

export const emit: Stage = {
  id: 'emit',
  kind: 'code',
  title: 'Write graph.json and the drop report',
  async run(ctx: Ctx): Promise<Graph> {
    const r = ctx.out.resolve as {
      nodes: GraphNode[];
      edges: GraphEdge[];
      flows: Flow[];
      dropped: Array<{ edge: string; reason: string; origin?: string }>;
      junk?: string[];
      advisoriesAsOf?: string;
      advisories?: Record<string, any>;
    };

    let commit = 'unknown';
    try {
      commit = execFileSync('git', ['-C', ctx.atlasRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {}

    const stats: Record<string, number> = { nodes: r.nodes.length, edges: r.edges.length, flows: r.flows.length };
    for (const e of r.edges) stats[`layer.${e.layer}`] = (stats[`layer.${e.layer}`] ?? 0) + 1;
    for (const n of r.nodes) stats[`kind.${n.kind}`] = (stats[`kind.${n.kind}`] ?? 0) + 1;

    const graph: Graph = {
      generatedAt: new Date().toISOString(),
      advisoriesAsOf: r.advisoriesAsOf,
      // Only the fields the viewer reads. `details` alone was 489 KB — a
      // quarter of the whole payload — and nothing displays it; `purls` is 30 KB
      // more, used to MATCH advisories to components here in the generator and
      // never needed again once the match is recorded on the node. This is a
      // page that ships its own data, so anything carried is carried by every
      // reader on every load.
      advisories: r.advisories && Object.keys(r.advisories).length ? trimAdvisories(r.advisories) : undefined,
      atlasCommit: commit,
      nodes: r.nodes,
      edges: r.edges,
      flows: r.flows,
      groups: (ctx.out.layout2d as { groups?: Graph['groups'] } | undefined)?.groups,
      routes: (ctx.out.layout2d as { routes?: Graph['routes'] } | undefined)?.routes,
      stats,
    };

    // Last line of defence: data/graph.json is a committed artefact that the
    // build and the deployed site depend on. Never replace it with a husk.
    const floor = config().map.resolve.minGraph;
    if (graph.edges.length < floor.edges || graph.nodes.length < floor.nodes) {
      throw new Error(
        `refusing to write graph.json with ${graph.nodes.length} nodes and ${graph.edges.length} edges ` +
          `; that is below the configured floor (${floor.nodes} nodes, ${floor.edges} edges), so something upstream failed.`,
      );
    }
    writeFileSync(join(ctx.vizRoot, 'data', 'graph.json'), JSON.stringify(graph));

    // Which extraction each doc's wiring came from. Committed alongside the
    // graph so a data-only refresh can pin to exactly these entries, and so a
    // change in what the model said shows up as a reviewable diff rather than
    // appearing silently in the map.
    const wiringKeys = (ctx.out.wiring as { keys?: Record<string, string> } | undefined)?.keys;
    if (wiringKeys && Object.keys(wiringKeys).length) {
      writeFileSync(
        join(ctx.vizRoot, 'data', 'wiring-keys.json'),
        JSON.stringify(Object.fromEntries(Object.entries(wiringKeys).sort()), null, 1),
      );
    }
    const wiringSections = (ctx.out.wiring as { sections?: Record<string, string> } | undefined)?.sections;
    if (wiringSections && Object.keys(wiringSections).length) {
      writeFileSync(
        join(ctx.vizRoot, 'data', 'wiring-sections.json'),
        JSON.stringify(Object.fromEntries(Object.entries(wiringSections).sort()), null, 1),
      );
    }

    writeFileSync(
      join(ctx.vizRoot, 'data', 'report.json'),
      JSON.stringify(
        {
          generatedAt: graph.generatedAt,
          atlasCommit: commit,
          stats,
          droppedEdges: r.dropped,
          rejectedInfra: r.junk ?? [],
          // Where the atlas and the repositories disagree about dependencies.
          // Not errors: most `unverified` entries are runtime or deploy
          // relationships that no manifest could know about. The `undeclared`
          // list is the actionable half — a dependency in code that the atlas
          // has not recorded.
          dependencyDrift: (ctx.out.manifests as ManifestResult | undefined)?.drift ?? [],
          uncheckedRepos: (ctx.out.manifests as ManifestResult | undefined)?.unchecked ?? [],
          // Gitops stack directories that name no component in the graph.
          // Usually third-party software we deploy but do not build.
          unmappedDeployments:
            (ctx.out.deployments as { unmapped: string[] } | undefined)?.unmapped ?? [],
          // Where the MACHINES.md fleet table disagrees with what gitops
          // actually reconciles onto each box. app-gitops is the source of
          // truth; these are the prose entries that need correcting.
          machineDrift:
            (ctx.out.deployments as { machineDrift: string[] } | undefined)?.machineDrift ?? [],
        },
        null,
        1,
      ),
    );
    ctx.log(`        graph.json written (${(JSON.stringify(graph).length / 1024).toFixed(0)} KB)`);
    return graph;
  },
};
