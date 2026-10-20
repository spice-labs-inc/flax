import { FIXTURE_WORKSPACE } from "./helpers.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parse, stringify } from "yaml";
import { mediaCheck, neverMediaSecrets } from "../src/check/media.ts";
import { generate } from "../src/generate/generate.ts";
import { KIT_ACTION_STEP, timeoutMinutes } from "../src/generate/render.ts";
import type { JobConfig } from "../src/lib/job.ts";
import {
  MAX_MEDIA_BYTES,
  mediaHash,
  mediaSecretEnv,
  readMediaFile,
  readMediaManifest,
  sha256Hex,
  type MediaFile,
} from "../src/lib/media.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { withoutRunnerSecrets } from "../src/run-job/input.ts";
import {
  keepMedia,
  MAX_REPORT_MEDIA_BYTES,
  mediaEnv,
  mediaTmpEnv,
  runMediaScript,
} from "../src/run-job/media.ts";
import { ReportWriter, secretValues } from "../src/run-job/report.ts";
import { jobConfig, jobFiles, makeRepo, run } from "./helpers.ts";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-media-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function entry(path: string, data: string, type = "text/plain"): MediaFile {
  return {
    path,
    sha256: sha256Hex(data),
    bytes: Buffer.byteLength(data),
    type,
  };
}

/** A media directory holding these files and a manifest of them, with any changes to the manifest applied. */
function mediaDir(
  files: Record<string, string>,
  change: (m: Record<string, unknown>) => void = () => {},
): string {
  const dir = scratch();
  const list = Object.entries(files).map(([path, data]) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), data);
    return entry(path, data);
  });
  const manifest: Record<string, unknown> = {
    version: 1,
    files: list,
    hash: mediaHash(list),
    data: { scenes: ["intro"] },
  };
  change(manifest);
  writeFileSync(join(dir, "media.json"), JSON.stringify(manifest));
  return dir;
}

function first(m: Record<string, unknown>): MediaFile {
  return (m.files as MediaFile[])[0]!;
}

