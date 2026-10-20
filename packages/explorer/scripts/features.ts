import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AstBuilder,
  GherkinClassicTokenMatcher,
  Parser,
} from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";
import type { SurfaceName } from "@flax/contract";
import { config } from "@flax/scenarios/config";
import { SURFACES } from "@flax/scenarios/lib/types";

/** One feature file as the catalog reads it: the product's own description of what a customer can do. */
export interface FeatureEntry {
  /** Path from the repo root, as scenario ids start with it. */
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** The surface the file sits under; "core" features cross surfaces. */
  surface: SurfaceName | "core";
  /** The @area tag, else the file's own name. */
  area: string;
  /** A Scenario Outline counts once per Examples row, keyed by the row's line as runs key it. */
  scenarios: {
    id: string;
    name: string;
    description: string;
    tags: string[];
    example?: OutlineRow;
  }[];
}

/** A row of a Scenario Outline: the outline as written, and the row's cells that tell the rows apart. */
export interface OutlineRow {
  /** The outline's own line. */
  outline: number;
  /** The outline's name as written, placeholders and all. */
  name: string;
  cells: string[];
}

function featureFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...featureFiles(path));
    else if (name.endsWith(".feature")) out.push(path);
  }
  return out;
}

const surfaceOf = (dir: string): SurfaceName | "core" =>
  SURFACES.find((s) => s === dir) ?? "core";

/** Every feature file under `<root>/features`, in path order, with its scenarios. */
export function featuresCatalog(root: string): FeatureEntry[] {
  const parser = new Parser(
    new AstBuilder(IdGenerator.uuid()),
    new GherkinClassicTokenMatcher(),
  );
  const base = join(root, config().paths.features);
  return featureFiles(base).flatMap((path): FeatureEntry[] => {
    const id = relative(root, path).split("\\").join("/");
    const doc = parser.parse(readFileSync(path, "utf8"));
    const f = doc.feature;
    if (!f) return [];
    const tags = f.tags.map((t) => t.name);
    const area =
      tags.find((t) => t.startsWith("@area:"))?.slice("@area:".length) ??
      id.replace(/^.*\//, "").replace(/\.feature$/, "");
    const scenarios: FeatureEntry["scenarios"] = [];
    const visit = (children: typeof f.children) => {
      for (const c of children) {
        const sc = c.scenario;
        if (sc) {
          const own = [...tags, ...sc.tags.map((t) => t.name)];
          const description = sc.description.trim();
          const rows = sc.examples.flatMap((ex) =>
            ex.tableBody.map((row) => ({ ex, row })),
          );
          if (!rows.length)
            scenarios.push({
              id: `${id}:${sc.location.line}`,
              name: sc.name,
              description,
              tags: own,
            });
          for (const { ex, row } of rows) {
            const header = ex.tableHeader?.cells.map((x) => x.value) ?? [];
            const cells = row.cells.map((x) => x.value);
            scenarios.push({
              id: `${id}:${row.location.line}`,
              name: header.reduce(
                (n, h, i) => n.replaceAll(`<${h}>`, cells[i] ?? ""),
                sc.name,
              ),
              description,
              tags: [...own, ...ex.tags.map((t) => t.name)],
              example: { outline: sc.location.line, name: sc.name, cells },
            });
          }
        }
        if (c.rule) visit(c.rule.children);
      }
    };
    visit(f.children);
    return [
      {
        id,
        name: f.name,
        description: f.description.trim().replace(/^[ \t]+/gm, ""),
        tags,
        surface: surfaceOf(id.split("/")[1] ?? ""),
        area,
        scenarios,
      },
    ];
  });
}
