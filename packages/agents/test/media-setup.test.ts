import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { bundleOne } from "../src/bundle/build.ts";
import { bundleExternals, mediaCheck } from "../src/check/media.ts";
import { generate } from "../src/generate/generate.ts";
import {
  KIT_ACTION_STEP,
  PACKAGES_TOKEN_RUN,
  PACKAGES_TOKEN_STEP,
} from "../src/generate/render.ts";
import { MEDIA_EXTERNALS } from "../src/lib/media.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { FLAX_TEXT, makeRepo, jobFiles, run } from "./helpers.ts";
import {
  loadWorkspace,
  setWorkspaceRoot,
  workspaceRoot,
} from "../src/lib/workspace.ts";

const MEDIA = { network: "public", secrets: [], timeout_minutes: 5 };
const MEDIA_TS = "console.log('');\n";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  id?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};

async function steps(
  media: unknown,
  overrides: Record<string, unknown> = {},
): Promise<Step[]> {
  const root = makeRepo({
    jobs: { demo: { ...jobFiles("demo", { media, ...overrides }), "media.ts": MEDIA_TS } },
  });
  await generate(loadRepo(root));
  return parse(
    readFileSync(join(root, ".github/workflows/job-demo.yml"), "utf8"),
  ).jobs.run.steps;
}

describe("media setup in the workflow", () => {
  it("installs packages, Chromium and Java, then the workspace's own setup steps, in that order, before the tailnet join and the run", async () => {
    const all = await steps({
      ...MEDIA,
      network: "tailnet",
      setup: ["java", "notes-cli", "chromium", "packages"],
    });
    const names = all.map((s) => s.name ?? s.uses);
    const at = names.indexOf("Set up pnpm");
    expect(names.slice(at, at + 8)).toEqual([
      "Set up pnpm",
      "Install the locked packages",
      "Install Chromium for Playwright",
      "Set up JDK 21",
      "Make sure Maven is installed",
      "Install the notes-co CLI",
      "Join the tailnet",
      KIT_ACTION_STEP,
    ]);
    expect(all[at + 1]!.run).toBe("pnpm install --frozen-lockfile");
    expect(all[at + 2]!.run).toBe(
      "pnpm exec playwright install --with-deps chromium",
    );
    expect(all[at + 3]).toMatchObject({
      uses: "actions/setup-java@v5",
      with: { distribution: "temurin", "java-version": "21" },
    });
    for (const step of all.slice(at, at + 6)) expect(step.env).toBeUndefined();
  });

  it("checks out each source read-only with a reader token for those repositories alone", async () => {
    const all = await steps({
      ...MEDIA,
      sources: ["notes-co/sample-apps", "notes-co/ancho"],
    });
    const at = all.findIndex(
      (s) => s.name === "Make a read token for the media sources",
    );
    expect(all[at]).toEqual({
      name: "Make a read token for the media sources",
      id: "media-sources-token",
      uses: "actions/create-github-app-token@v2",
      with: {
        "app-id": "${{ secrets.AGENTS_READER_APP_ID }}",
        "private-key": "${{ secrets.AGENTS_READER_PRIVATE_KEY }}",
        owner: "notes-co",
        repositories: "sample-apps,ancho",
        "permission-contents": "read",
      },
    });
    expect(all.slice(at + 1, at + 3)).toEqual([
      {
        name: "Check out notes-co/sample-apps",
        uses: "actions/checkout@v5",
        with: {
          repository: "notes-co/sample-apps",
          token: "${{ steps.media-sources-token.outputs.token }}",
          path: "media-sources/sample-apps",
          "persist-credentials": false,
        },
      },
      {
        name: "Check out notes-co/ancho",
        uses: "actions/checkout@v5",
        with: {
          repository: "notes-co/ancho",
          token: "${{ steps.media-sources-token.outputs.token }}",
          path: "media-sources/ancho",
          "persist-credentials": false,
        },
      },
    ]);
    expect(all[at + 3]!.name).toBe(KIT_ACTION_STEP);
  });

  it("checks out a source with its submodules, the read token covering the private ones", async () => {
    const all = await steps({
      ...MEDIA,
      sources: [
        "notes-co/sample-apps",
        {
          repo: "notes-co/survey-build",
          submodules: ["notes-co/widget", "notes-co/sassafras"],
        },
      ],
    });
    const at = all.findIndex(
      (s) => s.name === "Make a read token for the media sources",
    );
    expect(all[at]!.with!.repositories).toBe(
      "sample-apps,survey-build,widget,sassafras",
    );
    expect(all[at + 2]).toEqual({
      name: "Check out notes-co/survey-build",
      uses: "actions/checkout@v5",
      with: {
        repository: "notes-co/survey-build",
        token: "${{ steps.media-sources-token.outputs.token }}",
        path: "media-sources/survey-build",
        submodules: "recursive",
        "persist-credentials": false,
      },
    });
  });

  it("logs in to ghcr.io once with the workflow token, no other secret, when setup asks", async () => {
    // A model job logs in for its box image inside the kit action already; setup adds no second login.
    const model = await steps({ ...MEDIA, setup: ["ghcr"] });
    expect(model.filter((s) => s.name === "Log in to ghcr.io")).toEqual([]);
    const all = await steps(
      { ...MEDIA, setup: ["ghcr"] },
      { model: "none", thinking: undefined, limits: undefined },
    );
    const login = all.filter((s) => s.name === "Log in to ghcr.io");
    expect(login).toEqual([
      {
        name: "Log in to ghcr.io",
        uses: "docker/login-action@v3",
        with: {
          registry: "ghcr.io",
          username: "${{ github.actor }}",
          password: "${{ secrets.GITHUB_TOKEN }}",
        },
      },
    ]);
  });

  it("adds no setup step and no minutes for a media stage without setup or sources", async () => {
    const bare = await steps(MEDIA);
    const set = await steps({ ...MEDIA, setup: ["packages"] });
    expect(JSON.stringify(bare)).not.toMatch(
      /pnpm|playwright|setup-java|create-github-app-token|media-sources/,
    );
    expect(set.length).toBe(bare.length + 2);
  });
});