function refusal(dir: string): string {
  try {
    readMediaManifest(join(dir, "media.json"), dir);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

describe("the media manifest", () => {
  it("hashes the sorted path and sha256 lines, joined with a newline", () => {
    const a = entry("b.png", "two");
    const b = entry("a.mp4", "one");
    expect(mediaHash([a, b])).toBe(
      sha256Hex(`a.mp4 ${b.sha256}\nb.png ${a.sha256}`),
    );
    expect(mediaHash([b, a])).toBe(mediaHash([a, b]));
  });

  it("accepts files that match, in subdirectories too, and keeps the data", () => {
    const dir = mediaDir({ "video.mp4": "v", "shots/one.png": "p" });
    const manifest = readMediaManifest(join(dir, "media.json"), dir);
    expect(manifest.files.map((f) => f.path)).toEqual([
      "video.mp4",
      "shots/one.png",
    ]);
    expect(manifest.data).toEqual({ scenes: ["intro"] });
    expect(readMediaFile(dir, manifest.files[0]!).toString()).toBe("v");
  });

  it.each<[string, (m: Record<string, unknown>) => void, string]>([
    [
      "an unknown version",
      (m) => {
        m.version = 2;
      },
      "media.json does not match schema/media.schema.json: version: must be 1",
    ],
    [
      "a path with ..",
      (m) => {
        first(m).path = "../video.mp4";
      },
      "media.json: path ../video.mp4 must not name . or ..",
    ],
    [
      "a leading /",
      (m) => {
        first(m).path = "/etc/passwd";
      },
      "media.json does not match schema/media.schema.json: files[0].path:",
    ],
    [
      "a file listed twice",
      (m) => {
        (m.files as MediaFile[]).push(first(m));
      },
      "media.json: video.mp4 is listed twice",
    ],
    [
      "a wrong size",
      (m) => {
        first(m).bytes = 2;
      },
      "video.mp4 is 1 bytes, but media.json says 2",
    ],
    [
      "a wrong sha256",
      (m) => {
        first(m).sha256 = "0".repeat(64);
      },
      "video.mp4 does not match its sha256 in media.json",
    ],
    [
      "a wrong hash",
      (m) => {
        m.hash = "0".repeat(64);
      },
      "media.json: hash is not the hash of its files' paths and sha256",
    ],
    [
      "more than the media limit",
      (m) => {
        first(m).bytes = MAX_MEDIA_BYTES + 1;
      },
      `media.json lists ${MAX_MEDIA_BYTES + 1} bytes of media, over the ${MAX_MEDIA_BYTES} byte limit`,
    ],
    [
      "a missing file",
      (m) => {
        first(m).path = "gone.mp4";
      },
      "gone.mp4 does not exist",
    ],
  ])("refuses %s", (_, change, message) => {
    expect(refusal(mediaDir({ "video.mp4": "v" }, change))).toContain(message);
  });

  it("refuses a manifest that is not JSON, and a missing one", () => {
    const dir = scratch();
    expect(refusal(dir)).toBe("media.json does not exist");
    writeFileSync(join(dir, "media.json"), "{");
    expect(refusal(dir)).toMatch(/^media.json is not valid JSON: /);
  });

  it("refuses a linked file and a path that leads out through a linked directory", () => {
    const outside = scratch();
    writeFileSync(join(outside, "key"), "k");
    const linked = mediaDir({ "video.mp4": "k" });
    rmSync(join(linked, "video.mp4"));
    symlinkSync(join(outside, "key"), join(linked, "video.mp4"));
    expect(refusal(linked)).toBe("video.mp4 leads out of the media directory");
    const inside = mediaDir({ "video.mp4": "k", "real.mp4": "k" });
    rmSync(join(inside, "video.mp4"));
    symlinkSync(join(inside, "real.mp4"), join(inside, "video.mp4"));
    expect(refusal(inside)).toBe("video.mp4 is a symbolic link");
    const viaDir = mediaDir({ "shots/key": "k" });
    rmSync(join(viaDir, "shots"), { recursive: true });
    symlinkSync(outside, join(viaDir, "shots"));
    expect(refusal(viaDir)).toBe("shots/key leads out of the media directory");
  });

  it("refuses a file that changed after the manifest was checked", () => {
    const dir = mediaDir({ "video.mp4": "v" });
    const manifest = readMediaManifest(join(dir, "media.json"), dir);
    writeFileSync(join(dir, "video.mp4"), "w");
    expect(() => readMediaFile(dir, manifest.files[0]!)).toThrow(
      "video.mp4 changed after media.json was checked",
    );
  });
});

describe("the media report", () => {
  it("keeps media.json and the video, captions and images below the cap, never other types", () => {
    const dir = mediaDir({
      "video.mp4": "v",
      "captions.vtt": "WEBVTT\n",
      "frames/0001.jpg": "f",
    });
    const files = [
      { ...entry("video.mp4", "v"), type: "video/mp4" },
      { ...entry("captions.vtt", "WEBVTT\n"), type: "text/vtt" },
      { ...entry("frames/0001.jpg", "f"), type: "image/jpeg" },
      {
        ...entry("big.png", "never read"),
        type: "image/png",
        bytes: MAX_REPORT_MEDIA_BYTES,
      },
    ];
    const out = scratch();
    const report = new ReportWriter(out, []);
    const kept = keepMedia(report, dir, {
      version: 1,
      files,
      hash: mediaHash(files),
    });
    expect(kept).toEqual({
      kept: ["video.mp4", "captions.vtt"],
      notKept: [
        {
          path: "frames/0001.jpg",
          reason: "image/jpeg is not a type a report keeps",
        },
        { path: "big.png", reason: "over the report's 50 MB of media" },
      ],
    });
    expect(readFileSync(join(out, "media/video.mp4"), "utf8")).toBe("v");
    expect(existsSync(join(out, "media/media.json"))).toBe(true);
    expect(existsSync(join(out, "media/frames"))).toBe(false);
  });

  it("leaves out a file that holds a secret value and counts it", () => {
    const secret = ["media", "secret", "value", "9f8e"].join("-");
    const dir = mediaDir({ "poster.png": `x${secret}x` });
    const files = [
      { ...entry("poster.png", `x${secret}x`), type: "image/png" },
    ];
    const report = new ReportWriter(scratch(), [secret]);
    expect(
      keepMedia(report, dir, { version: 1, files, hash: mediaHash(files) }),
    ).toEqual({
      kept: [],
      notKept: [{ path: "poster.png", reason: "it holds a secret value" }],
    });
    expect(report.secretHits).toBe(1);
  });
});

describe("media secrets", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/runner",
    ELEVENLABS_API_KEY: "eleven-value",
    LIVETESTS_MAILBOX_USER: "mailbox@example.com",
    LIVETESTS_MAILBOX_APP_PASSWORD: "mailbox-password",
    LLM_GATEWAY_ISSUER_KEY: "issuer-value",
    OTHER: "other",
  };

  it("gives media.ts the basics and only the secrets its job lists", () => {
    expect(
      mediaEnv(
        env,
        {
          network: "public",
          secrets: ["ELEVENLABS_API_KEY"],
          timeout_minutes: 5,
        },
        "/run/media",
      ),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      ELEVENLABS_API_KEY: "eleven-value",
      FLAX_AGENTS_MEDIA_DIR: "/run/media",
    });
  });

  it("puts media.ts's temporary files in the run directory unless the runner names a TMPDIR", () => {
    const root = mkdtempSync(join(tmpdir(), "media-tmp-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    expect(mediaTmpEnv(env, root)).toEqual({ TMPDIR: join(root, "tmp") });
    expect(statSync(join(root, "tmp")).isDirectory()).toBe(true);
    expect(mediaTmpEnv({ ...env, TMPDIR: "/scratch" }, root)).toEqual({});
  });

  it("keeps every media secret from lbx and job code, and scrubs all but the mailbox address", () => {
    expect(withoutRunnerSecrets(env)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      OTHER: "other",
    });
    expect(secretValues(env).sort()).toEqual([
      "eleven-value",
      "issuer-value",
      "mailbox-password",
    ]);
  });

  it("allows no secret the runner or the workflow alone holds", () => {
    for (const name of mediaSecretEnv())
      expect(neverMediaSecrets(), name).not.toContain(name);
    expect(neverMediaSecrets()).toEqual(
      expect.arrayContaining([
        "LLM_GATEWAY_ISSUER_KEY",
        "AGENTS_WRITER_PRIVATE_KEY",
        "SLACK_AGENTS_POST_TOKEN",
        "AGENTS_READER_PRIVATE_KEY",
        "TS_OAUTH_SECRET",
      ]),
    );
  });
});

