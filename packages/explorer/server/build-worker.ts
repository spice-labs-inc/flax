import { parentPort, workerData } from "node:worker_threads";
import { buildData, writeData, type BuildInput } from "../scripts/build.ts";

export interface WorkerInput {
  outDir: string;
  build: Omit<BuildInput, "log" | "shrink">;
}

const input = workerData as WorkerInput;
const lines: string[] = [];
writeData(
  input.outDir,
  await buildData({ ...input.build, log: (l) => lines.push(l) }),
);
parentPort?.postMessage(lines);