const CACHE = {
  source: "notes-co/scenarios",
  paths: [".cache/sample-apps/*/jars", ".cache/sample-apps/*/m2"],
  key_files: ["src/checks/core.ts"],
};
const CACHED = {
  ...MEDIA,
  network: "tailnet",
  sources: ["notes-co/scenarios"],
  cache: [CACHE],
};

describe("the media cache in the workflow", () => {
  it("restores after the source checkout, keyed by the job, the runner OS and the key files, with no secret", async () => {
    const all = await steps(CACHED);
    const names = all.map((s) => s.name ?? s.uses);
    const at = names.indexOf(
      "Restore the notes-co/scenarios build cache",
    );
    expect(names[at - 1]).toBe("Check out notes-co/scenarios");
    expect(names[at + 1]).toBe("Join the tailnet");
    const key =
      "media-demo-0-${{ runner.os }}-${{ hashFiles('media-sources/scenarios/src/checks/core.ts') }}";
    expect(all[at]).toEqual({
      name: "Restore the notes-co/scenarios build cache",
      id: "media-cache-0",
      uses: "actions/cache/restore@v5",
      with: {
        path: "media-sources/scenarios/.cache/sample-apps/*/jars\nmedia-sources/scenarios/.cache/sample-apps/*/m2",
        key,
        "restore-keys": `${key}-`,
      },
    });
  });

  it("saves after a successful run only when the paths hold files that differ from what was restored", async () => {
    const all = await steps(CACHED);
    const names = all.map((s) => s.name ?? s.uses);
    const at = names.indexOf(
      "Save the notes-co/scenarios build cache",
    );
    expect(names.slice(at - 2, at)).toEqual([
      KIT_ACTION_STEP,
      "Leave the tailnet",
    ]);
    const hash =
      "hashFiles('media-sources/scenarios/.cache/sample-apps/*/jars/**', 'media-sources/scenarios/.cache/sample-apps/*/m2/**')";
    expect(all[at]).toEqual({
      name: "Save the notes-co/scenarios build cache",
      if: `success() && ${hash} != '' && steps.media-cache-0.outputs.cache-matched-key != format('{0}-{1}', steps.media-cache-0.outputs.cache-primary-key, ${hash})`,
      uses: "actions/cache/save@v5",
      with: {
        path: "media-sources/scenarios/.cache/sample-apps/*/jars\nmedia-sources/scenarios/.cache/sample-apps/*/m2",
        key: `\${{ steps.media-cache-0.outputs.cache-primary-key }}-\${{ ${hash} }}`,
      },
    });
  });

  it("adds no cache step for a stage without a cache", async () => {
    const { cache: _cache, ...without } = CACHED;
    expect(JSON.stringify(await steps(without))).not.toMatch(/actions\/cache/);
  });

});

