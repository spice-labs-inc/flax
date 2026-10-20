// Stage 5 (code): cross-check the atlas's declared dependencies against what
// the repositories actually declare in code.
//
// The build layer keeps coming from `depends_on` frontmatter, and must: that
// field records every kind of dependency a repo has — a runtime call, a deploy
// relationship, a documentation link — while a manifest only ever knows about
// build-time ones. Measured across every locally-cloned repo, `depends_on`
// carries 267 edges and code can prove 130 of them; replacing one with the
// other would delete 150 real relationships.
//
// What code IS good for is checking the overlap. Of those 130, 117 already
// agree with the atlas and 13 do not appear in it at all. Those 13 are drift:
// a dependency someone added in a manifest and never wrote down. This stage
// finds them, and the reverse case — a frontmatter claim that names a repo no
// manifest, workflow, Dockerfile or terraform module mentions.
//
// Nothing here changes the graph. It writes findings into report.json, which is
// where the generator already puts things a human should look at.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx, Stage } from '../pipeline/machine.ts';
import type { AtlasRead } from './read-atlas.ts';
import { config } from '../config.ts';

/** Never walk into these: build output and vendored trees dwarf the source. */
const SKIP = new Set([
  'node_modules', 'target', 'dist', 'build', 'vendor', '.venv', 'venv',
  '.git', 'old', 'test-corpus', 'java-corpus', 'dotnet-corpus',
]);

/** How deep to walk. Workspace members sit one or two levels down. */
const MAX_DEPTH = 3;

export interface DependencyDrift {
  repo: string;
  /** Named in code but absent from the doc's depends_on. */
  undeclared: Array<{ target: string; sources: string[] }>;
  /** Declared in frontmatter but named by no manifest, workflow or module. */
  unverified: string[];
}

export interface ManifestResult {
  /** repo -> target -> how it was found */
  derived: Record<string, Record<string, string[]>>;
  drift: DependencyDrift[];
  /** Repos with no checkout available, so nothing could be verified. */
  unchecked: string[];
}

function walk(dir: string, depth: number, out: string[]): string[] {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // .github matters (workflows); every other dotdir is noise.
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      walk(p, depth + 1, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Every org-internal repo a file names, and the mechanism that named it.
 *
 * Each pattern is anchored on the org, so a coincidental name match cannot
 * produce an edge — `coordinates` only counts when it appears as
 * `co.notes:coordinates` or `github.com/notes-co/coordinates`,
 * never as the English word.
 */
function namesIn(file: string, text: string, known: Set<string>): Array<[string, string]> {
  const base = file.split('/').pop() ?? '';
  const hits: Array<[string, string]> = [];
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const org = esc(config().org.github);
  const groups = config().org.packageGroups.map(esc);
  const registry = esc(config().org.registry);
  const add = (raw: string | undefined, how: string) => {
    if (!raw) return;
    // Scala/Maven artifacts carry a binary-version suffix: notes-core_3.
    const name = raw.replace(/_\d+(\.\d+)*$/, '');
    if (known.has(name)) hits.push([name, how]);
  };

  if (base === 'Cargo.toml') {
    for (const m of text.matchAll(new RegExp(`github\\.com/${org}/([A-Za-z0-9_.-]+?)(?:\\.git)?["/]`, 'g'))) add(m[1], 'cargo');
  } else if (base === 'pom.xml') {
    for (const g of groups) for (const m of text.matchAll(new RegExp(`<groupId>${g}</groupId>\\s*<artifactId>([^<]+)</artifactId>`, 'g'))) add(m[1], 'maven');
  } else if (base === 'package.json') {
    for (const m of text.matchAll(new RegExp(`${org}/([A-Za-z0-9_.-]+?)(?:\\.git|#|")`, 'g'))) add(m[1], 'npm');
  } else if (base.endsWith('.sbt')) {
    for (const g of groups) for (const m of text.matchAll(new RegExp(`"${g}"\\s*%%?\\s*"([^"]+)"`, 'g'))) add(m[1], 'sbt');
  } else if (file.includes('/.github/workflows/')) {
    for (const m of text.matchAll(new RegExp(`uses:\\s*${org}/([A-Za-z0-9_.-]+)`, 'g'))) add(m[1], 'workflow');
  } else if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) {
    if (registry) for (const m of text.matchAll(new RegExp(`FROM\\s+${registry}/([A-Za-z0-9_.-]+)`, 'g'))) add(m[1], 'dockerfile');
  } else if (base.endsWith('.tf')) {
    for (const m of text.matchAll(new RegExp(`source\\s*=\\s*"git::https://github\\.com/${org}/([A-Za-z0-9_.-]+?)(?:\\.git)?[/"]`, 'g'))) add(m[1], 'terraform');
  }
  return hits;
}

export const manifests: Stage = {
  id: 'manifests',
  kind: 'code',
  title: 'Cross-check declared dependencies against code',
  async run(ctx: Ctx): Promise<ManifestResult> {
    const atlas = ctx.out.atlas as AtlasRead;
    const known = new Set(atlas.repos.map((r) => r.name));

    // Checkouts live next to the atlas. A repo with no checkout is reported as
    // unchecked rather than treated as having no dependencies — absence of a
    // clone is not evidence of absence of a dependency.
    const root = join(ctx.atlasRoot, config().map.manifests.checkouts);

    const derived: Record<string, Record<string, string[]>> = {};
    const drift: DependencyDrift[] = [];
    const unchecked: string[] = [];

    for (const doc of atlas.repos) {
      const dir = join(root, doc.name);
      if (!existsSync(join(dir, '.git'))) {
        unchecked.push(doc.name);
        continue;
      }

      const found = new Map<string, Set<string>>();
      for (const file of walk(dir, 0, [])) {
        let text: string;
        try {
          text = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        for (const [target, how] of namesIn(file, text, known)) {
          if (target === doc.name) continue; // a workspace referring to itself
          if (!found.has(target)) found.set(target, new Set());
          found.get(target)!.add(how);
        }
      }
      if (found.size) {
        derived[doc.name] = Object.fromEntries([...found].map(([k, v]) => [k, [...v].sort()]));
      }

      // Frontmatter entries carry parenthesised notes: "notes-core (fork, worker image)".
      const declared = new Set(
        ((doc.fm.depends_on as string[]) ?? [])
          .map((s) => String(s).replace(/\([^)]*\)/g, '').trim())
          .filter((s) => known.has(s)),
      );

      const undeclared = [...found]
        .filter(([t]) => !declared.has(t))
        .map(([target, how]) => ({ target, sources: [...how].sort() }));
      const unverified = [...declared].filter((t) => !found.has(t)).sort();

      if (undeclared.length || unverified.length) {
        drift.push({ repo: doc.name, undeclared, unverified });
      }
    }

    const checked = atlas.repos.length - unchecked.length;
    const totalUndeclared = drift.reduce((n, d) => n + d.undeclared.length, 0);
    ctx.log(
      `        ${checked}/${atlas.repos.length} repos checked; ` +
        `${totalUndeclared} dependencies in code but not in the atlas`,
    );
    if (unchecked.length) {
      ctx.log(`        ${unchecked.length} repos have no local checkout and were not verified`);
    }
    return { derived, drift, unchecked };
  },
};
