import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  deliverPlan,
  deliverRevision,
  planProblem,
  pullBody,
  type DeliveryMeta,
} from "../src/deliver/deliver.ts";
import { GithubWriter } from "../src/deliver/github-writer.ts";
import { planDelivery } from "../src/deliver/plan.ts";
import { commitAuthor } from "../src/deliver/writer.ts";
import {
  mediaHash,
  readMediaFile,
  sha256Hex,
  type MediaFile,
  type MediaManifest,
} from "../src/lib/media.ts";
import {
  checkPatchSet,
  resultLines,
  type CheckContext,
  type ProposedMedia,
  type ProposedPage,
} from "../src/output-check/pr.ts";
import { ReportWriter } from "../src/run-job/report.ts";
import { runPrStage, type PrStageOptions } from "../src/run-job/pr-output.ts";
import { fakeGithubFetch, FakeWriter } from "./fake-writer.ts";

const DOCS = "notes-co/public-docs";
const BASE = "c".repeat(40);
const NOW = new Date("2026-10-05T16:00:00Z");
const LIST = "src/data/screenshots.json";
const PAGE = ["[]"];
const SHOT = "public/screenshots/portfolio.png";
const PNG = Buffer.from("\x89PNG\r\n\x1a\nnot really an image");
const FILE: MediaFile = {
  path: "portfolio.png",
  sha256: sha256Hex(PNG),
  bytes: PNG.length,
  type: "image/png",
};

const policy = {
  repos: [DOCS],
  paths: [LIST, "src/content/docs/**/*.mdx"],
  maxChangedLines: 50,
  mediaPaths: ["public/screenshots/*.png"],
};

function context(over: Partial<CheckContext> = {}): CheckContext {
  return {
    policy,
    pinned: [{ repo: DOCS, path: LIST, commit: BASE, lines: PAGE }],
    media: { paths: policy.mediaPaths, files: [FILE] },
    builtByCode: true,
    ...over,
  };
}

const listPatch: ProposedPage = {
  repo: DOCS,
  path: LIST,
  decision: "patch",
  reason: "Adds the portfolio screenshot.",
  patch: `--- a/${LIST}\n+++ b/${LIST}\n@@ -1 +1,3 @@\n-[]\n+[\n+  { "id": "portfolio" }\n+]\n`,
};

const shot: ProposedMedia = { repo: DOCS, path: SHOT, file: FILE.path };

function withoutMedia(): CheckContext {
  const { media: _media, ...rest } = context();
  return rest;
}

function problems(answer: unknown, ctx = context()): string[] {
  return resultLines(checkPatchSet(answer, ctx));
}