const MEDIA = { network: "public", secrets: [], timeout_minutes: 5 };
const MEDIA_TS = "console.log('');\n";

function mediaManifestFiles(data: string): Record<string, string> {
  const files = [{ ...entry("poster.png", data), type: "image/png" }];
  return {
    "fixtures/media.json": JSON.stringify({
      version: 1,
      files,
      hash: mediaHash(files),
    }),
    "fixtures/media/poster.png": data,
  };
}

describe("the media check", () => {
  it("passes a job with media and media.ts, a job with neither, and a good fixture", async () => {
    const root = makeRepo({
      jobs: {
        plain: jobFiles("plain"),
        filmed: {
          ...jobFiles("filmed", {
            media: { ...MEDIA, secrets: [...mediaSecretEnv()] },
          }),
          "media.ts": MEDIA_TS,
          ...mediaManifestFiles("png"),
        },
      },
    });
    expect(await run(mediaCheck, root)).toEqual([]);
  });

  it("needs media.ts for media and media for media.ts", async () => {
    const root = makeRepo({
      jobs: {
        noscript: jobFiles("noscript", { media: MEDIA }),
        nomedia: { ...jobFiles("nomedia"), "media.ts": MEDIA_TS },
      },
    });
    expect(await run(mediaCheck, root)).toEqual([
      "jobs/nomedia/media.ts: runs only for a job whose job.yml has media; add it or remove media.ts",
      "jobs/noscript/job.yml: media: the job has no media.ts to run",
    ]);
  });

  it("allows pull request paths for media only in a pull request job, as plain globs", async () => {
    const root = makeRepo({
      jobs: {
        report: {
          ...jobFiles("report", {
            media: { ...MEDIA, pr_paths: ["public/shots/*.png"] },
          }),
          "media.ts": MEDIA_TS,
        },
        shots: {
          ...jobFiles("shots", {
            media: { ...MEDIA, pr_paths: ["public/**/*.png", "../x.png"] },
            output: {
              kind: "pr",
              repos: ["notes-co/public-docs"],
              paths: ["src/data/*.json"],
              max_changed_lines: 10,
              untrusted_input: "report_only",
            },
          }),
          "media.ts": MEDIA_TS,
        },
      },
    });
    expect(await run(mediaCheck, root)).toEqual([
      "jobs/report/job.yml: media.pr_paths: lists files a pull request may change, but the job's output is not a pull request",
      "jobs/shots/job.yml: media.pr_paths[0]: public/**/*.png must be a plain relative path glob without **",
      "jobs/shots/job.yml: media.pr_paths[1]: ../x.png must be a plain relative path glob without **",
    ]);
  });

  it("refuses an org read token for a stage split into parts", async () => {
    const root = makeRepo({
      jobs: {
        split: {
          ...jobFiles("split", {
            media: { ...MEDIA, org_read: true, parts: [{ id: "one-part" }] },
          }),
          "media.ts": MEDIA_TS,
        },
      },
    });
    expect(await run(mediaCheck, root)).toContain(
      "jobs/split/job.yml: media.org_read: org_read gives one media.ts run a token for every repository; a stage split into parts cannot have it",
    );
  });

  it("refuses a secret media.ts may not get", async () => {
    const root = makeRepo({
      jobs: {
        demo: {
          ...jobFiles("demo", {
            media: {
              ...MEDIA,
              secrets: [
                "LLM_GATEWAY_ISSUER_KEY",
                "TS_OAUTH_SECRET",
                "SOME_KEY",
              ],
            },
          }),
          "media.ts": MEDIA_TS,
        },
      },
    });
    expect(await run(mediaCheck, root)).toEqual([
      "jobs/demo/job.yml: media.secrets[0]: LLM_GATEWAY_ISSUER_KEY is held by the runner or the workflow alone; media.ts may never get it",
      "jobs/demo/job.yml: media.secrets[1]: TS_OAUTH_SECRET is held by the runner or the workflow alone; media.ts may never get it",
      `jobs/demo/job.yml: media.secrets[2]: SOME_KEY is not a secret media.ts may get (flax.yml agents.mediaSecrets: ${mediaSecretEnv().join(", ")})`,
    ]);
  });

  it("checks the media fixture like the runner checks media.ts's media", async () => {
    const bad = mediaManifestFiles("png");
    bad["fixtures/media/poster.png"] = "changed";
    const root = makeRepo({
      jobs: {
        bad: {
          ...jobFiles("bad", { media: MEDIA }),
          "media.ts": MEDIA_TS,
          ...bad,
        },
        stray: { ...jobFiles("stray"), ...mediaManifestFiles("png") },
        orphan: {
          ...jobFiles("orphan", { media: MEDIA }),
          "media.ts": MEDIA_TS,
          "fixtures/media/poster.png": "png",
        },
      },
    });
    expect(await run(mediaCheck, root)).toEqual([
      "jobs/bad/fixtures/media.json: poster.png is 7 bytes, but media.json says 3",
      "jobs/orphan/fixtures/media: holds the files of fixtures/media.json, which is missing",
      "jobs/stray/fixtures/media.json: stands in for media.ts, but the job has no media",
    ]);
  });

  it("finds nothing wrong in this repository", async () => {
    expect(await run(mediaCheck, FIXTURE_WORKSPACE)).toEqual([]);
  });
});