describe("the media check on the cache", () => {
  async function problems(media: unknown): Promise<string[]> {
    const root = makeRepo({
      jobs: { demo: { ...jobFiles("demo", { media }), "media.ts": MEDIA_TS } },
    });
    return run(mediaCheck, root);
  }

  it("accepts a cache of a listed source", async () => {
    expect(await problems(CACHED)).toEqual([]);
  });

  it("refuses a source the stage does not check out", async () => {
    expect(
      await problems({
        ...CACHED,
        cache: [{ ...CACHE, source: "notes-co/sample-apps" }],
      }),
    ).toEqual([
      "jobs/demo/job.yml: media.cache[0].source: notes-co/sample-apps is not in media.sources; a cache keeps files of a checked out source",
    ]);
  });

  it("refuses a path that leaves the checkout", async () => {
    expect(
      await problems({
        ...CACHED,
        cache: [{ ...CACHE, paths: ["../kit"], key_files: ["./core.ts"] }],
      }),
    ).toEqual([
      "jobs/demo/job.yml: media.cache[0].paths[0]: ../kit must be a plain relative path inside the checkout",
      "jobs/demo/job.yml: media.cache[0].key_files[0]: ./core.ts must be a plain relative path inside the checkout",
    ]);
  });

  it("refuses a cache for a stage split into parts", async () => {
    expect(
      await problems({ ...CACHED, parts: [{ id: "one-part" }] }),
    ).toContain(
      "jobs/demo/job.yml: media.cache: a stage split into parts keeps no cache; each part runs in a workflow job of its own",
    );
  });
});

describe("the media check on setup", () => {
  it("installs Chromium only with the packages", async () => {
    const root = makeRepo({
      jobs: {
        demo: {
          ...jobFiles("demo", { media: { ...MEDIA, setup: ["chromium"] } }),
          "media.ts": MEDIA_TS,
        },
      },
    });
    expect(await run(mediaCheck, root)).toEqual([
      "jobs/demo/job.yml: media.setup: chromium is installed with the locked packages; add packages",
    ]);
  });

  it("needs the packages for a media.ts bundle that imports Playwright", async () => {
    const root = makeRepo({
      jobs: {
        bare: { ...jobFiles("bare", { media: MEDIA }), "media.ts": MEDIA_TS },
        set: {
          ...jobFiles("set", { media: { ...MEDIA, setup: ["packages"] } }),
          "media.ts": MEDIA_TS,
        },
      },
    });
    for (const job of ["bare", "set"]) {
      mkdirSync(join(root, "dist/jobs", job), { recursive: true });
      writeFileSync(
        join(root, "dist/jobs", job, "media.mjs"),
        'import{chromium as a}from"playwright";a.launch();\n',
      );
    }
    expect(await run(mediaCheck, root)).toEqual([
      "jobs/bare/job.yml: media.setup: media.ts imports playwright, which runs from the locked packages; add packages",
    ]);
  });

  it("reads the externals a bundle imports, minified or not", () => {
    expect(bundleExternals('import{chromium}from"playwright";')).toEqual([
      "playwright",
    ]);
    expect(bundleExternals('import { chromium } from "playwright";')).toEqual([
      "playwright",
    ]);
    expect(bundleExternals('import x from "playwright-core";')).toEqual([]);
    expect(bundleExternals("const s = 'playwright';")).toEqual([]);
  });
});