describe("media files in a pull request answer", () => {
  it("are accepted from an answer the job's code built, with pages that need no evidence", () => {
    expect(problems({ pages: [listPatch], media: [shot] })).toEqual([]);
    expect(problems({ pages: [], media: [shot] })).toEqual([]);
  });

  it("are refused from a model's answer, whose lines also need evidence again", () => {
    const lines = problems(
      { pages: [listPatch], media: [shot] },
      context({ builtByCode: false }),
    );
    expect(lines).toContain(
      "the answer carries media files, which only an answer the job's code built may do",
    );
    expect(lines.some((l) => l.includes("adds a line with no evidence"))).toBe(
      true,
    );
  });

  it("are refused when the job lists no media.pr_paths or the run has no media", () => {
    expect(problems({ pages: [], media: [shot] }, withoutMedia())).toEqual([
      "the answer carries media files, but the job lists no media.pr_paths or the run has no media",
    ]);
  });

  it("must name a file of media.json, go where media.pr_paths allows in a repository the job may change, keep the extension and appear once", () => {
    const at = (m: Partial<ProposedMedia>) =>
      problems({ pages: [], media: [{ ...shot, ...m }] });
    expect(at({ file: "other.png" })).toEqual([
      `media[0] (${DOCS}/${SHOT}): other.png is not a file of the run's media.json`,
    ]);
    expect(at({ file: "../portfolio.png" })[0]).toContain(
      "file ../portfolio.png must",
    );
    expect(at({ path: "public/logo.png" })).toEqual([
      `media[0] (${DOCS}/public/logo.png): outside the paths media files may go (public/screenshots/*.png)`,
    ]);
    expect(
      problems(
        {
          pages: [],
          media: [{ ...shot, path: "public/screenshots/portfolio.svg" }],
        },
        context({ media: { paths: ["public/screenshots/*"], files: [FILE] } }),
      ),
    ).toEqual([
      `media[0] (${DOCS}/public/screenshots/portfolio.svg): portfolio.png would change its extension to .svg`,
    ]);
    expect(at({ repo: "notes-co/dashboard" })[0]).toContain(
      "is not a repository this job may change",
    );
    expect(at({ path: "public/screenshots/../x.png" })[0]).toContain(
      "is not a plain relative path",
    );
    expect(
      problems({ pages: [], media: [shot, { ...shot }] }).some((l) =>
        l.endsWith("is listed more than once"),
      ),
    ).toBe(true);
  });

  it("must be a list of exactly repo, path and file", () => {
    expect(problems({ pages: [], media: "x" })).toEqual([
      "media is not a list",
    ]);
    expect(
      problems({ pages: [], media: [{ ...shot, mode: "100755" }] }),
    ).toEqual([
      "media[0] must be an object of exactly repo, path and file, each a string, and an optional change",
    ]);
  });

  it("may say what changed, as a few plain lines and whether there is an earlier version", () => {
    const change = { lines: ['Top: "86" -> "80"'], before: true };
    expect(problems({ pages: [], media: [{ ...shot, change }] })).toEqual([]);
    const refused = (c: unknown) =>
      problems({ pages: [], media: [{ ...shot, change: c }] });
    expect(refused({ lines: [] })).toEqual([
      "media[0]: change must have exactly lines and before",
    ]);
    expect(refused({ lines: [1], before: true })[0]).toContain(
      "change.lines must be at most 20 strings",
    );
    expect(refused({ lines: Array(21).fill("x"), before: false })[0]).toContain(
      "change.lines must be at most 20 strings",
    );
    expect(refused({ lines: [], before: "yes" })).toEqual([
      "media[0]: change.before must be true or false",
    ]);
  });
});

