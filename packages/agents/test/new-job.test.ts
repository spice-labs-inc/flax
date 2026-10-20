import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runChecks } from "../src/check/index.ts";
import { generate } from "../src/generate/generate.ts";
import { formatted } from "./helpers.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { scaffoldJob } from "../src/new-job/scaffold.ts";
import { listTemplates } from "../src/new-job/template.ts";
import { makeRepo } from "./helpers.ts";

describe("flax agents new-job", () => {
  it("creates a job that passes every check once generated", async () => {
    const root = makeRepo();
    expect(scaffoldJob(root, "weekly-digest", { owner: "octocat" })).toEqual([
      "jobs/weekly-digest/job.yml",
      "jobs/weekly-digest/prompt.md",
      "jobs/weekly-digest/output.json",
      "jobs/weekly-digest/fixtures/input.json",
      "jobs/weekly-digest/fixtures/output.json",
    ]);
    await generate(loadRepo(root));
    expect(formatted(await runChecks(loadRepo(root)))).toEqual([]);
  });

  it("writes every job.yml field, in shadow mode", () => {
    const root = makeRepo();
    scaffoldJob(root, "demo", { owner: "octocat" });
    const job = parse(readFileSync(join(root, "jobs/demo/job.yml"), "utf8"));
    expect(Object.keys(job)).toEqual([
      "name",
      "owner",
      "purpose",
      "trigger",
      "model",
      "thinking",
      "limits",
      "tools",
      "collect_tools",
      "output",
      "mode",
    ]);
    expect(Object.keys(job.limits)).toEqual([
      "turns",
      "tokens_per_run",
      "usd_per_month",
      "tool_calls",
      "tool_seconds",
      "collect_tool_calls",
    ]);
    expect(job.mode).toBe("shadow");
    expect(job.model).toBe("acme/test-model");
    expect(job.thinking).toBe("high");
  });

  it("leaves a placeholder owner that the check rejects until it is set", async () => {
    const root = makeRepo();
    scaffoldJob(root, "demo");
    expect(formatted(await runChecks(loadRepo(root)))).toContain(
      'jobs/demo/job.yml: owner: "CHANGE-ME" is a placeholder; replace it',
    );
  });

  it("refuses names that exist or do not fit the pattern", () => {
    const root = makeRepo();
    mkdirSync(join(root, "jobs/taken"));
    expect(() => scaffoldJob(root, "taken")).toThrow(
      "jobs/taken already exists",
    );
    for (const name of ["Upper", "x", "1st", "under_score", "a".repeat(42)]) {
      expect(() => scaffoldJob(root, name)).toThrow("is not a valid job name");
    }
  });
});

describe("flax agents new-job --template", () => {
  it("lists the seven templates the kit ships", () => {
    expect(listTemplates().map((t) => t.name)).toEqual([
      "atlas-doc-refresh",
      "atlas-map-refresh",
      "atlas-wiring-eval",
      "hello",
      "scenario-checks",
      "scenario-watch",
      "tools-proof",
    ]);
    for (const template of listTemplates()) {
      expect(template.description, template.name).not.toBe("");
      expect(template.files, template.name).toContain("job.yml");
      expect(template.files, template.name).not.toContain("template.yml");
    }
  });

  it("copies a template with every placeholder filled from the workspace and --set", async () => {
    const root = makeRepo();
    const files = scaffoldJob(root, "greet", {
      owner: "octocat",
      template: "hello",
      set: { model: "acme/test-model" },
    });
    expect(files).toContain("jobs/greet/job.yml");
    for (const file of files) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text, file).not.toContain("{{");
    }
    const job = parse(readFileSync(join(root, "jobs/greet/job.yml"), "utf8"));
    expect(job.name).toBe("greet");
    expect(job.owner).toBe("octocat");
    expect(job.model).toBe("acme/test-model");
    await generate(loadRepo(root));
    expect(formatted(await runChecks(loadRepo(root)))).toEqual([]);
  });

  it("refuses a template field left unset, naming --set, and a field the template does not have", () => {
    const root = makeRepo();
    expect(() =>
      scaffoldJob(root, "greet", { owner: "octocat", template: "hello" }),
    ).toThrow("hello needs --set model=<anthropic/claude-sonnet-4-5>");
    expect(() =>
      scaffoldJob(root, "greet", {
        owner: "octocat",
        template: "hello",
        set: { model: "acme/test-model", voice: "alto" },
      }),
    ).toThrow("hello has no field voice; its fields are model");
    expect(() =>
      scaffoldJob(root, "greet", { owner: "octocat", template: "nope" }),
    ).toThrow("there is no template named nope");
    expect(existsSync(join(root, "jobs/greet"))).toBe(false);
  });
});
