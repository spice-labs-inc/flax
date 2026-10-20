import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { generate } from "../src/generate/generate.ts";
import { mediaHash, sha256Hex } from "../src/lib/media.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { LbxLauncher } from "../src/run-job/launcher.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import { TEST_ISSUER_KEY, testGateway } from "./fake-gateway.ts";
import { writeFakeLbx } from "./fake-lbx.ts";
import { jobFiles, makeRepo, type RepoSpec } from "./helpers.ts";

const ISSUER_ENV = { LLM_GATEWAY_ISSUER_KEY: TEST_ISSUER_KEY };
// Built at runtime so no key-shaped literal sits in the source.
const ELEVENLABS = ["eleven", "test", "value", "7c6b5a"].join("-");
const MAILBOX_PASSWORD = ["mailbox", "test", "value", "3e2d1c"].join("-");
const WHO = { uid: process.getuid!(), home: "/nonexistent-home" };

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-run-media-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MEDIA_LIB = JSON.stringify(join(KIT_ROOT, "src/lib/media.ts"));
const RUN_MAIN = JSON.stringify(join(KIT_ROOT, "src/collect/tools.ts"));

/** Writes a video, its captions and a frame, then the manifest, and notes what it was given in the manifest's data. */
const MEDIA_TS = `import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMain } from ${RUN_MAIN};
import { mediaHash, sha256Hex } from ${MEDIA_LIB};

async function main() {
  const dir = process.env.FLAX_AGENTS_MEDIA_DIR;
  const files = [];
  const put = (path, type, data) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), data);
    files.push({ path, sha256: sha256Hex(data), bytes: Buffer.byteLength(data), type });
  };
  put("video.mp4", "video/mp4", "not really a video");
  put("captions.vtt", "text/vtt", "WEBVTT\\n");
  put("frames/0001.png", "image/x-frame", "a frame");
  const names = ["ELEVENLABS_API_KEY", "LIVETESTS_MAILBOX_APP_PASSWORD", "LLM_GATEWAY_ISSUER_KEY", "UNRELATED"];
  writeFileSync(join(dir, "media.json"), JSON.stringify({
    version: 1,
    files,
    hash: mediaHash(files),
    data: {
      scenes: ["intro", "projects"],
      given: names.filter((n) => process.env[n] !== undefined),
      keyLength: (process.env.ELEVENLABS_API_KEY ?? "").length,
      mode: (statSync(dir).mode & 0o777).toString(8),
    },
  }));
}
await runMain(import.meta.url, "demo", main);
`;

/** Reads the manifest the runner names and passes the data on, with the names of any secret it can see. */
const COLLECT_TS = `import { readFileSync } from "node:fs";
const path = process.env.FLAX_AGENTS_MEDIA_MANIFEST;
const manifest = JSON.parse(readFileSync(path, "utf8"));
console.log(JSON.stringify({
  manifest: path,
  media: manifest.data,
  files: manifest.files.map((f) => f.path),
  secrets: ["ELEVENLABS_API_KEY", "LIVETESTS_MAILBOX_APP_PASSWORD"].filter((n) => process.env[n] !== undefined),
}));
`;

const MEDIA = {
  network: "tailnet",
  secrets: ["ELEVENLABS_API_KEY"],
  timeout_minutes: 5,
};

function mediaJob(
  files: Record<string, string> = {},
): NonNullable<RepoSpec["jobs"]> {
  return {
    demo: {
      ...jobFiles("demo", { media: MEDIA }),
      "media.ts": MEDIA_TS,
      "collect.ts": COLLECT_TS,
      ...files,
    },
  };
}

async function repo(jobs: NonNullable<RepoSpec["jobs"]>): Promise<string> {
  const root = makeRepo({
    jobs,
    files: { "package.json": JSON.stringify({ type: "module" }) },
  });
  await generate(loadRepo(root));
  return root;
}

async function options(
  root: string,
  extra: Partial<RunOptions> = {},
): Promise<RunOptions> {
  const dir = scratch();
  const gw = await testGateway();
  return {
    root,
    name: "demo",
    scratch: dir,
    out: join(dir, "report"),
    env: {
      ...ISSUER_ENV,
      PATH: process.env.PATH ?? "",
      ELEVENLABS_API_KEY: ELEVENLABS,
      LIVETESTS_MAILBOX_APP_PASSWORD: MAILBOX_PASSWORD,
      UNRELATED: "not for media.ts",
      FAKE_LBX_ANSWER: JSON.stringify({ summary: "fine" }),
    },
    identity: WHO,
    log: () => {},
    launcher: new LbxLauncher(new PassThrough(), new PassThrough()),
    gateway: gw.gateway,
    socketBases: [scratch()],
    ...extra,
  };
}

