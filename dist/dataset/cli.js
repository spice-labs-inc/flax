import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { config } from "../config.js";
import { resolveJourneys } from "./journeys.js";
import { loadDatasetFiles } from "./load.js";
import { validateDataset } from "./schema.js";
export async function runDataset(_argv) {
    const kit = config();
    const { errors, warnings, dataset } = validateDataset(await loadDatasetFiles("."));
    for (const w of warnings)
        console.error(`warning: ${w}`);
    for (const e of errors)
        console.error(`error: ${e}`);
    const negative = dataset.personas.filter((p) => p.type === "negative").length;
    console.error(`dataset: ${dataset.personas.length} personas (${negative} negative), ${dataset.journeys.length} journeys, ${dataset.stations.length} stations, ${errors.length} errors, ${warnings.length} warnings`);
    let code = 0;
    if (errors.length > 0) {
        code = 1;
    }
    else if (!existsSync(kit.paths.coverageMap)) {
        console.error(`no ${kit.paths.coverageMap}; run flax scenarios coverage to resolve journeys`);
    }
    else {
        const coverage = JSON.parse(await readFile(kit.paths.coverageMap, "utf8"));
        const res = resolveJourneys(dataset, coverage);
        await writeFile(kit.paths.journeysOut, `${JSON.stringify(res, null, 2)}\n`);
        for (const b of res.broken)
            console.error(`broken station: ${b.station} matches no item (${b.matchers.join(", ")})`);
        for (const d of res.deadMatchers)
            console.error(`dead matcher: ${d.station}: ${d.matcher} matches no item`);
        const onJourney = coverage.items.length - res.orphans.length;
        console.error(`journeys.json: ${onJourney} of ${coverage.items.length} items on a journey, ${res.orphans.length} orphans, ${res.broken.length} broken stations, ${res.deadMatchers.length} dead matchers`);
        if (res.broken.length > 0)
            code = 1;
    }
    return code;
}
//# sourceMappingURL=cli.js.map