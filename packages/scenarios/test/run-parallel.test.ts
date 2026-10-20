import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "@cucumber/messages";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holderGone, withFileLock } from "../src/run/lock.ts";
import { scenarioResults } from "../src/run/messages.ts";
import { touchesMediaType } from "../src/run/results.ts";
import { canRunAlongside } from "../src/run/tags.ts";

const tagged = (...names: string[]) => ({
  tags: names.map((name) => ({ name })),
});

describe("canRunAlongside", () => {
  it("runs a serial scenario only while no other serial one runs", () => {
    expect(canRunAlongside(tagged("@serial"), [tagged("@fixture")])).toBe(true);
    expect(canRunAlongside(tagged("@serial"), [tagged("@serial")])).toBe(false);
    expect(canRunAlongside(tagged("@dispatch"), [tagged("@serial")])).toBe(
      false,
    );
    expect(canRunAlongside(tagged("@serial"), [])).toBe(true);
  });

  it("never holds back a scenario that is not serial", () => {
    expect(canRunAlongside(tagged("@fixture"), [tagged("@serial")])).toBe(true);
  });
});

describe("withFileLock", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "run-lock-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lets one holder in at a time and removes the lock afterwards", async () => {
    const lock = join(dir, "build.lock");
    let inside = 0;
    let most = 0;
    const hold = () =>
      withFileLock(
        lock,
        async () => {
          most = Math.max(most, ++inside);
          await new Promise((r) => setTimeout(r, 30));
          inside--;
        },
        { pollMs: 5 },
      );
    await Promise.all([hold(), hold(), hold()]);
    expect(most).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("releases the lock when the work fails", async () => {
    const lock = join(dir, "build.lock");
    await expect(
      withFileLock(lock, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(existsSync(lock)).toBe(false);
  });

  it("takes over a lock left by a process that is gone, and waits for a live one", async () => {
    const lock = join(dir, "build.lock");
    await writeFile(lock, "999999999 0\n");
    expect(holderGone(await readFile(lock, "utf8"))).toBe(true);
    expect(await withFileLock(lock, async () => "built")).toBe("built");

    await writeFile(lock, `${process.pid} 0\n`);
    expect(holderGone(await readFile(lock, "utf8"))).toBe(false);
    await expect(
      withFileLock(lock, async () => "built", { timeoutMs: 50, pollMs: 10 }),
    ).rejects.toThrow("gave up waiting");
  });
});

describe("scenarioResults with parallel workers", () => {
  const ts = (s: number) => ({ seconds: s, nanos: 0 });
  /** One scenario's messages as one worker sends them. */
  const scenario = (n: number, worker: string, start: number): Envelope[] => [
    {
      testCaseStarted: {
        id: `a${n}`,
        testCaseId: `tc${n}`,
        attempt: 0,
        timestamp: ts(start),
        workerId: worker,
      },
    },
    {
      testStepFinished: {
        testCaseStartedId: `a${n}`,
        testStepId: `ts${n}`,
        timestamp: ts(start + 1),
        testStepResult: { status: "PASSED" as never, duration: ts(1) },
      },
    },
    {
      attachment: {
        testCaseStartedId: `a${n}`,
        mediaType: touchesMediaType(),
        body: JSON.stringify([{ item: `item:${n}` }]),
        contentEncoding: "IDENTITY" as never,
      },
    },
    {
      testCaseFinished: {
        testCaseStartedId: `a${n}`,
        timestamp: ts(start + 10 * n),
        willBeRetried: false,
      },
    },
  ];
  const definitions = (n: number): Envelope[] => [
    {
      pickle: {
        id: `p${n}`,
        uri: "features/x.feature",
        location: { line: n },
        name: `scenario ${n}`,
        language: "en",
        steps: [{ id: `s${n}`, text: "a step", astNodeIds: [] }],
        tags: [],
        astNodeIds: [],
      },
    },
    {
      testCase: {
        id: `tc${n}`,
        pickleId: `p${n}`,
        testSteps: [{ id: `ts${n}`, pickleStepId: `s${n}` }],
      },
    },
  ];

  it("keeps each scenario's steps, touches and duration when workers interleave", () => {
    const one = scenario(1, "0", 100);
    const two = scenario(2, "1", 100);
    const interleaved = one.flatMap((e, i) => [e, two[i]!]);
    const results = scenarioResults([
      ...definitions(1),
      ...definitions(2),
      ...interleaved,
    ]);
    expect(
      results.map((r) => [r.id, r.status, r.durationMs, r.touches]),
    ).toEqual([
      ["features/x.feature:1", "passed", 10_000, [{ item: "item:1" }]],
      ["features/x.feature:2", "passed", 20_000, [{ item: "item:2" }]],
    ]);
  });
});
