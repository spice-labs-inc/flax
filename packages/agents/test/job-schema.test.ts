import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobSchemaCheck } from "../src/check/job-schema.ts";
import { THINKING_LEVELS } from "../src/lib/job.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { jobFiles, makeRepo, run } from "./helpers.ts";

async function problemsFor(
  overrides: Record<string, unknown>,
  name = "demo",
): Promise<string[]> {
  return run(
    jobSchemaCheck,
    makeRepo({ jobs: { [name]: jobFiles(name, overrides) } }),
  );
}

const FILE = "jobs/demo/job.yml";

describe("job.yml schema", () => {
  it("accepts a valid job with each trigger and output kind", async () => {
    const root = makeRepo({
      jobs: {
        daily: jobFiles("daily", { trigger: { schedule: "0 13 * * 1-5" } }),
        later: jobFiles("later", {
          trigger: { after: "daily" },
          output: { kind: "slack", channel: "agents-shadow" },
        }),
        fixer: jobFiles("fixer", {
          output: {
            kind: "pr",
            repos: ["notes-co/example"],
            paths: ["docs/**"],
            max_changed_lines: 50,
            untrusted_input: "open_pr",
          },
        }),
      },
    });
    expect(await run(jobSchemaCheck, root)).toEqual([]);
  });

  it("rejects unknown keys at the top level and inside objects", async () => {
    expect(await problemsFor({ schedule: "x" })).toEqual([
      `${FILE}: schedule: is not an allowed key`,
    ]);
    expect(
      await problemsFor({
        limits: { turns: 1, tokens_per_run: 1, usd_per_month: 1, minutes: 5 },
      }),
    ).toEqual([`${FILE}: limits.minutes: is not an allowed key`]);
  });

  it("names missing required fields", async () => {
    const root = makeRepo({
      jobs: { demo: { ...jobFiles("demo"), "job.yml": "name: demo\n" } },
    });
    const problems = await run(jobSchemaCheck, root);
    for (const field of [
      "owner",
      "purpose",
      "trigger",
      "model",
      "thinking",
      "limits",
      "tools",
      "output",
      "mode",
    ]) {
      expect(problems).toContain(`${FILE}: ${field}: is required`);
    }
  });

  it("requires exactly one trigger form", async () => {
    const message = `${FILE}: trigger: must have exactly one of schedule, after, manual, envs`;
    expect(await problemsFor({ trigger: {} })).toEqual([message]);
    expect(
      await problemsFor({ trigger: { manual: true, schedule: "0 1 * * *" } }),
    ).toEqual([message]);
    expect(await problemsFor({ trigger: { manual: false } })).toEqual([
      `${FILE}: trigger.manual: must be true`,
    ]);
  });

  it("rejects cron expressions GitHub would not run", async () => {
    expect(await problemsFor({ trigger: { schedule: "0 25 * * *" } })).toEqual([
      `${FILE}: trigger.schedule: "0 25 * * *" is not a valid cron expression: hour 25 is out of range 0-23`,
    ]);
    expect(await problemsFor({ trigger: { schedule: "@daily" } })).toEqual([
      `${FILE}: trigger.schedule: "@daily" is not a valid cron expression: has 1 fields; cron needs exactly 5`,
    ]);
  });

  it("applies the fields each output kind needs and no others", async () => {
    expect(await problemsFor({ output: { kind: "slack" } })).toEqual([
      `${FILE}: output.channel: is required`,
    ]);
    expect(
      await problemsFor({ output: { kind: "file", channel: "agents-shadow" } }),
    ).toEqual([`${FILE}: output.channel: is not an allowed key`]);
    const pr = await problemsFor({
      output: { kind: "pr", repos: ["notes-co/example"] },
    });
    expect(pr).toEqual([
      `${FILE}: output.paths: is required`,
      `${FILE}: output.max_changed_lines: is required`,
      `${FILE}: output.untrusted_input: is required`,
    ]);
    expect(await problemsFor({ output: { kind: "email" } })).toEqual([
      `${FILE}: output.kind: must be one of slack, pr, youtube, file, results`,
    ]);
  });

  it("never lets a pr job change or stamp intent, audience or owner", async () => {
    const pr = {
      kind: "pr",
      repos: ["notes-co/example"],
      paths: ["docs/**"],
      max_changed_lines: 5,
      untrusted_input: "report_only",
    };
    expect(
      await problemsFor({
        output: {
          ...pr,
          frontmatter_keys: ["depends_on"],
          stamp_keys: ["analyzed_commit"],
        },
      }),
    ).toEqual([]);
    for (const field of ["frontmatter_keys", "stamp_keys"])
      for (const key of ["intent", "audience", "owner"]) {
        const problems = await problemsFor({
          output: { ...pr, [field]: [key] },
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(
          new RegExp(`^jobs/demo/job\\.yml: output\\.${field}\\[0\\]: `),
        );
      }
  });

  it("keeps pr paths inside the repository", async () => {
    for (const path of ["/etc/passwd", "../other", "docs/../../x"]) {
      const problems = await problemsFor({
        output: {
          kind: "pr",
          repos: ["notes-co/example"],
          paths: [path],
          max_changed_lines: 5,
          untrusted_input: "report_only",
        },
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(
        /^jobs\/demo\/job\.yml: output\.paths\[0\]: /,
      );
    }
  });

  it("requires the name to match the folder and the naming pattern", async () => {
    expect(await problemsFor({ name: "other" })).toEqual([
      `${FILE}: name: "other" must equal the folder name "demo"`,
    ]);
    const root = makeRepo({ jobs: { Demo_1: jobFiles("Demo_1") } });
    expect(await run(jobSchemaCheck, root)).toEqual([
      'jobs/Demo_1/job.yml: name: "Demo_1" must match ^[a-z][a-z0-9-]{1,40}$',
    ]);
  });

  it("checks the owner handle", async () => {
    expect(await problemsFor({ owner: "not a handle" })).toEqual([
      `${FILE}: owner: "not a handle" must match ^[A-Za-z0-9-]{1,39}$`,
    ]);
    expect(await problemsFor({ owner: "CHANGE-ME" })).toEqual([
      `${FILE}: owner: "CHANGE-ME" is a placeholder; replace it`,
    ]);
  });

  it("bounds every limit to a positive integer under its maximum", async () => {
    const limits = (l: Record<string, unknown>) =>
      problemsFor({
        limits: { turns: 1, tokens_per_run: 1, usd_per_month: 1, ...l },
      });
    expect(await limits({ turns: 201 })).toEqual([
      `${FILE}: limits.turns: must be <= 200`,
    ]);
    expect(await limits({ tokens_per_run: 2_000_001 })).toEqual([
      `${FILE}: limits.tokens_per_run: must be <= 2000000`,
    ]);
    // The month budget itself is flax.yml agents.budgetUsdPerMonth, checked by the budget check.
    expect(await limits({ usd_per_month: 1_000_001 })).toEqual([
      `${FILE}: limits.usd_per_month: must be <= 1000000`,
    ]);
    expect(await limits({ turns: 0 })).toEqual([
      `${FILE}: limits.turns: must be >= 1`,
    ]);
    expect(await limits({ turns: 2.5 })).toEqual([
      `${FILE}: limits.turns: must be integer`,
    ]);
    expect(
      await limits({
        turns: 200,
        tokens_per_run: 2_000_000,
        usd_per_month: 175,
      }),
    ).toEqual([]);
  });

  it("takes exactly the thinking levels Pi takes, a bare off included", async () => {
    const schema = JSON.parse(
      readFileSync(join(KIT_ROOT, "schema/job.schema.json"), "utf8"),
    );
    expect(schema.properties.thinking.enum).toEqual([...THINKING_LEVELS]);
    for (const thinking of THINKING_LEVELS)
      expect(await problemsFor({ thinking })).toEqual([]);
    for (const thinking of ["none", "HIGH", "", true])
      expect(await problemsFor({ thinking })).toEqual([
        `${FILE}: thinking: must be one of off, minimal, low, medium, high, xhigh, max`,
      ]);
    const bare = jobFiles("demo");
    bare["job.yml"] = bare["job.yml"]!.replace(
      "thinking: high",
      "thinking: off",
    );
    const root = makeRepo({ jobs: { demo: bare } });
    expect(await run(jobSchemaCheck, root)).toEqual([]);
    expect(loadRepo(root).jobs[0]!.config!.thinking).toBe("off");
  });

  it("only allows shadow and live modes", async () => {
    expect(await problemsFor({ mode: "yolo" })).toEqual([
      `${FILE}: mode: must be one of shadow, live`,
    ]);
  });

  it("reports YAML that does not parse", async () => {
    const root = makeRepo({
      jobs: { demo: { ...jobFiles("demo"), "job.yml": "name: [demo\n" } },
    });
    const problems = await run(jobSchemaCheck, root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^jobs\/demo\/job\.yml: is not valid YAML: /);
  });
});
