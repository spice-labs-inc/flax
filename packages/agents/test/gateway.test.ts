import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { allowlistsCheck } from "../src/check/allowlists.ts";
import { gatewayCheck } from "../src/check/gateway.ts";
import { generate } from "../src/generate/generate.ts";
import { KIT_ACTION_STEP, renderWorkflow } from "../src/generate/render.ts";
import type { Model } from "../src/lib/allowlists.ts";
import {
  caProblem,
  gatewayModelName,
  modelRefusal,
  piModel,
  usableModels,
} from "../src/lib/gateway.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { worstCaseUsd } from "../src/run-job/budget.ts";
import { keyMinutes, issueBody } from "../src/run-job/gateway.ts";
import { TLS } from "./fake-gateway.ts";
import {
  BOX,
  GATEWAY,
  jobConfig,
  jobFiles,
  makeRepo,
  MODEL,
  run,
} from "./helpers.ts";

const ACME: Model = {
  id: MODEL,
  provider: "acme",
  usd_per_million_input: 1,
  usd_per_million_output: 2,
};
const CLAUDE: Model = {
  id: "anthropic/claude-test-1",
  provider: "anthropic",
  usd_per_million_input: 4,
  usd_per_million_output: 20,
};
const PLACEHOLDER: Model = {
  id: "anthropic/claude-maybe-2",
  provider: "anthropic",
  confirmed: false,
  usd_per_million_input: 2,
  usd_per_million_output: 10,
};
const MODELS = [ACME, CLAUDE, PLACEHOLDER];
const NOW = new Date("2026-09-25T12:00:00Z");

function gatewayRepo(
  gateway: unknown,
  extra: { ca?: string | null; model?: string; limits?: object } = {},
) {
  return makeRepo({
    jobs: {
      demo: jobFiles("demo", {
        ...(extra.model === undefined ? {} : { model: extra.model }),
        ...(extra.limits === undefined ? {} : { limits: extra.limits }),
      }),
    },
    models: MODELS,
    gateway,
    ...(extra.ca === undefined || extra.ca === null
      ? {}
      : { files: { "gateway-ca.pem": extra.ca } }),
  });
}

describe("gateway.yml", () => {
  it("passes with a valid CA root", async () => {
    const root = gatewayRepo(GATEWAY, { ca: TLS.ca });
    expect(await run(gatewayCheck, root)).toEqual([]);
    expect(loadRepo(root).gatewayCa).toBe(TLS.ca);
  });

  it("is required and validated against its schema, with no on or off switch", async () => {
    expect(await run(gatewayCheck, gatewayRepo(null))).toEqual([
      "gateway.yml: is missing",
    ]);
    expect(
      await run(
        gatewayCheck,
        gatewayRepo({
          ...GATEWAY,
          enabled: true,
          url: "http://192.168.128.1:8443/path",
          key_max_minutes: 0,
        }),
      ),
    ).toEqual([
      "gateway.yml: enabled: is not an allowed key",
      'gateway.yml: url: "http://192.168.128.1:8443/path" must match ^https://[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$',
      "gateway.yml: key_max_minutes: must be >= 1",
    ]);
  });

  it.each<[string, string | null, string]>([
    [
      "the placeholder",
      "Placeholder: no certificate yet.\n",
      "gateway-ca.pem: holds no PEM certificate; paste the gateway's CA root (see Model gateway in docs/runtime.md)",
    ],
    [
      "a private key next to the certificate",
      `${TLS.ca}${TLS.leafKey}`,
      'gateway-ca.pem: holds a PEM "EC PRIVATE KEY" block; it may hold only the CA root certificate',
    ],
    [
      "a leaf certificate",
      TLS.leaf,
      'gateway-ca.pem: holds "CN=localhost", which is not a CA certificate',
    ],
    [
      "an expired CA",
      TLS.expiredCa,
      "gateway-ca.pem: holds a certificate that expired on Jan  1 00:00:00 2001 GMT",
    ],
    [
      "no file",
      null,
      "gateway.yml: ca: names test-ca.pem, which is not a file at the repository root",
    ],
  ])("refuses %s as the CA root", async (_, ca, message) => {
    const root =
      ca === null
        ? gatewayRepo({ ...GATEWAY, ca: "test-ca.pem" })
        : gatewayRepo(GATEWAY, { ca });
    expect(await run(gatewayCheck, root)).toEqual([message]);
    expect(loadRepo(root).gatewayCa).toBeUndefined();
  });

  it("checks a CA against the time given", () => {
    expect(caProblem(TLS.ca, new Date())).toBeUndefined();
    expect(caProblem(TLS.ca, new Date("1990-01-01T00:00:00Z"))).toMatch(
      /^holds a certificate that is not valid before /,
    );
    expect(
      caProblem(`${TLS.ca}${TLS.otherCa}`, new Date("2030-01-01T00:00:00Z")),
    ).toBeUndefined();
    expect(caProblem("-----BEGIN CERTIFICATE-----\nAAAA\n", NOW)).toBe(
      "holds a certificate block that is not closed",
    );
  });

  it("refuses a job whose run key would pass the gateway's ceilings", async () => {
    // 2,000,000 tokens at $20 per million is $40 over $25; 200 turns is 190 minutes over 120.
    const root = gatewayRepo(GATEWAY, {
      model: CLAUDE.id,
      limits: { turns: 200, tokens_per_run: 2000000, usd_per_month: 50 },
    });
    expect(await run(gatewayCheck, root)).toEqual([
      "jobs/demo/job.yml: limits.tokens_per_run: a run's worst case at anthropic/claude-test-1 is $40.00, over the gateway's $25 ceiling for one key (key_max_usd in gateway.yml)",
      "jobs/demo/job.yml: limits.turns: a run key would need 190 minutes, over the gateway's 120-minute ceiling (key_max_minutes in gateway.yml)",
    ]);
  });
});

