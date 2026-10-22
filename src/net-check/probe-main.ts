import { readFileSync } from "node:fs";
import { probe, type ProbePlan } from "./probe.ts";

// The bundle's entry point in the box: node probe.mjs <plan.json>, result on standard output.
const plan = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as ProbePlan;
process.stdout.write(`${JSON.stringify(await probe(plan))}\n`);