describe("media.ts bundles", () => {
  function tree(): string {
    const root = makeRepo({});
    writeFileSync(join(root, "package.json"), "{}\n");
    symlinkSync(join(KIT_ROOT, "node_modules"), join(root, "node_modules"));
    mkdirSync(join(root, "jobs/demo"), { recursive: true });
    const script =
      'import { chromium } from "playwright";\nconsole.log(typeof chromium);\n';
    writeFileSync(join(root, "jobs/demo/media.ts"), script);
    writeFileSync(join(root, "jobs/demo/collect.ts"), script);
    return root;
  }

  it("leave Playwright to node_modules in a media.ts, and refuse it anywhere else", async () => {
    const root = tree();
    const { text } = await bundleOne(
      root,
      "dist/jobs/demo/media.mjs",
      { file: "jobs/demo/media.ts" },
      MEDIA_EXTERNALS,
    );
    expect(bundleExternals(text)).toEqual(["playwright"]);
    await expect(
      bundleOne(root, "dist/jobs/demo/collect.mjs", {
        file: "jobs/demo/collect.ts",
      }),
    ).rejects.toThrow(/could not resolve|still imports playwright/i);
  }, 60_000);
});

describe("private framework packages", () => {
  it("gives git the packages token right before the install when flax.yml names one, and nothing otherwise", async () => {
    const plain = await steps({ ...MEDIA, setup: ["packages"] });
    expect(plain.map((s) => s.name)).not.toContain(PACKAGES_TOKEN_STEP);

    const flax = parse(FLAX_TEXT);
    flax.agents.packagesTokenSecret = "FLAX_READ_TOKEN";
    const root = makeRepo({
      flax: stringify(flax),
      jobs: {
        demo: {
          ...jobFiles("demo", { media: { ...MEDIA, setup: ["packages"] } }),
          "media.ts": MEDIA_TS,
        },
      },
    });
    const fixture = workspaceRoot();
    setWorkspaceRoot(root);
    let all: Step[];
    try {
      expect(loadWorkspace(root).problems).toEqual([]);
      await generate(loadRepo(root));
      all = parse(
        readFileSync(join(root, ".github/workflows/job-demo.yml"), "utf8"),
      ).jobs.run.steps;
    } finally {
      setWorkspaceRoot(fixture);
    }
    const at = all.findIndex((s) => s.name === PACKAGES_TOKEN_STEP);
    expect(at).toBeGreaterThan(0);
    expect(all[at - 1]!.name).toBe("Set up pnpm");
    expect(all[at]!.env).toEqual({
      PACKAGES_TOKEN: "${{ secrets.FLAX_READ_TOKEN }}",
    });
    expect(all[at]!.run).toBe(PACKAGES_TOKEN_RUN);
    expect(all[at + 1]!.run).toBe("pnpm install --frozen-lockfile");
  });
});

describe("the packages token secret name", () => {
  it("must look like a secret name", () => {
    const flax = parse(FLAX_TEXT);
    flax.agents.packagesTokenSecret = "not a secret";
    const root = makeRepo({ flax: stringify(flax) });
    expect(loadWorkspace(root).problems).toEqual([
      "flax.yml: agents.packagesTokenSecret must be a secret name",
    ]);
  });
});
