import { type BuildInput } from "../scripts/build.ts";
export interface WorkerInput {
    outDir: string;
    build: Omit<BuildInput, "log" | "shrink">;
}
