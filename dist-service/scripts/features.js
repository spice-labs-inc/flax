import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AstBuilder, GherkinClassicTokenMatcher, Parser, } from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";
import { config } from "@flax/scenarios/config";
import { SURFACES } from "@flax/scenarios/lib/types";
function featureFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        if (statSync(path).isDirectory())
            out.push(...featureFiles(path));
        else if (name.endsWith(".feature"))
            out.push(path);
    }
    return out;
}
const surfaceOf = (dir) => SURFACES.find((s) => s === dir) ?? "core";
/** Every feature file under `<root>/features`, in path order, with its scenarios. */
export function featuresCatalog(root) {
    const parser = new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher());
    const base = join(root, config().paths.features);
    return featureFiles(base).flatMap((path) => {
        const id = relative(root, path).split("\\").join("/");
        const doc = parser.parse(readFileSync(path, "utf8"));
        const f = doc.feature;
        if (!f)
            return [];
        const tags = f.tags.map((t) => t.name);
        const area = tags.find((t) => t.startsWith("@area:"))?.slice("@area:".length) ??
            id.replace(/^.*\//, "").replace(/\.feature$/, "");
        const scenarios = [];
        const visit = (children) => {
            for (const c of children) {
                const sc = c.scenario;
                if (sc) {
                    const own = [...tags, ...sc.tags.map((t) => t.name)];
                    const description = sc.description.trim();
                    const rows = sc.examples.flatMap((ex) => ex.tableBody.map((row) => ({ ex, row })));
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
                            name: header.reduce((n, h, i) => n.replaceAll(`<${h}>`, cells[i] ?? ""), sc.name),
                            description,
                            tags: [...own, ...ex.tags.map((t) => t.name)],
                            example: { outline: sc.location.line, name: sc.name, cells },
                        });
                    }
                }
                if (c.rule)
                    visit(c.rule.children);
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
//# sourceMappingURL=features.js.map