function reportFiles(dir: string, rel = ""): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory())
      for (const [k, v] of reportFiles(dir, path)) files.set(k, v);
    else files.set(path, readFileSync(join(dir, path), "utf8"));
  }
  return files;
}

describe("a job with media", () => {
  it("runs media.ts with only its secrets, hands collect.ts the checked manifest, and keeps the media in the report", async () => {
    const root = await repo(mediaJob());
    const bin = scratch();
    const opts = await options(root, { lbx: writeFakeLbx(bin) });
    const result = await runJob(opts);
    expect(result.messages[0]).toBe("demo: answer accepted.");

    const files = reportFiles(opts.out!);
    const input = JSON.parse(files.get("input.json")!);
    expect(input.media).toEqual({
      scenes: ["intro", "projects"],
      given: ["ELEVENLABS_API_KEY"],
      keyLength: ELEVENLABS.length,
      mode: "700",
    });
    expect(input.files).toEqual([
      "video.mp4",
      "captions.vtt",
      "frames/0001.png",
    ]);
    expect(input.secrets).toEqual([]);

    // The media directory is in the run directory, beside the data directory, never in it.
    const seen = JSON.parse(readFileSync(join(bin, "seen.json"), "utf8"));
    const data = seen.argv[seen.argv.indexOf("--data") + 1];
    expect(relative(dirname(data), input.manifest)).toBe("media/media.json");
    expect(seen.dataFiles).not.toContain("media");
    for (const name of [
      "ELEVENLABS_API_KEY",
      "LIVETESTS_MAILBOX_APP_PASSWORD",
      "FLAX_AGENTS_MEDIA_DIR",
      "FLAX_AGENTS_MEDIA_MANIFEST",
    ])
      expect(seen.envNames).not.toContain(name);

    expect(JSON.parse(files.get("media/media.json")!).data.scenes).toEqual([
      "intro",
      "projects",
    ]);
    expect(files.get("media/video.mp4")).toBe("not really a video");
    expect(files.get("media/captions.vtt")).toBe("WEBVTT\n");
    expect(files.has("media/frames/0001.png")).toBe(false);

    const status = JSON.parse(files.get("status.json")!);
    const listed = [
      ["video.mp4", "not really a video"],
      ["captions.vtt", "WEBVTT\n"],
      ["frames/0001.png", "a frame"],
    ].map(([path, text]) => ({ path: path!, sha256: sha256Hex(text!) }));
    expect(status.media).toEqual({
      source: "media.ts",
      network: "tailnet",
      files: 3,
      bytes: 32,
      hash: mediaHash(listed),
      kept: ["video.mp4", "captions.vtt"],
      notKept: [
        {
          path: "frames/0001.png",
          reason: "image/x-frame is not a type a report keeps",
        },
      ],
    });
    const steps = JSON.parse(files.get("timings.json")!);
    const order = steps.map((t: { step: string }) => t.step);
    expect(order.indexOf("media")).toBeLessThan(order.indexOf("input"));
    expect(files.get("summary.md")).toContain(
      "| Media | 3 files, 0.0 MB, from media.ts; 2 kept in media/ |",
    );
    for (const [file, text] of files) {
      expect(text.includes(ELEVENLABS), file).toBe(false);
      expect(text.includes(MAILBOX_PASSWORD), file).toBe(false);
    }
  });

  it("fails with media.ts's error, before collect.ts and the box", async () => {
    const root = await repo(
      mediaJob({
        "media.ts": `throw new Error("the fixture org could not be created");\n`,
      }),
    );
    const bin = scratch();
    const opts = await options(root, { lbx: writeFakeLbx(bin) });
    const result = await runJob(opts);
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      "demo: jobs/demo/media.ts failed (exit 1): Error: the fixture org could not be created",
    );
    expect(existsSync(join(bin, "seen.json"))).toBe(false);
    const files = reportFiles(opts.out!);
    expect(files.has("input.json")).toBe(false);
    expect(JSON.parse(files.get("status.json")!).media).toMatchObject({
      source: "media.ts",
      files: 0,
    });
  });

  it("refuses media whose files do not match the manifest", async () => {
    const root = await repo(
      mediaJob({
        "media.ts": MEDIA_TS.replace(
          'writeFileSync(join(dir, "media.json")',
          'writeFileSync(join(dir, "video.mp4"), "swapped");\n  writeFileSync(join(dir, "media.json")',
        ),
      }),
    );
    const result = await runJob(
      await options(root, { lbx: writeFakeLbx(scratch()) }),
    );
    expect(result.messages[0]).toBe(
      "demo: the media of jobs/demo/media.ts were refused: video.mp4 is 7 bytes, but media.json says 18",
    );
  });

  it("refuses a real run without the secrets media.ts needs", async () => {
    const root = await repo(mediaJob());
    const opts = await options(root);
    const result = await runJob({
      ...opts,
      env: { ...ISSUER_ENV, PATH: process.env.PATH ?? "" },
    });
    expect(result.messages).toEqual([
      "ELEVENLABS_API_KEY is not set; the job's media.ts needs it",
    ]);
  });

  it("takes the media fixture in a stub run, and runs no media.ts", async () => {
    const poster = "a poster";
    const listed = [
      {
        path: "poster.png",
        sha256: sha256Hex(poster),
        bytes: 8,
        type: "image/png",
      },
    ];
    const root = await repo(
      mediaJob({
        "media.ts": `throw new Error("a stub run must not run media.ts");\n`,
        "fixtures/media.json": JSON.stringify({
          version: 1,
          files: listed,
          hash: mediaHash(listed),
        }),
        "fixtures/media/poster.png": poster,
      }),
    );
    const opts = await options(root, { stub: true });
    delete opts.launcher;
    const result = await runJob({ ...opts, env: { PATH: "/nonexistent" } });
    expect(result.messages[0]).toBe("demo: answer accepted.");
    const files = reportFiles(opts.out!);
    expect(JSON.parse(files.get("status.json")!).media).toMatchObject({
      source: "fixture",
      files: 1,
      kept: ["poster.png"],
    });
    expect(files.get("media/poster.png")).toBe(poster);
  });

  it("has no media in a stub run without a media fixture", async () => {
    const root = await repo(
      mediaJob({ "media.ts": `throw new Error("not in a stub run");\n` }),
    );
    const opts = await options(root, { stub: true });
    delete opts.launcher;
    const result = await runJob({ ...opts, env: { PATH: "/nonexistent" } });
    expect(result.messages[0]).toBe("demo: answer accepted.");
    const files = reportFiles(opts.out!);
    expect(JSON.parse(files.get("status.json")!).media).toMatchObject({
      source: "none",
      files: 0,
    });
    expect(files.get("summary.md")).toContain(
      "| Media | none, a stub run has no media fixture |",
    );
  });
});