describe("the workflow of a job with media", () => {
  async function workflow(media: unknown) {
    const root = makeRepo({
      jobs: {
        demo: { ...jobFiles("demo", { media }), "media.ts": MEDIA_TS },
        other: jobFiles("other"),
      },
    });
    await generate(loadRepo(root));
    const read = (job: string) =>
      parse(
        readFileSync(join(root, `.github/workflows/job-${job}.yml`), "utf8"),
      );
    return { demo: read("demo"), other: read("other") };
  }

  it("joins the tailnet as tag:ci just before the run, leaves it on every path, and gives only the run the media secrets", async () => {
    const { demo, other } = await workflow({
      network: "tailnet",
      secrets: ["ELEVENLABS_API_KEY", "LIVETESTS_MAILBOX_USER"],
      timeout_minutes: 40,
    });
    const steps: { name?: string; uses?: string }[] = demo.jobs.run.steps;
    const names = steps.map((s) => s.name ?? s.uses);
    const at = names.indexOf(KIT_ACTION_STEP);
    expect(names.slice(at - 2, at + 2)).toEqual([
      "Check the job and the pinned box",
      "Join the tailnet",
      KIT_ACTION_STEP,
      "Leave the tailnet",
    ]);
    expect(steps[at - 1]).toEqual({
      name: "Join the tailnet",
      uses: "tailscale/github-action@v4",
      with: {
        "oauth-client-id": "${{ secrets.TS_OAUTH_CLIENT_ID }}",
        "oauth-secret": "${{ secrets.TS_OAUTH_SECRET }}",
        tags: "tag:ci",
      },
    });
    expect(steps[at + 1]).toEqual({
      name: "Leave the tailnet",
      if: "always()",
      run: "sudo tailscale logout || true",
    });
    const runStep = steps[at] as { env: Record<string, string> };
    expect(runStep.env.ELEVENLABS_API_KEY).toBe(
      "${{ secrets.ELEVENLABS_API_KEY }}",
    );
    expect(runStep.env.LIVETESTS_MAILBOX_USER).toBe(
      "${{ secrets.LIVETESTS_MAILBOX_USER }}",
    );
    expect(runStep.env.LIVETESTS_MAILBOX_APP_PASSWORD).toBeUndefined();
    // Only the steps named above see the media and tailnet secrets.
    for (const [i, step] of steps.entries())
      if (i !== at && i !== at - 1)
        expect(JSON.stringify(step)).not.toMatch(
          /ELEVENLABS|LIVETESTS|TS_OAUTH/,
        );
    expect(JSON.stringify(other)).not.toMatch(
      /ELEVENLABS|LIVETESTS|TS_OAUTH|tailscale/,
    );
    expect(demo.jobs.run["timeout-minutes"]).toBe(
      other.jobs.run["timeout-minutes"] + 40 + 5,
    );
  });

  it("joins nothing for a job whose media.ts needs only the public network", async () => {
    const { demo } = await workflow({ ...MEDIA, timeout_minutes: 20 });
    expect(JSON.stringify(demo)).not.toMatch(/tailscale|TS_OAUTH/);
  });

  it("stays within GitHub's six hours", () => {
    const job = jobConfig("demo", {
      limits: { turns: 200, tokens_per_run: 1000, usd_per_month: 5 },
      media: { network: "tailnet", secrets: [], timeout_minutes: 180 },
    }) as unknown as JobConfig;
    expect(timeoutMinutes(job)).toBe(360);
  });
});

