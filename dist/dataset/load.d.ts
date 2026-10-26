import type { DatasetFile, DatasetFiles } from "./schema.ts";
export declare const STATIONS_FILE = "stations.yml";
export declare function parseDatasetFile(path: string, text: string): DatasetFile;
/** Reads `personas/*.yml`, `journeys/stations.yml` and `journeys/<persona>.yml` under `root`. */
export declare function loadDatasetFiles(root: string): Promise<DatasetFiles>;
