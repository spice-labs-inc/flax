import { generateKeyPairSync } from "node:crypto";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { describe, expect, it, onTestFinished } from "vitest";
import { generate } from "../src/generate/generate.ts";
import { createAjv } from "../src/lib/ajv.ts";
import {
  MAINTAINER_NOTES_SCHEMA,
  maintainerNotesProblems,
  notesSchemaProblem,
  plainMarkdown,
  splitMaintainerNotes,
  withMaintainerNotes,
} from "../src/lib/maintainer-notes.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { UPSTREAM_OPERATIONS } from "../src/lib/tools.ts";
import { DATA_FILES } from "../src/run-job/argv.ts";
import { StubLauncher } from "../src/run-job/launcher.ts";
import { PREAMBLE } from "../src/run-job/preamble.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import {
  GithubUpstream,
  MaintainerNotesReader,
  MAX_NOTES_ZIP_BYTES,
  readZipEntry,
} from "../src/tools-server/artifacts.ts";
import { startUpstreams } from "../src/tools-server/start-upstreams.ts";
import { ToolsServer } from "../src/tools-server/server.ts";
import { loadJobTools } from "../src/tools-server/start.ts";
import type { Upstream } from "../src/tools-server/upstreams.ts";
import {
  fakeGitHubApi,
  writeFakeMcpServer,
  zipFiles,
  type FakeArtifacts,
} from "./fake-upstreams.ts";
import { jobFiles, makeRepo } from "./helpers.ts";