describe("media.ts", () => {
  it("is stopped with everything it started when it runs past its time", async () => {
    const root = makeRepo({
      jobs: {
        demo: {
          ...jobFiles("demo", { media: MEDIA }),
          "media.ts": `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.env.FLAX_AGENTS_MEDIA_DIR + "/pid", String(child.pid));
setInterval(() => {}, 1000);
`,
        },
      },
      files: { "package.json": JSON.stringify({ type: "module" }) },
    });
    const dir = scratch();
    const started = Date.now();
    await expect(
      runMediaScript(
        root,
        "demo",
        { PATH: process.env.PATH ?? "", FLAX_AGENTS_MEDIA_DIR: dir },
        3000,
      ),
    ).rejects.toThrow(
      /^jobs\/demo\/media\.ts ran longer than media\.timeout_minutes in job\.yml allows and was stopped$/,
    );
    expect(Date.now() - started).toBeLessThan(20_000);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  it("fails with the error it threw", async () => {
    const root = makeRepo({
      jobs: {
        demo: {
          ...jobFiles("demo", { media: MEDIA }),
          "media.ts": `throw new Error("the fixture org could not be created");\n`,
        },
      },
    });
    await expect(
      runMediaScript(root, "demo", { PATH: process.env.PATH ?? "" }, 60_000),
    ).rejects.toThrow(
      "jobs/demo/media.ts failed (exit 1): Error: the fixture org could not be created",
    );
  });

  it("is a job file the schema and the folder check accept", async () => {
    const root = makeRepo({
      jobs: {
        demo: {
          ...jobFiles("demo", { media: MEDIA }),
          "media.ts": MEDIA_TS,
          ...mediaManifestFiles("png"),
        },
      },
    });
    const repo = loadRepo(root);
    expect(repo.jobs[0]!.problems).toEqual([]);
    expect(repo.jobs[0]!.config?.media).toEqual(MEDIA);
    // Any other network name is a join from flax.yml agents.networkJoins: the schema takes the name, generating refuses one that is not there.
    const yml = stringify(
      jobConfig("demo", { media: { ...MEDIA, network: "private" } }),
    );
    writeFileSync(join(root, "jobs/demo/job.yml"), yml);
    expect(loadRepo(root).jobs[0]!.problems).toEqual([]);
    await expect(generate(loadRepo(root))).rejects.toThrow(
      'network "private" is not in flax.yml agents.networkJoins',
    );
  });
});