describe("planning and delivering media files", () => {
  const meta: DeliveryMeta = {
    model: "none",
    runName: "job-docs-screenshots-1-1",
    untrustedTools: [],
    reviewReasons: [],
    builtByCode: true,
  };

  function plan(answer = { pages: [listPatch], media: [shot] }) {
    const p = planDelivery("docs-screenshots", answer, context(), NOW);
    if ("error" in p) throw new Error(p.error);
    return p;
  }

  it("go on the commit the repository's pages were read at, even when no page changes", () => {
    const p = plan({ pages: [], media: [shot] });
    expect(p.repos).toEqual([
      {
        repo: DOCS,
        base: BASE,
        files: [],
        stamped: [],
        reviewers: [],
        media: [{ path: SHOT, file: FILE }],
      },
    ]);
    expect(
      planDelivery(
        "docs-screenshots",
        { pages: [], media: [shot] },
        context({ pinned: [] }),
        NOW,
      ),
    ).toEqual({
      error: `no page of ${DOCS} was given to the run, so there is no commit to put ${SHOT} on`,
    });
  });

  it("are refused again at delivery outside the job's media paths", () => {
    const p = plan();
    p.repos[0]!.media![0]!.path = "public/favicon.png";
    expect(planProblem(p, policy)).toBe(
      `${DOCS}/public/favicon.png is outside the paths this job's media files may go`,
    );
  });

  it("are committed byte for byte with the pages and listed in the pull request", async () => {
    const w = new FakeWriter();
    w.put(DOCS, BASE, LIST, "[]\n");
    const read: MediaFile[] = [];
    const [pull] = await deliverPlan(plan(), policy, w, meta, NOW, (file) => {
      read.push(file);
      return PNG;
    });
    expect(read).toEqual([FILE]);
    expect(w.commits[0]!.request.files).toEqual([
      { path: LIST, text: '[\n  { "id": "portfolio" }\n]\n', mode: "100644" },
      { path: SHOT, bytes: PNG, mode: "100644" },
    ]);
    expect(w.commits[0]!.request.message).toContain(`- ${SHOT} (media)`);
    const opened = w.pulls.find((p) => p.number === pull!.number)!;
    expect(opened.title).toBe(
      "docs-screenshots: 1 page, 1 media file (2026-10-05)",
    );
    expect(opened.body).toContain(
      `- [\`${SHOT}\`](https://github.com/notes-co/public-docs/blob/agent/docs-screenshots/2026-10-05/${SHOT}): retaken by the run`,
    );
    expect(opened.body).toContain(
      `- \`${SHOT}\`: ${PNG.length} bytes, sha256 \`${FILE.sha256.slice(0, 12)}\``,
    );
    expect(opened.body).toContain("| Model | none |");
    expect(opened.body).toContain(
      "the job's code built this change, so there was no second check",
    );
  });

  it("need a way to read the media at delivery, and are never part of a revision", async () => {
    const w = new FakeWriter();
    w.put(DOCS, BASE, LIST, "[]\n");
    await expect(deliverPlan(plan(), policy, w, meta, NOW)).rejects.toThrow(
      "the run gave delivery no media to read",
    );
    await expect(
      deliverRevision(
        { ...plan(), branch: "agent/docs-screenshots/2026-10-05" },
        policy,
        w,
        { runName: "r", round: 1 },
        NOW,
      ),
    ).rejects.toThrow("a revision writes no media files");
  });

  it("are sent to GitHub as base64 blobs, and the tree points at them", async () => {
    const gh = fakeGithubFetch({ commits: { [BASE]: "a".repeat(40) } });
    const w = new GithubWriter({
      token: "t0ken",
      apiUrl: "https://api.test",
      fetch: gh.fetch,
    });
    const atlas = "notes-co/atlas";
    await w.commitFiles(atlas, {
      base: BASE,
      branch: "agent/docs-screenshots/2026-10-05",
      message: "m",
      author: commitAuthor(),
      date: NOW,
      files: [
        { path: "a.txt", text: "a\n", mode: "100644" },
        { path: SHOT, bytes: PNG, mode: "100644" },
      ],
    });
    const writes = gh.requests.filter((r) => r.method !== "GET");
    expect(writes[0]).toMatchObject({
      method: "POST",
      path: `/repos/${atlas}/git/blobs`,
      body: { content: PNG.toString("base64"), encoding: "base64" },
    });
    expect(writes[1]!.body).toEqual({
      base_tree: "a".repeat(40),
      tree: [
        { path: "a.txt", mode: "100644", type: "blob", content: "a\n" },
        { path: SHOT, mode: "100644", type: "blob", sha: "4".repeat(40) },
      ],
    });
  });

  it("keeps the model's words out of a code-built pull request body", () => {
    const body = pullBody(
      "docs-screenshots",
      plan().repos[0]!,
      meta,
      "agent/docs-screenshots/2026-10-05",
    );
    expect(body).not.toContain("Second check");
  });

  it("list what the job's code says changed, escaped, and show a changed image beside the one it replaces", () => {
    const TEXT = Buffer.from("  80 /100\n");
    const textFile: MediaFile = {
      path: "portfolio.txt",
      sha256: sha256Hex(TEXT),
      bytes: TEXT.length,
      type: "text/plain",
    };
    const ctx = context({
      media: {
        paths: [...policy.mediaPaths, "src/data/screenshot-text/*.txt"],
        files: [FILE, textFile],
      },
    });
    const branch = "agent/docs-screenshots/2026-10-05";
    const bodyOf = (before: boolean) => {
      const p = planDelivery(
        "docs-screenshots",
        {
          pages: [],
          media: [
            {
              ...shot,
              change: {
                lines: [
                  'Dependency health: "86 /100" -> "80 /100"',
                  'What to fix next: added "<b>*Upgrade*</b> @alice"',
                ],
                before,
              },
            },
            {
              repo: DOCS,
              path: "src/data/screenshot-text/portfolio.txt",
              file: textFile.path,
            },
          ],
        },
        ctx,
        NOW,
      );
      if ("error" in p) throw new Error(p.error);
      return pullBody("docs-screenshots", p.repos[0]!, meta, branch);
    };
    const body = bodyOf(true);
    expect(body).toContain(
      "Updates 1 image and 1 other file in `public-docs`. Opened by",
    );
    expect(body).toContain('  - Dependency health: "86 /100" -&gt; "80 /100"');
    expect(body).toContain(
      '  - What to fix next: added "&lt;b&gt;\\*Upgrade\\*&lt;/b&gt; @⁠alice"',
    );
    const raw = (ref: string) =>
      `https://github.com/${DOCS}/blob/${ref}/${SHOT}?raw=true`;
    expect(body).toContain(
      [
        "**Before and after**",
        "",
        `\`${SHOT}\``,
        "",
        "| Before | After |",
        "| --- | --- |",
        `| ![before](${raw(BASE)}) | ![after](${raw(branch)}) |`,
      ].join("\n"),
    );
    expect(body).not.toContain("portfolio.txt?raw=true");
    expect(bodyOf(false)).toContain(
      ["| New |", "| --- |", `| ![after](${raw(branch)}) |`].join("\n"),
    );
    expect(
      pullBody("docs-screenshots", plan().repos[0]!, meta, branch),
    ).not.toContain("Before and after");
  });
});

