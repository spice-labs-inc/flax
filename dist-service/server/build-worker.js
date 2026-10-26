import { parentPort, workerData } from "node:worker_threads";
import { buildData, writeData } from "../scripts/build.js";
const input = workerData;
const lines = [];
writeData(input.outDir, await buildData({ ...input.build, log: (l) => lines.push(l) }));
parentPort?.postMessage(lines);
//# sourceMappingURL=build-worker.js.map