import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  findCycles,
  MAX_CHAIN_DEPTH,
  triggerProblems,
  triggersCheck,
} from "../src/check/triggers.ts";
import { jobFiles, makeRepo, run } from "./helpers.ts";

function after(target: string) {
  return { trigger: { after: target } };
}

describe("after triggers", () => {
  it(`accepts a chain ${MAX_CHAIN_DEPTH} steps deep`, async () => {
    const root = makeRepo({
      jobs: {
        aa: jobFiles("aa", { trigger: { schedule: "0 1 * * *" } }),
        bb: jobFiles("bb", after("aa")),
        cc: jobFiles("cc", after("bb")),
        dd: jobFiles("dd", after("cc")),
      },
    });
    expect(await run(triggersCheck, root)).toEqual([]);
  });

  it("rejects a chain deeper than GitHub runs", async () => {
    const root = makeRepo({
      jobs: {
        aa: jobFiles("aa"),
        bb: jobFiles("bb", after("aa")),
        cc: jobFiles("cc", after("bb")),
        dd: jobFiles("dd", after("cc")),
        ee: jobFiles("ee", after("dd")),
      },
    });
    expect(await run(triggersCheck, root)).toEqual([
      'jobs/ee/job.yml: trigger.after: is 4 "after" steps from a scheduled or manual job; GitHub only chains 3',
    ]);
  });

  it("rejects an after that names no job", async () => {
    const root = makeRepo({ jobs: { demo: jobFiles("demo", after("ghost")) } });
    expect(await run(triggersCheck, root)).toEqual([
      'jobs/demo/job.yml: trigger.after: "ghost" is not an existing job',
    ]);
  });

  it("rejects cycles, including a job that waits on itself", async () => {
    const root = makeRepo({
      jobs: {
        aa: jobFiles("aa", after("bb")),
        bb: jobFiles("bb", after("aa")),
        cc: jobFiles("cc", after("aa")),
        me: jobFiles("me", after("me")),
      },
    });
    expect(await run(triggersCheck, root)).toEqual([
      "jobs/aa/job.yml: trigger.after: trigger cycle: aa -> bb -> aa",
      "jobs/me/job.yml: trigger.after: trigger cycle: me -> me",
    ]);
  });

  it("finds exactly the jobs that sit on a cycle, for any graph", () => {
    const graphs = fc
      .integer({ min: 1, max: 12 })
      .chain((n) =>
        fc.array(
          fc.option(fc.integer({ min: 0, max: n }), { nil: undefined }),
          { minLength: n, maxLength: n },
        ),
      );
    fc.assert(
      fc.property(graphs, (targets) => {
        const n = targets.length;
        // Index n stands for a job that does not exist.
        const graph = new Map(
          targets.map((t, i) => [
            `j${i}`,
            t === undefined ? undefined : `j${t}`,
          ]),
        );
        const onCycle = new Set<string>();
        for (let i = 0; i < n; i++) {
          let current: number | undefined = targets[i];
          for (
            let step = 0;
            step < n && current !== undefined && current < n;
            step++
          ) {
            if (current === i) {
              onCycle.add(`j${i}`);
              break;
            }
            current = targets[current];
          }
        }
        const cycles = findCycles(graph);
        const found = cycles.flat();
        expect(new Set(found)).toEqual(onCycle);
        expect(found).toHaveLength(onCycle.size);
        for (const cycle of cycles) {
          for (const [i, job] of cycle.entries())
            expect(graph.get(job)).toBe(cycle[(i + 1) % cycle.length]);
        }
        expect(
          triggerProblems(graph).filter((p) =>
            p.message.startsWith("trigger cycle"),
          ),
        ).toHaveLength(cycles.length);
      }),
    );
  });
});