describe("the models a run may use", () => {
  it("are every confirmed model, from any provider", async () => {
    for (const model of [ACME.id, CLAUDE.id])
      expect(
        await run(allowlistsCheck, gatewayRepo(GATEWAY, { model })),
      ).toEqual([]);
    expect(usableModels(MODELS).map((m) => m.id)).toEqual([MODEL, CLAUDE.id]);
    expect(modelRefusal(ACME)).toBeUndefined();
  });

  it("never include a placeholder", async () => {
    expect(
      await run(
        allowlistsCheck,
        gatewayRepo(GATEWAY, { model: PLACEHOLDER.id }),
      ),
    ).toEqual([
      'jobs/demo/job.yml: model: "anthropic/claude-maybe-2" is marked confirmed: false in models.yml (a placeholder); confirm its id and prices first',
    ]);
  });

  it("no longer take via in models.yml", async () => {
    const root = makeRepo({
      jobs: { demo: jobFiles("demo") },
      models: [ACME, { ...CLAUDE, via: "gateway" }],
    });
    expect(await run(allowlistsCheck, root)).toContain(
      "models.yml: [1].via: is not an allowed key",
    );
  });

  it("are named the gateway's way and Pi's way", () => {
    expect(gatewayModelName(ACME)).toBe("test-model");
    expect(gatewayModelName(CLAUDE)).toBe("claude-test-1");
    expect(piModel(ACME)).toBe(MODEL);
    expect(piModel(CLAUDE)).toBe("acme/claude-test-1");
    expect(piModel({ id: "acme/acme-deepseek-v4.1-flash" })).toBe(
      "acme/acme-deepseek-v4.1-flash",
    );
  });
});

