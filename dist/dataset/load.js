import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { config } from "../config.js";
export const STATIONS_FILE = "stations.yml";
export function parseDatasetFile(path, text) {
    try {
        return { path, text, data: parse(text) };
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { path, text, data: undefined, parseError: message };
    }
}
async function readDir(root, dir) {
    const full = join(root, dir);
    if (!existsSync(full))
        return [];
    const names = (await readdir(full)).filter((n) => /\.ya?ml$/.test(n)).sort();
    return Promise.all(names.map(async (n) => {
        const path = `${dir}/${n}`;
        const text = await readFile(join(root, path), "utf8");
        return n.endsWith(".yml")
            ? parseDatasetFile(path, text)
            : { path, text, data: undefined, parseError: "use the .yml extension" };
    }));
}
/** Reads `personas/*.yml`, `journeys/stations.yml` and `journeys/<persona>.yml` under `root`. */
export async function loadDatasetFiles(root) {
    const kit = config();
    const personas = await readDir(root, kit.paths.personas);
    const journeyDir = await readDir(root, kit.paths.journeys);
    const stationsPath = `${kit.paths.journeys}/${STATIONS_FILE}`;
    return {
        personas,
        stations: journeyDir.find((f) => f.path === stationsPath) ?? null,
        journeys: journeyDir.filter((f) => f.path !== stationsPath),
    };
}
//# sourceMappingURL=load.js.map