/** Posts one messages call to the runner's model socket: what a workspace's media.ts does with its own HTTP client. */
const SOCKET_POST = `import { request as httpRequest } from "node:http";
const socketPost = (socketPath, timeout) => (body) => new Promise((resolve, reject) => {
  const req = httpRequest({ socketPath, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" }, timeout }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { text += c; });
    res.on("end", () => resolve({ status: res.statusCode, text }));
  });
  req.on("error", reject);
  req.end(body);
});`;


/** Calls the model on the runner's socket once, then writes a video and what it saw into the manifest's data. */
const MODEL_MEDIA_TS = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMain } from ${RUN_MAIN};
import { mediaHash, sha256Hex } from ${MEDIA_LIB};
${SOCKET_POST}

async function main() {
  const dir = process.env.FLAX_AGENTS_MEDIA_DIR;
  const reply = await socketPost(process.env.FLAX_AGENTS_MEDIA_MODEL_SOCKET, 5000)(
    JSON.stringify({ model: "another", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  );
  writeFileSync(join(dir, "video.mp4"), "a video");
  const files = [{ path: "video.mp4", sha256: sha256Hex("a video"), bytes: 7, type: "video/mp4" }];
  writeFileSync(join(dir, "media.json"), JSON.stringify({
    version: 1,
    files,
    hash: mediaHash(files),
    data: {
      status: reply.status,
      model: JSON.parse(reply.text).got.model,
      names: Object.keys(process.env).filter((n) => /FLAX_AGENTS|GATEWAY|KEY/.test(n)).sort(),
      model_id: process.env.FLAX_AGENTS_MEDIA_MODEL,
      holdsKey: Object.values(process.env).some((v) => v.startsWith("sk-fakegw")),
    },
  }));
}
await runMain(import.meta.url, "demo", main);
`;

describe("a job whose media stage gets a model", () => {
  const MODEL_MEDIA = {
    ...MEDIA,
    model: { model: "acme/test-model", usd_per_run: 1 },
  };
  const NOW = new Date("2026-10-06T12:00:00Z");

  function modelJob(): NonNullable<RepoSpec["jobs"]> {
    return {
      demo: {
        ...jobFiles("demo", { media: MODEL_MEDIA }),
        "media.ts": MODEL_MEDIA_TS,
        "collect.ts": COLLECT_TS,
      },
    };
  }

  it("issues a capped key for the stage, serves it on a socket media.ts calls without holding it, then blocks it and reports its spend", async () => {
    const root = await repo(modelJob());
    const gw = await testGateway({ spendOfIssued: 0.25 });
    const bin = scratch();
    const opts = await options(root, {
      lbx: writeFakeLbx(bin),
      gateway: gw.gateway,
      now: () => NOW,
    });
    const result = await runJob(opts);
    expect(result.messages[0]).toBe("demo: answer accepted.");

    const files = reportFiles(opts.out!);
    const input = JSON.parse(files.get("input.json")!);
    expect(input.media).toEqual({
      status: 200,
      model: "test-model",
      names: [
        "ELEVENLABS_API_KEY",
        "FLAX_AGENTS_MEDIA_DIR",
        "FLAX_AGENTS_MEDIA_MODEL",
        "FLAX_AGENTS_MEDIA_MODEL_SOCKET",
      ],
      model_id: "acme/test-model",
      holdsKey: false,
    });

    // The media key first, then the box's run key, both under the job's month.
    const issued = gw.fake.requests
      .filter((r) => r.path === "/key/generate")
      .map(
        (r) =>
          r.body as { key_alias: string; max_budget: number; duration: string },
      );
    expect(issued).toHaveLength(2);
    expect(issued[0]!.key_alias).toMatch(/^agents\/demo\/2026-10\/.+-media$/);
    expect([issued[0]!.max_budget, issued[0]!.duration]).toEqual([1, "15m"]);
    expect(issued[1]!.key_alias).toBe(
      issued[0]!.key_alias.replace(/-media$/, ""),
    );
    expect(gw.fake.keys[0]!.blocked).toBe(true);

    const status = JSON.parse(files.get("status.json")!);
    expect(status.mediaModel).toEqual({
      url: gw.fake.url,
      model: "acme/test-model",
      keyAlias: issued[0]!.key_alias,
      keyId: gw.fake.keys[0]!.token,
      expires: "2026-09-25T13:00:00Z",
      maxBudgetUsd: 1,
      minutes: 15,
      blocked: true,
      spendUsd: 0.25,
      forwarder: { forwarded: 1, refused: 0, failed: 0, polls: 0 },
      problems: [],
    });
    expect(status.budget.reserveUsd).toBeCloseTo(1.002, 6);
    const calls = JSON.parse(files.get("media-forwarder.json")!);
    expect(calls.map((c: { outcome: string }) => c.outcome)).toEqual([
      "forwarded",
    ]);
    expect(files.get("summary.md")).toContain(
      `| Media model | \`acme/test-model\`, key \`${issued[0]!.key_alias}\`, $0.2500 spent of $1.00, 1 call forwarded, 0 refused, blocked |`,
    );
    const order = JSON.parse(files.get("timings.json")!).map(
      (t: { step: string }) => t.step,
    );
    expect(order.indexOf("media-key")).toBe(order.indexOf("media") - 1);
    for (const [file, text] of files)
      for (const key of gw.fake.issued)
        expect(text.includes(key), file).toBe(false);
  });

  it("does not start when the month cannot hold the box's worst case and the media key", async () => {
    const root = await repo(modelJob());
    const gw = await testGateway({
      keys: [{ key_alias: "agents/demo/2026-10/earlier", spend: 4.5 }],
    });
    const opts = await options(root, {
      lbx: writeFakeLbx(scratch()),
      gateway: gw.gateway,
      now: () => NOW,
    });
    const result = await runJob(opts);
    expect(result.messages).toEqual([
      "demo has spent $4.50 of its $5 in 2026-10; a run can cost up to $1.00",
    ]);
    expect(gw.fake.issued).toEqual([]);
  });

  it("gets no key in a stub run", async () => {
    const root = await repo(modelJob());
    const opts = await options(root, { stub: true });
    delete opts.launcher;
    const result = await runJob({ ...opts, env: { PATH: "/nonexistent" } });
    expect(result.messages[0]).toBe("demo: answer accepted.");
    const status = JSON.parse(reportFiles(opts.out!).get("status.json")!);
    expect(status.mediaModel).toBeUndefined();
  });
});