describe("run keys", () => {
  const job = jobConfig("demo", {
    limits: { turns: 30, tokens_per_run: 400000, usd_per_month: 5 },
  }) as never;

  it("get the job's worst case at the model's higher price as their budget", () => {
    // 400,000 tokens at the higher of each model's two prices.
    expect(worstCaseUsd(job, ACME)).toBeCloseTo(0.8, 10);
    expect(worstCaseUsd(job, CLAUDE)).toBeCloseTo(8, 10);
    const models: [Model, number][] = [
      [
        {
          id: "acme/acme-deepseek-v4.1-flash",
          provider: "acme",
          usd_per_million_input: 0.15,
          usd_per_million_output: 0.6,
        },
        0.24,
      ],
      [
        {
          id: "acme/acme-glm-5.3",
          provider: "acme",
          usd_per_million_input: 1.4,
          usd_per_million_output: 4.4,
        },
        1.76,
      ],
      [
        {
          id: "anthropic/claude-haiku-4-5",
          provider: "anthropic",
          usd_per_million_input: 1,
          usd_per_million_output: 5,
        },
        2,
      ],
    ];
    for (const [model, usd] of models)
      expect(worstCaseUsd(job, model)).toBeCloseTo(usd, 10);
  });

  it("live as long as the box's timeout plus ten minutes", () => {
    expect(keyMinutes(job)).toBe(40);
    // A pull request job's key also covers the second check, ten minutes more.
    expect(
      keyMinutes({
        limits: { turns: 30, tokens_per_run: 400000, usd_per_month: 5 },
        output: {
          kind: "pr",
          repos: ["notes-co/atlas"],
          paths: ["repos/*.md"],
          max_changed_lines: 10,
          untrusted_input: "report_only",
        },
      }),
    ).toBe(50);
    expect(
      keyMinutes({ limits: { turns: 1, tokens_per_run: 1, usd_per_month: 1 } }),
    ).toBe(11);
    // The box's timeout is capped at three hours.
    expect(
      keyMinutes({
        limits: { turns: 200, tokens_per_run: 1, usd_per_month: 1 },
      }),
    ).toBe(190);
  });

  it("are asked for with exactly one model, the budget, the expiry and the run's name", () => {
    expect(
      issueBody("agents", {
        job: "demo",
        model: CLAUDE,
        month: "2026-09",
        runName: "job-demo-77-1",
        maxBudgetUsd: 8,
        minutes: 40,
        metadata: { workflow_run: "77" },
      }),
    ).toEqual({
      team_id: "agents",
      key_alias: "agents/demo/2026-09/job-demo-77-1",
      models: ["claude-test-1"],
      max_budget: 8,
      duration: "40m",
      max_parallel_requests: 2,
      rpm_limit: 60,
      key_type: "llm_api",
      metadata: {
        job: "demo",
        run: "job-demo-77-1",
        month: "2026-09",
        model: "anthropic/claude-test-1",
        workflow_run: "77",
      },
    });
  });

  it("may also name the second check's model, so one key serves the writer and the checker", () => {
    const body = issueBody("agents", {
      job: "demo",
      model: CLAUDE,
      alsoModels: [ACME],
      month: "2026-09",
      runName: "job-demo-77-1",
      maxBudgetUsd: 8,
      minutes: 40,
    }) as { models: string[]; metadata: { model: string } };
    expect(body.models).toEqual(["claude-test-1", "test-model"]);
    expect(body.metadata.model).toBe("anthropic/claude-test-1");
  });
});

describe("generated workflows", () => {
  function runStep(workflow: string) {
    const doc = parse(workflow) as {
      on: {
        workflow_dispatch: { inputs: { model: { options: string[] } } };
      };
      jobs: { run: { steps: { name?: string; env?: object }[] } };
    };
    return {
      env: doc.jobs.run.steps.find((s) => s.name === KIT_ACTION_STEP)!.env,
      models: doc.on.workflow_dispatch.inputs.model.options,
    };
  }

  it("hand the step that runs the job only the issuer key, never a model provider's key", async () => {
    const workflow = await renderWorkflow(
      jobConfig("demo") as never,
      BOX,
      [],
      [MODEL],
    );
    expect(runStep(workflow).env).toEqual({
      LLM_GATEWAY_ISSUER_KEY: "${{ secrets.LLM_GATEWAY_ISSUER_KEY }}",
      RUN_MODEL: "${{ inputs.model }}",
      RUN_THINKING: "${{ inputs.thinking }}",
    });
    expect(workflow).not.toContain("ACME_API_KEY");
  });

  it("offer only the models a run may use", async () => {
    const root = gatewayRepo(GATEWAY);
    await generate(loadRepo(root));
    expect(
      runStep(
        readFileSync(join(root, ".github/workflows/job-demo.yml"), "utf8"),
      ).models,
    ).toEqual([MODEL, CLAUDE.id]);
  });
});
