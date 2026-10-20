import { describe, expect, it } from "vitest";
import { allowlistsCheck } from "../src/check/allowlists.ts";
import { modelFamily, offeredThinkingLevels } from "../src/lib/allowlists.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../src/lib/job.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { CHANNEL, jobFiles, makeRepo, REPO, run, TOOL } from "./helpers.ts";

const FILE = "jobs/demo/job.yml";

function repoWith(
  overrides: Record<string, unknown>,
  extra: Parameters<typeof makeRepo>[0] = {},
): string {
  return makeRepo({ ...extra, jobs: { demo: jobFiles("demo", overrides) } });
}

describe("allowlists", () => {
  it("accepts listed models, tools, channels and repositories", async () => {
    const root = makeRepo({
      jobs: {
        poster: jobFiles("poster", {
          tools: [TOOL],
          output: { kind: "slack", channel: CHANNEL },
        }),
        fixer: jobFiles("fixer", {
          output: {
            kind: "pr",
            repos: [REPO],
            paths: ["docs/**"],
            max_changed_lines: 10,
            untrusted_input: "report_only",
          },
        }),
      },
    });
    expect(await run(allowlistsCheck, root)).toEqual([]);
  });

  it("accepts a job that lists tools, with no warning", async () => {
    const root = makeRepo({
      jobs: {
        with: jobFiles("with", { tools: [TOOL] }),
        without: jobFiles("without"),
      },
    });
    expect(await allowlistsCheck.run(loadRepo(root))).toEqual([]);
  });

  it("rejects a model missing from models.yml", async () => {
    expect(
      await run(allowlistsCheck, repoWith({ model: "acme/other" })),
    ).toEqual([`${FILE}: model: "acme/other" is not listed in models.yml`]);
  });

  it("holds the thinking level to the model's thinking list, and allows any level without one", async () => {
    const model = (thinking?: string[]) => ({
      id: "acme/test-model",
      provider: "acme",
      usd_per_million_input: 1,
      usd_per_million_output: 2,
      ...(thinking === undefined ? {} : { thinking }),
    });
    expect(
      await run(
        allowlistsCheck,
        repoWith({ thinking: "high" }, { models: [model(["off", "low"])] }),
      ),
    ).toEqual([
      `${FILE}: thinking: "high" is not a thinking level acme/test-model takes; models.yml lists off, low`,
    ]);
    expect(
      await run(
        allowlistsCheck,
        repoWith({ thinking: "low" }, { models: [model(["off", "low"])] }),
      ),
    ).toEqual([]);
    expect(
      await run(
        allowlistsCheck,
        repoWith({ thinking: "max" }, { models: [model()] }),
      ),
    ).toEqual([]);
  });

  it("refuses a thinking list in models.yml that is empty, repeats a level or names one Pi does not take", async () => {
    const models = [
      ["acme/a", []],
      ["acme/b", ["high", "high"]],
      ["acme/c", ["none"]],
    ].map(([id, thinking]) => ({
      id,
      provider: "acme",
      usd_per_million_input: 1,
      usd_per_million_output: 2,
      thinking,
    }));
    const problems = await run(allowlistsCheck, repoWith({}, { models }));
    expect(problems).toEqual([
      "models.yml: [0].thinking: must NOT have fewer than 1 items",
      "models.yml: [1].thinking: must NOT have duplicate items (items ## 0 and 1 are identical)",
      "models.yml: [2].thinking[0]: must be one of off, minimal, low, medium, high, xhigh, max",
      `${FILE}: model: "acme/test-model" is not listed in models.yml`,
    ]);
  });

  it("offers a run started by hand the levels any usable model takes, lowest first", () => {
    const m = (thinking?: ThinkingLevel[]) => ({
      id: "acme/x",
      provider: "acme",
      usd_per_million_input: 1,
      usd_per_million_output: 1,
      ...(thinking === undefined ? {} : { thinking }),
    });
    expect(
      offeredThinkingLevels([m(["xhigh", "high"]), m(["off", "low"])]),
    ).toEqual(["off", "low", "high", "xhigh"]);
    expect(offeredThinkingLevels([m(["low"]), m()])).toEqual([
      ...THINKING_LEVELS,
    ]);
    expect(offeredThinkingLevels([])).toEqual([]);
  });

  it("rejects a tool with no directory under tools/", async () => {
    expect(
      await run(allowlistsCheck, repoWith({ tools: [TOOL, "shell"] })),
    ).toEqual([`${FILE}: tools[1]: "shell" has no directory tools/shell/`]);
  });

  it("rejects a Slack channel missing from channels.yml", async () => {
    expect(
      await run(
        allowlistsCheck,
        repoWith({ output: { kind: "slack", channel: "general" } }),
      ),
    ).toEqual([
      `${FILE}: output.channel: "general" is not listed in channels.yml`,
    ]);
  });

  it("rejects a pull request repository missing from repos.yml", async () => {
    const output = {
      kind: "pr",
      repos: [REPO, "notes-co/prod"],
      paths: ["**"],
      max_changed_lines: 1,
      untrusted_input: "report_only",
    };
    expect(await run(allowlistsCheck, repoWith({ output }))).toEqual([
      `${FILE}: output.repos[1]: "notes-co/prod" is not listed in repos.yml`,
    ]);
  });

  it("rejects a key the job's code stamps that the model may also change", async () => {
    const output = {
      kind: "pr",
      repos: [REPO],
      paths: ["**"],
      max_changed_lines: 1,
      untrusted_input: "report_only",
      frontmatter_keys: ["depends_on", "analyzed_commit"],
      stamp_keys: ["analyzed_commit"],
    };
    expect(await run(allowlistsCheck, repoWith({ output }))).toEqual([
      `${FILE}: output.stamp_keys[0]: "analyzed_commit" is also in frontmatter_keys; a key the job's code stamps is never the model's to change`,
    ]);
  });

  it("validates the allowlist files themselves", async () => {
    const root = repoWith(
      {},
      {
        models: [{ id: "acme/test-model", provider: "acme" }],
        channels: {
          post: [{ name: "#general" }],
          read: [
            { id: "C0123456789", name: "alerts-a" },
            { id: "general", name: "alerts-b" },
          ],
        },
        repos: "nope",
      },
    );
    expect(await run(allowlistsCheck, root)).toEqual([
      "models.yml: [0].usd_per_million_input: is required",
      "models.yml: [0].usd_per_million_output: is required",
      'channels.yml: post[0].name: "#general" must match ^[a-z0-9][a-z0-9_-]{0,79}$',
      'channels.yml: read[1].id: "general" must match ^C[A-Z0-9]{8,12}$',
      "repos.yml: must be array",
      `${FILE}: model: "acme/test-model" is not listed in models.yml`,
    ]);
  });

  it("loads a repository's preview from repos.yml, keeps plain entries, and refuses a repository listed twice", async () => {
    const preview = {
      commands: ["pnpm install", "pnpm dev"],
      url: "http://localhost:4321",
      pages: { dir: "src/content/docs", prefix: "/docs/" },
      docs: "https://github.com/notes-co/public-docs#development",
    };
    const root = makeRepo({
      repos: [REPO, { repo: "notes-co/public-docs", preview }],
    });
    expect(await run(allowlistsCheck, root)).toEqual([]);
    const { allowlists } = loadRepo(root);
    expect(allowlists.repos).toEqual([REPO, "notes-co/public-docs"]);
    expect(allowlists.repoPreviews).toEqual({
      "notes-co/public-docs": preview,
    });
    expect(
      await run(allowlistsCheck, makeRepo({ repos: [REPO, { repo: REPO }] })),
    ).toContain(`repos.yml: [1]: "${REPO}" is listed twice`);
    const bad = await run(
      allowlistsCheck,
      makeRepo({
        repos: [
          { repo: REPO, preview: { ...preview, url: "https://evil.example" } },
        ],
      }),
    );
    expect(bad.some((p) => p.startsWith("repos.yml:"))).toBe(true);
  });

  it("loads the channels tools may read, and refuses a repeated id or name", async () => {
    const read = [
      { id: "C0123456789", name: "alerts-a" },
      { id: "C0123456780", name: "alerts-b" },
    ];
    expect(
      loadRepo(makeRepo({ channels: { post: [{ name: CHANNEL }], read } }))
        .allowlists.readChannels,
    ).toEqual(read);
    const root = repoWith(
      {},
      {
        channels: {
          post: [],
          read: [...read, { id: "C0123456789", name: "alerts-b" }],
        },
      },
    );
    expect(await run(allowlistsCheck, root)).toEqual([
      'channels.yml: read[2].id: duplicate channel id "C0123456789"',
      'channels.yml: read[2].name: duplicate channel name "alerts-b"',
    ]);
  });

  it("loads the channels jobs may post to and the link prefixes, and refuses a bad prefix or a repeated channel", async () => {
    const post = [
      { id: "C0POST00001", name: "agents-shadow" },
      { name: "system-health" },
    ];
    const links = [
      "https://github.com/notes-co/",
      "https://logs.example.systems/",
    ];
    const loaded = loadRepo(
      makeRepo({ channels: { post, read: [], links } }),
    ).allowlists;
    expect(loaded.postChannels).toEqual(post);
    expect(loaded.channels).toEqual(["agents-shadow", "system-health"]);
    expect(loaded.links).toEqual(links);
    expect(
      loadRepo(makeRepo({ channels: { post, read: [] } })).allowlists.links,
    ).toEqual([]);
    const root = repoWith(
      {},
      {
        channels: {
          post: [...post, { id: "C0POST00001", name: "agents-other" }],
          read: [],
          links: [
            "http://github.com/notes-co/",
            "https://github.com/notes-co",
            "https://github.com.evil.example",
          ],
        },
      },
    );
    expect(await run(allowlistsCheck, root)).toEqual([
      'channels.yml: links[0]: "http://github.com/notes-co/" must match ^https://[a-z0-9-]+(\\.[a-z0-9-]+)+/([A-Za-z0-9._~%-]+/)*$',
      'channels.yml: links[1]: "https://github.com/notes-co" must match ^https://[a-z0-9-]+(\\.[a-z0-9-]+)+/([A-Za-z0-9._~%-]+/)*$',
      'channels.yml: links[2]: "https://github.com.evil.example" must match ^https://[a-z0-9-]+(\\.[a-z0-9-]+)+/([A-Za-z0-9._~%-]+/)*$',
    ]);
    const repeated = repoWith(
      {},
      {
        channels: {
          post: [...post, { id: "C0POST00001", name: "agents-other" }],
          read: [],
        },
      },
    );
    expect(await run(allowlistsCheck, repeated)).toEqual([
      'channels.yml: post[2].id: duplicate channel id "C0POST00001"',
    ]);
  });
});

describe("a model's family", () => {
  it("is the first word of its name, past the provider and a acme- prefix", () => {
    expect(
      [
        "anthropic/claude-sonnet-5-5",
        "acme/acme-glm-5.3",
        "acme/acme-glm-5.3-flash",
        "acme/acme-deepseek-v4.1-flash",
        "claude-opus-5-5",
      ].map(modelFamily),
    ).toEqual(["claude", "glm", "glm", "deepseek", "claude"]);
  });
});
