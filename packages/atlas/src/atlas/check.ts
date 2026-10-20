// `flax atlas check`: the atlas's self-consistency checks, in one place.
// Sections: 1 template conformance, 1b shareability, 2 INDEX coverage,
// 3 symmetry, 4 budgets, 4b generated content current, 5 cited gitops paths
// (warnings; only when checks.gitopsPaths is enabled), 6 (--stale) remote-HEAD audit.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { config, type AtlasConfig } from "../config.ts";
import { checkBudgets, printFindings } from "./budgets.ts";
import { fsSource, readDocs, SECTION_IDS } from "./doc.ts";
import { asymmetries, usedByChanges } from "./graph.ts";
import { generateIndex, planesFromIndex } from "./index-tables.ts";
import { outlineChanges } from "./outline.ts";

export interface CheckOptions {
  stale?: boolean;
  log: (s: string) => void;
  /** The gitops repository's file tree, for tests; read from the checkout or `gh api` otherwise. */
  gitopsTree?: Set<string>;
}

/** Every file path in a checkout, relative to it, with the .git directory left out. */
export function localTree(dir: string): Set<string> {
  const out = new Set<string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.add(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

/** The gitops repository's tree: the checkout beside the atlas when there is one, else `gh api` (network). */
export function gitopsTree(
  root: string,
  c: AtlasConfig,
): Set<string> | undefined {
  const checkout = c.map.gitops.checkout
    ? resolve(root, c.map.gitops.checkout)
    : "";
  if (checkout && existsSync(checkout)) return localTree(checkout);
  try {
    const out = execFileSync(
      "gh",
      [
        "api",
        `repos/${c.org.github}/${c.map.gitops.repo}/git/trees/HEAD?recursive=1`,
        "--jq",
        ".tree[].path",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 << 20,
      },
    );
    const tree = new Set(out.split("\n").filter(Boolean));
    return tree.size ? tree : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Paths under the configured prefixes that a doc cites in a live sentence: every section but
 * the skipped ones, on lines that name the gitops repo (every line of its own doc), without the
 * history phrases. Per-repo drift checks miss a move inside the gitops repo; this catches it.
 */
export function citedGitopsPaths(
  rel: string,
  text: string,
  c: AtlasConfig,
): string[] {
  const g = c.checks.gitopsPaths;
  const repo = c.map.gitops.repo;
  const ownDoc = rel === `repos/${repo}.md` || rel.startsWith(`repos/${repo}/`);
  const skipPhrase = g.skipPhrases.length
    ? new RegExp(g.skipPhrases.join("|"))
    : undefined;
  const cite = new RegExp(
    `(?:^|[^A-Za-z0-9_/-])((?:${g.prefixes.join("|")})/[A-Za-z0-9_./-]+)`,
    "g",
  );
  const found = new Set<string>();
  let section = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3).trim();
    if (g.skipSections.includes(section)) continue;
    if (!ownDoc && !line.includes(repo)) continue;
    if (skipPhrase && skipPhrase.test(line)) continue;
    for (const m of line.matchAll(cite)) {
      const p = m[1].replace(/[./]+$/, "");
      if (p && !p.endsWith("-")) found.add(p);
    }
  }
  return [...found].sort();
}

export function checkGitopsPaths(
  root: string,
  c: AtlasConfig,
  log: (s: string) => void,
  tree = gitopsTree(root, c),
): number {
  if (!tree) {
    log(
      `WARN: ${c.map.gitops.repo} tree not reachable (no checkout at map.gitops.checkout, gh api failed); cited paths not checked`,
    );
    return 0;
  }
  const src = fsSource(root);
  const docs = readDocs(src);
  const pages = [
    ...docs.map((d) => d.file),
    ...docs.flatMap((d) => Object.values(d.sectionFiles).map((f) => f.file)),
    ...c.docs.rootPages,
  ];
  let warned = 0;
  for (const rel of pages) {
    if (rel.endsWith("/history.md")) continue;
    const text = src.read(rel);
    if (text === undefined) continue;
    for (const p of citedGitopsPaths(rel, text, c)) {
      if (tree.has(p)) continue;
      let isDir = false;
      for (const t of tree)
        if (t.startsWith(`${p}/`)) {
          isDir = true;
          break;
        }
      if (isDir) continue;
      log(`WARN-GITOPS-PATH ${p}: ${rel}`);
      warned++;
    }
  }
  return warned;
}

export function cmdCheck(root: string, o: CheckOptions): number {
  const log = o.log;
  const c = config();
  const src = fsSource(root);
  const docs = readDocs(src);
  let fail = 0;

  log("== 1. Template conformance (frontmatter keys + stable headings) ==");
  const heads = SECTION_IDS();
  for (const d of docs) {
    for (const k of c.docs.frontmatter) {
      if (!(k in d.fm)) {
        log(`MISSING-FRONTMATTER ${k}: ${d.file}`);
        fail = 1;
      }
    }
    const n = d.sections.filter((s) => heads.includes(s.id)).length;
    if (n !== heads.length) {
      log(`HEADINGS ${n}/${heads.length}: ${d.file}`);
      fail = 1;
    }
    for (const [key, values] of [
      ["type", c.enums.type],
      ["status", c.enums.status],
      ["plane", c.planes.filter((p) => p.index).map((p) => p.id)],
    ] as const) {
      const v = d.fm[key];
      if (
        typeof v === "string" &&
        v &&
        values.length &&
        !values.includes(v.split(/[\s(]/)[0])
      ) {
        log(`ENUM ${key}: ${v} is not one of ${values.join("|")}: ${d.file}`);
        fail = 1;
      }
    }
  }

  log(
    "== 1b. Shareability (no machine-local refs or secret-looking values) ==",
  );
  const local = new RegExp(c.docs.localRefs.join("|"));
  const allow = c.docs.localRefsAllow.length
    ? new RegExp(c.docs.localRefsAllow.join("|"))
    : undefined;
  const secret =
    /ghp_[A-Za-z0-9]{20}|xox[bp]-|BEGIN (RSA|OPENSSH) PRIVATE|eyJhbGciOi/;
  const pages = [
    ...docs.map((d) => d.file),
    ...docs.flatMap((d) => Object.values(d.sectionFiles).map((f) => f.file)),
    ...c.docs.rootPages,
  ];
  for (const rel of pages) {
    const text = src.read(rel);
    if (text === undefined) continue;
    text.split("\n").forEach((l, i) => {
      if (local.test(l) && !(allow && allow.test(l))) {
        log(`${rel}:${i + 1}: ${l.slice(0, 120)}`);
        fail = 1;
      }
      if (secret.test(l)) {
        log(`SECRET-LIKE ${rel}:${i + 1}`);
        fail = 1;
      }
    });
  }

  log(
    "== 2. INDEX coverage (every doc rowed in INDEX, every INDEX link resolves) ==",
  );
  const index = src.read("INDEX.md") ?? "";
  for (const d of docs) {
    if (!index.includes(d.file)) {
      log(`NOT-IN-INDEX: ${d.file}`);
      fail = 1;
    }
  }
  for (const link of new Set(
    [...index.matchAll(/repos\/[A-Za-z0-9_.-]*\.md/g)].map((m) => m[0]),
  )) {
    if (!existsSync(join(root, link))) {
      log(`DEAD-INDEX-LINK: ${link}`);
      fail = 1;
    }
  }

  log(
    "== 3. depends_on / used_by symmetry (used_by is generated: atlas used-by --write) ==",
  );
  const asym = asymmetries(docs);
  for (const l of asym) log(l);
  if (asym.length) fail = 1;

  log("== 4. Budgets ==");
  const { fail: bf } = printFindings(checkBudgets(root), log);
  if (bf) fail = 1;

  log(
    "== 4b. Generated content is current (used_by, section outlines, INDEX plane tables; offline) ==",
  );
  const ub = usedByChanges(docs);
  for (const ch of ub) log(`WOULD-CHANGE ${ch.doc.file} used_by`);
  const ol = docs.flatMap((d) =>
    outlineChanges(d).map((ch) => `WOULD-CHANGE ${d.file} ## ${ch.id} outline`),
  );
  for (const l of ol) log(l);
  const gen = generateIndex(index, docs, planesFromIndex(index));
  if (gen.text !== index) log("WOULD-CHANGE INDEX.md plane tables");
  if (
    ub.length ||
    ol.length ||
    gen.text !== index ||
    gen.unplaced.length ||
    gen.unknownPlane.length
  )
    fail = 1;

  if (c.checks.gitopsPaths.enabled) {
    log(
      `== 5. Cited ${c.map.gitops.repo} paths resolve (warnings; the checkout beside the atlas, else gh api) ==`,
    );
    checkGitopsPaths(root, c, log, o.gitopsTree);
  }

  if (o.stale) {
    log("== 6. Staleness audit (network) ==");
    for (const d of docs) {
      if (String(d.fm.analysis_source ?? "") === "local-stale") continue;
      const name = String(d.fm.name ?? d.name);
      const local = String(d.fm.analyzed_commit ?? "").split(" ")[0];
      let remote = "";
      try {
        remote = execFileSync(
          "git",
          ["ls-remote", `https://github.com/${c.org.github}/${name}`, "HEAD"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).slice(0, 7);
      } catch {}
      if (!remote) log(`UNRESOLVABLE (renamed/deleted/private?): ${name}`);
      else if (!remote.startsWith(local.slice(0, 7)))
        log(`STALE: ${name} ${local} -> ${remote}`);
    }
  }

  log(`== done (fail=${fail}) ==`);
  return fail;
}

/** Text of a root page, for callers that want to show it. */
export function rootPage(root: string, name: string): string | undefined {
  const p = join(root, name);
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
}