describe("the pull request stage with media", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "pr-media-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const mediaDir = join(dir, "media");
    const reportDir = join(dir, "report");
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(join(mediaDir, FILE.path), PNG);
    const manifest: MediaManifest = {
      version: 1,
      files: [FILE],
      hash: mediaHash([FILE]),
    };
    return {
      mediaDir,
      report: new ReportWriter(reportDir, []),
      reportDir,
      manifest,
    };
  }

  function options(s: ReturnType<typeof setup>): PrStageOptions {
    return {
      job: "docs-screenshots",
      output: {
        kind: "pr",
        repos: [DOCS],
        paths: policy.paths,
        max_changed_lines: 50,
        untrusted_input: "report_only",
        review_team: "engineering",
      },
      mode: "shadow",
      stub: false,
      answer: { pages: [listPatch], media: [shot] },
      input: {
        pages: [{ repo: DOCS, path: LIST, commit: BASE, lines: PAGE }],
      },
      jobPrompt: "",
      untrusted: { seen: false, model: [], collect: [] },
      model: "none",
      runName: "job-docs-screenshots-1-1",
      report: s.report,
      now: NOW,
      review: () => Promise.reject(new Error("no second check for code")),
      openWriter: () => Promise.reject(new Error("shadow opens nothing")),
      builtByCode: true,
      media: {
        dir: s.mediaDir,
        manifest: s.manifest,
        paths: policy.mediaPaths,
      },
    };
  }

  it("checks the code-built answer without a second check and keeps the media in the shadow plan", async () => {
    const s = setup();
    const { record, failure } = await runPrStage(options(s));
    expect(failure).toBeUndefined();
    expect(record).toMatchObject({
      outcome: "shadow",
      media: [{ repo: DOCS, path: SHOT, file: FILE.path, sha256: FILE.sha256 }],
    });
    expect(record.review).toBeUndefined();
    const planned = JSON.parse(
      readFileSync(join(s.reportDir, "delivery", "plan.json"), "utf8"),
    );
    expect(planned[0].media).toEqual([
      { path: SHOT, file: FILE.path, sha256: FILE.sha256, bytes: PNG.length },
    ]);
  });

  it("delivers live through the writer, reading each media file again by its sha256", async () => {
    const s = setup();
    const w = new FakeWriter();
    w.put(DOCS, BASE, LIST, "[]\n");
    const { record, failure } = await runPrStage({
      ...options(s),
      mode: "live",
      openWriter: () =>
        Promise.resolve({
          writer: w,
          secrets: [],
          close: () => Promise.resolve(),
        }),
    });
    expect(failure).toBeUndefined();
    expect(record.outcome).toBe("delivered");
    expect(w.calls.filter((c) => c.startsWith("requestReviewers"))).toEqual([
      `requestReviewers ${DOCS} #${w.pulls[0]!.number} team:engineering`,
    ]);
    expect(w.commits[0]!.request.files[1]).toEqual({
      path: SHOT,
      bytes: readMediaFile(s.mediaDir, FILE),
      mode: "100644",
    });
  });

  it("fails delivery when a media file changed after media.json was checked", async () => {
    const s = setup();
    writeFileSync(join(s.mediaDir, FILE.path), Buffer.alloc(PNG.length));
    const w = new FakeWriter();
    w.put(DOCS, BASE, LIST, "[]\n");
    const { record, failure } = await runPrStage({
      ...options(s),
      mode: "live",
      openWriter: () =>
        Promise.resolve({
          writer: w,
          secrets: [],
          close: () => Promise.resolve(),
        }),
    });
    expect(record.outcome).toBe("report_only");
    expect(failure).toContain("changed after media.json was checked");
    expect(w.commits).toEqual([]);
  });
});