const NOW = new Date("2026-09-28T15:00:00Z");
const WHO = { uid: process.getuid!(), home: "/nonexistent-home" };
const NOTES = [
  { kind: "limit_hit", text: "Used all 15 tool calls before the last log." },
  { kind: "missing_tool", text: "No tool reads Flux <Kustomizations>." },
];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-notes-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("maintainer notes in an answer", () => {
  it("come off the answer when they match, and never fail it when they do not", () => {
    expect(
      splitMaintainerNotes({ summary: "hi", maintainer_notes: NOTES }),
    ).toEqual({ answer: { summary: "hi" }, notes: NOTES });
    expect(splitMaintainerNotes({ summary: "hi" })).toEqual({
      answer: { summary: "hi" },
      notes: [],
    });
    expect(
      splitMaintainerNotes({ summary: "hi", maintainer_notes: [] }),
    ).toEqual({ answer: { summary: "hi" }, notes: [] });
    for (const answer of [[1, 2], "text", null, 3])
      expect(splitMaintainerNotes(answer)).toEqual({ answer, notes: [] });

    const bad = [
      [{ kind: "complaint", text: "x" }],
      [{ kind: "limit_hit", text: "x".repeat(301) }],
      [{ kind: "limit_hit", text: "" }],
      [{ kind: "limit_hit", text: "x", extra: 1 }],
      Array.from({ length: 6 }, () => ({ kind: "limit_hit", text: "x" })),
      "a string",
    ];
    for (const notes of bad) {
      const split = splitMaintainerNotes({
        summary: "hi",
        maintainer_notes: notes,
      });
      expect(split.answer).toEqual({ summary: "hi" });
      expect(split.notes).toEqual([]);
      expect(split.warning).toMatch(/^maintainer_notes was dropped: /);
    }
    expect(
      splitMaintainerNotes({
        maintainer_notes: [{ kind: "complaint", text: "x" }],
      }).warning,
    ).toBe(
      "maintainer_notes was dropped: [0].kind: must be one of missing_data, missing_tool, unclear_prompt, limit_hit",
    );
  });

  it("are added to every job's schema as an optional property Pi sees, and taken off before the job's own check", () => {
    // A job that runs no model has no output.json.
    const jobs = readdirSync(join(FIXTURE_WORKSPACE, "jobs")).filter((job) =>
      existsSync(join(FIXTURE_WORKSPACE, "jobs", job, "output.json")),
    );
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      const schema = JSON.parse(
        readFileSync(join(FIXTURE_WORKSPACE, "jobs", job, "output.json"), "utf8"),
      ) as { properties: Record<string, unknown>; required?: string[] };
      expect(notesSchemaProblem(schema), job).toBeUndefined();
      const given = withMaintainerNotes(schema) as typeof schema;
      expect(Object.keys(given.properties)).toEqual([
        ...Object.keys(schema.properties),
        "maintainer_notes",
      ]);
      expect(given.required).toEqual(schema.required);
      const validate = createAjv().compile(given);
      const fixture = JSON.parse(
        readFileSync(
          join(FIXTURE_WORKSPACE, "jobs", job, "fixtures/output.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(validate(fixture), job).toBe(true);
      expect(validate({ ...fixture, maintainer_notes: NOTES }), job).toBe(true);
    }
  });

  it("need an object at the top of output.json, and the key to themselves", () => {
    expect(notesSchemaProblem({ type: "array" })).toBe(
      "must have type: object at the top, so the runner can add maintainer_notes to it",
    );
    expect(
      notesSchemaProblem({
        type: "object",
        properties: { maintainer_notes: { type: "string" } },
      }),
    ).toBe("maintainer_notes is reserved for the runner's maintainer notes");
    expect(notesSchemaProblem({ type: "object" })).toBeUndefined();
  });

  it("are capped by their schema", () => {
    expect(MAINTAINER_NOTES_SCHEMA.maxItems).toBe(5);
    expect(maintainerNotesProblems(NOTES)).toEqual([]);
    expect(maintainerNotesProblems([{ kind: "limit_hit" }])).toEqual([
      "[0].text: is required",
    ]);
  });

  it("are explained in the preamble", () => {
    expect(PREAMBLE).toContain(
      "The schema has an optional `maintainer_notes` list for the people who maintain this job",
    );
    expect(PREAMBLE).toContain(
      "It stays in the run's report and is never delivered.",
    );
  });
});

describe("plainMarkdown", () => {
  it("keeps model text to one line with every Markdown and HTML character escaped", () => {
    expect(
      plainMarkdown("See [this](https://x.test) <img src=x>\n# now *please*"),
    ).toBe(
      "See \\[this\\]\\(https\\://x\\.test\\) \\<img src\\=x\\> \\# now \\*please\\*",
    );
  });

  it("never lets a line break or an unescaped special character through", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (text) => {
        const out = plainMarkdown(text);
        expect(out).not.toMatch(/[\n\r\u2028\u2029]/);
        const unescaped = out.replace(/\\./g, "");
        expect(unescaped).not.toMatch(/[\\`*_[\]()<>|!&]/);
      }),
    );
  });
});

describe("readZipEntry", () => {
  const notes = JSON.stringify({ notes: NOTES });

  it("reads one file from a stored or deflated archive", () => {
    for (const method of [0, 8] as const) {
      const zip = zipFiles(
        { "other.txt": "x", "maintainer-notes.json": notes },
        method,
      );
      expect(
        readZipEntry(zip, "maintainer-notes.json", 65536)?.toString(),
      ).toBe(notes);
      expect(readZipEntry(zip, "missing.json", 65536)).toBeUndefined();
    }
  });

  it("round-trips any content under the cap", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 4096 }),
        fc.constantFrom(0 as const, 8 as const),
        (bytes, method) => {
          const zip = zipFiles({ "f.bin": Buffer.from(bytes) }, method);
          expect(
            readZipEntry(zip, "f.bin", 4096)!.equals(Buffer.from(bytes)),
          ).toBe(true);
        },
      ),
    );
  });

  it("refuses what is not a readable archive, and anything over the cap", () => {
    expect(() =>
      readZipEntry(Buffer.from("not a zip at all, no"), "a", 10),
    ).toThrow(
      "the artifact is not a zip archive this reader takes: no end of central directory",
    );
    const zip = zipFiles({ "a.json": "x".repeat(1000) });
    expect(() => readZipEntry(zip, "a.json", 100)).toThrow(
      "a.json is 1000 bytes, over the 100 byte limit",
    );
    // A size that lies: the directory says 10 bytes, the data inflates to 1000.
    const lying = Buffer.from(zip);
    const central = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    lying.writeUInt32LE(10, central + 24);
    expect(() => readZipEntry(lying, "a.json", 100)).toThrow(
      /a\.json does not inflate/,
    );
    const corrupt = zipFiles({ "a.json": "hello" }, 0);
    corrupt[30 + "a.json".length] = "j".charCodeAt(0);
    expect(() => readZipEntry(corrupt, "a.json", 100)).toThrow(
      "a.json does not match its size and checksum",
    );
    const encrypted = Buffer.from(zipFiles({ "a.json": "x" }, 0));
    const at = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    encrypted.writeUInt16LE(1, at + 8);
    expect(() => readZipEntry(encrypted, "a.json", 100)).toThrow(
      "the file is encrypted",
    );
  });
});

function artifact(
  id: number,
  createdAt: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: "job-hello-maintainer-notes",
    expired: false,
    size_in_bytes: 400,
    created_at: createdAt,
    workflow_run: { id: 1000 + id, head_branch: "main" },
    ...extra,
  };
}

const notesZip = (notes: unknown) =>
  zipFiles({
    "maintainer-notes.json": JSON.stringify({
      job: "hello",
      runName: "job-hello-1",
      model: "m",
      notes,
    }),
  });

const ARTIFACTS: FakeArtifacts = {
  list: [
    artifact(1, "2026-09-27T10:00:00Z"),
    artifact(2, "2026-09-28T10:00:00Z"),
    artifact(3, "2026-09-26T10:00:00Z"),
    artifact(4, "2026-09-25T10:00:00Z"),
    artifact(5, "2026-09-10T10:00:00Z"),
    artifact(6, "2026-09-27T11:00:00Z", { expired: true }),
    artifact(7, "2026-09-27T12:00:00Z", { name: "job-other-maintainer-notes" }),
  ],
  zips: {
    1: notesZip(NOTES),
    2: notesZip([]),
    3: notesZip([{ kind: "complaint", text: "x" }]),
    4: zipFiles({ "other.json": "{}" }),
  },
};

describe("maintainer_notes_list", () => {
  it("reads a job's notes of the last days, newest first, from the artifacts' downloads, without the token", async () => {
    const api = await fakeGitHubApi({ artifacts: ARTIFACTS });
    const reader = new MaintainerNotesReader({
      token: "ghs_runtoken0000000000000000000000000000",
      apiUrl: api.url,
      downloadHosts: ["127.0.0.1"],
      allowHttp: true,
      now: () => NOW,
    });
    const out = JSON.parse(
      await reader.list(
        {
          owner: "notes-co",
          repo: "agents",
          job: "hello",
          days: 7,
        },
        AbortSignal.timeout(5000),
      ),
    );
    expect(out).toEqual({
      job: "hello",
      since: "2026-09-21T15:00:00.000Z",
      runs: [
        {
          run_id: 1002,
          branch: "main",
          created_at: "2026-09-28T10:00:00Z",
          notes: [],
        },
        {
          run_id: 1001,
          branch: "main",
          created_at: "2026-09-27T10:00:00Z",
          notes: NOTES,
        },
      ],
      skipped: [
        {
          run_id: 1003,
          reason: "maintainer-notes.json does not hold valid notes",
        },
        { run_id: 1004, reason: "the artifact has no maintainer-notes.json" },
      ],
      left_out: 0,
    });
    expect(api.requests[0]!.path).toBe(
      "/repos/notes-co/agents/actions/artifacts?name=job-hello-maintainer-notes&per_page=100",
    );
    const blobs = api.requests.filter((r) => r.path.startsWith("/blob/"));
    expect(blobs.map((r) => r.path.split("?")[0])).toEqual([
      "/blob/2",
      "/blob/1",
      "/blob/3",
      "/blob/4",
    ]);
    for (const r of blobs) expect(r.authorization).toBe("undefined");
    for (const r of api.requests.filter((r) => r.path.startsWith("/repos/")))
      expect(r.authorization).toBe(
        "Bearer ghs_runtoken0000000000000000000000000000",
      );
  });

  it("downloads only from the listed hosts over https, and only small archives", async () => {
    const api = await fakeGitHubApi({ artifacts: ARTIFACTS });
    const args = {
      owner: "notes-co",
      repo: "agents",
      job: "hello",
      days: 2,
    };
    const unlisted = new MaintainerNotesReader({
      token: "t",
      apiUrl: api.url,
      downloadHosts: ["productionresultssa0.blob.core.windows.net"],
      allowHttp: true,
      now: () => NOW,
    });
    expect(
      JSON.parse(await unlisted.list(args, AbortSignal.timeout(5000))).skipped,
    ).toEqual([
      {
        run_id: 1002,
        reason:
          "GitHub sent the download to http://127.0.0.1, which is not a host in github-log-hosts.yml",
      },
      {
        run_id: 1001,
        reason:
          "GitHub sent the download to http://127.0.0.1, which is not a host in github-log-hosts.yml",
      },
    ]);
    const plain = new MaintainerNotesReader({
      token: "t",
      apiUrl: api.url,
      downloadHosts: ["127.0.0.1"],
      now: () => NOW,
    });
    expect(
      JSON.parse(await plain.list(args, AbortSignal.timeout(5000))).runs,
    ).toEqual([]);
    expect(api.requests.some((r) => r.path.startsWith("/blob/"))).toBe(false);

    const big = await fakeGitHubApi({
      artifacts: {
        list: [
          artifact(1, "2026-09-28T10:00:00Z", {
            size_in_bytes: MAX_NOTES_ZIP_BYTES + 1,
          }),
        ],
        zips: {},
      },
    });
    const reader = new MaintainerNotesReader({
      token: "t",
      apiUrl: big.url,
      downloadHosts: ["127.0.0.1"],
      allowHttp: true,
      now: () => NOW,
    });
    expect(
      JSON.parse(await reader.list(args, AbortSignal.timeout(5000))).skipped,
    ).toEqual([
      {
        run_id: 1001,
        reason: "the artifact is 262145 bytes, over the 262144 byte limit",
      },
    ]);
  });

  it("refuses other repositories, bad names and ranges, and names only the status of a failed list", async () => {
    const mcpCalls: string[] = [];
    const mcp: Upstream = {
      call: (operation) => {
        mcpCalls.push(operation);
        return Promise.resolve("from github-mcp-server");
      },
    };
    const reader = new MaintainerNotesReader({
      token: "t",
      apiUrl: "http://127.0.0.1:9",
      downloadHosts: [],
      fetch: () =>
        Promise.resolve(new Response('{"echo":"secret"}', { status: 403 })),
      now: () => NOW,
    });
    const github = new GithubUpstream(mcp, reader);
    const signal = AbortSignal.timeout(5000);
    const base = {
      owner: "notes-co",
      repo: "agents",
      job: "hello",
      days: 7,
    };
    await expect(
      github.call("maintainer_notes_list", { ...base, repo: "engine" }, signal),
    ).rejects.toThrow("maintainer notes are read from agents only");
    await expect(
      github.call("maintainer_notes_list", { ...base, owner: "other" }, signal),
    ).rejects.toThrow("only notes-co repositories may be read");
    await expect(
      github.call("maintainer_notes_list", { ...base, job: "../x" }, signal),
    ).rejects.toThrow('"../x" is not a job name');
    await expect(
      github.call("maintainer_notes_list", { ...base, days: 15 }, signal),
    ).rejects.toThrow("days must be a whole number from 1 to 14");
    await expect(
      github.call("maintainer_notes_list", { ...base, per_page: 1 }, signal),
    ).rejects.toThrow("maintainer_notes_list takes no per_page");
    await expect(
      github.call("maintainer_notes_list", base, signal),
    ).rejects.toThrow(/^listing the artifacts returned 403$/);
    expect(await github.call("actions_list", {}, signal)).toBe(
      "from github-mcp-server",
    );
    expect(mcpCalls).toEqual(["actions_list"]);
  });

  it("is served by the tools server itself in a run, next to github-mcp-server, with the run's token scrubbed", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const api = await fakeGitHubApi({ artifacts: ARTIFACTS });
    const fake = writeFakeMcpServer(tempDir(), {
      tools: UPSTREAM_OPERATIONS.github!.filter(
        (op) => op !== "maintainer_notes_list",
      ),
    });
    const running = await startUpstreams({
      servers: ["github"],
      env: { AGENTS_READER_APP_ID: "1", AGENTS_READER_PRIVATE_KEY: privateKey },
      workDir: join(tempDir(), "work"),
      binDir: "/nonexistent",
      readChannels: [],
      githubApiUrl: api.url,
      githubDownloadHosts: ["127.0.0.1"],
      githubDownloadHttp: true,
      commands: {
        "github-mcp-server": { command: fake.command, args: fake.args },
      },
      now: () => NOW,
    });
    onTestFinished(() => running.close());
    const server = new ToolsServer({
      tools: await loadJobTools(FIXTURE_WORKSPACE, ["gh-maintainer-notes"]),
      limits: { calls: 10, seconds: 10 },
      upstreams: running.upstreams,
      readChannels: [],
      scrub: running.scrub,
      now: () => NOW,
    });
    const result = await server.call("gh-maintainer-notes", { job: "hello" });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('"run_id":1001');
    expect(text).toContain("No tool reads Flux <Kustomizations>.");
    expect(fake.records().filter((r) => r.type === "call")).toEqual([]);
  });
});

describe("a run keeps the maintainer notes and delivers them nowhere", () => {
  async function notesRun(
    answer: unknown,
    files: Record<string, string> = {},
  ): Promise<{
    ok: boolean;
    out: string;
    data: string;
    logs: string[];
  }> {
    const root = makeRepo({
      jobs: { demo: { ...jobFiles("demo"), ...files } },
      files: { "package.json": JSON.stringify({ type: "module" }) },
    });
    await generate(loadRepo(root));
    const dir = tempDir();
    const launcher = new StubLauncher(JSON.stringify(answer));
    const logs: string[] = [];
    const options: RunOptions = {
      root,
      name: "demo",
      stub: true,
      scratch: dir,
      out: join(dir, "report"),
      env: {},
      identity: WHO,
      log: (line) => logs.push(line),
      launcher,
    };
    const result = await runJob(options);
    return {
      ok: result.ok,
      out: options.out!,
      data: dirname(launcher.requests[0]!.answerPath),
      logs,
    };
  }

  const read = (dir: string, file: string) =>
    readFileSync(join(dir, file), "utf8");

  it("gives Pi the schema with the notes, keeps them in the report and the summary, and takes them off the answer", async () => {
    const run = await notesRun({ summary: "hi", maintainer_notes: NOTES });
    expect(run.ok).toBe(true);
    const schema = JSON.parse(read(run.data, DATA_FILES.schema));
    expect(schema.properties.maintainer_notes).toEqual(MAINTAINER_NOTES_SCHEMA);
    expect(schema.required).toEqual(["summary"]);
    expect(JSON.parse(read(run.out, "answer.json"))).toEqual({
      summary: "hi",
    });
    expect(JSON.parse(read(run.out, "maintainer-notes.json"))).toMatchObject({
      job: "demo",
      notes: NOTES,
    });
    const status = JSON.parse(read(run.out, "status.json"));
    expect(status.maintainerNotes).toEqual({ count: 2 });
    const summary = read(run.out, "summary.md");
    expect(summary).toContain(
      "| Maintainer notes | 2 in maintainer-notes.json |",
    );
    expect(summary).toContain(
      "#### Maintainer notes\n\n- `limit_hit` Used all 15 tool calls before the last log\\.\n- `missing_tool` No tool reads Flux \\<Kustomizations\\>\\.",
    );
  });

  it("drops malformed notes with a warning and still accepts the answer", async () => {
    const run = await notesRun({
      summary: "hi",
      maintainer_notes: [{ kind: "limit_hit", text: "x".repeat(400) }],
    });
    expect(run.ok).toBe(true);
    const warning =
      "maintainer_notes was dropped: [0].text: must NOT have more than 300 characters";
    expect(run.logs).toContain(`warning: ${warning}`);
    expect(JSON.parse(read(run.out, "status.json")).maintainerNotes).toEqual({
      count: 0,
      warning,
    });
    expect(JSON.parse(read(run.out, "maintainer-notes.json")).notes).toEqual(
      [],
    );
    expect(read(run.out, "summary.md")).toContain(
      "| Maintainer notes | dropped, malformed |",
    );
  });

  it("keeps the notes when the answer itself fails its check", async () => {
    const run = await notesRun({ wrong: 1, maintainer_notes: NOTES });
    expect(run.ok).toBe(false);
    expect(JSON.parse(read(run.out, "maintainer-notes.json")).notes).toEqual(
      NOTES,
    );
  });

  it("never hands the notes to render.ts", async () => {
    const render = `const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const keys = Object.keys(JSON.parse(Buffer.concat(chunks).toString("utf8")));
console.log(JSON.stringify({ text: keys.join(","), blocks: [{ type: "section", text: { type: "mrkdwn", text: keys.join(",") } }] }));
`;
    const run = await notesRun(
      { summary: "hi", maintainer_notes: NOTES },
      { "render.ts": render },
    );
    expect(run.ok).toBe(true);
    const slack = read(run.out, "slack.json");
    expect(JSON.parse(slack).text).toBe("summary");
    expect(slack).not.toContain("Kustomizations");
  });
});
