import type { RepoPreview } from "../lib/allowlists.ts";
import type { OpenedWriter } from "../deliver/github-writer.ts";
import { NO_MODEL, type Output } from "../lib/job.ts";
import type { MediaManifest } from "../lib/media.ts";
import type { OpenedPoster } from "../deliver/slack-poster.ts";
import { asPinnedInput } from "../output-check/pinned-input.ts";
import { runPrStage, type PrStageResult } from "./pr-output.ts";
import type { PrNotify } from "./load.ts";
import type { ReportWriter } from "./report.ts";

/**
 * What a pull request job with model: none puts in media.json data.pr:
 * the pages as its media stage read them, each at one commit, and the
 * answer its code built from them, held to the PR checker like a model's.
 */
export interface MediaPr {
  pages: { repo: string; path: string; commit: string; lines: string[] }[];
  answer: unknown;
}

/** media.json data.pr, or why it is not there. */
export function mediaPr(manifest: MediaManifest): MediaPr | { error: string } {
  const data = manifest.data as { pr?: unknown } | undefined;
  const pr = data?.pr as Partial<MediaPr> | undefined;
  if (typeof pr !== "object" || pr === null)
    return {
      error:
        "media.json has no data.pr: a pull request job with model: none builds its pages and answer in media.ts",
    };
  const pinned = asPinnedInput({ pages: pr.pages });
  if ("error" in pinned)
    return { error: `media.json data.pr: ${pinned.error}` };
  if (typeof pr.answer !== "object" || pr.answer === null)
    return { error: "media.json data.pr has no answer" };
  return { pages: pr.pages as MediaPr["pages"], answer: pr.answer };
}

/**
 * The pull request stage of a job with model: none: the input and answer
 * come from its media stage, the PR checker holds the answer to every rule
 * but evidence, there is no second check, and delivery writes the media
 * files the answer names from the checked media directory.
 */
export async function runNoModelPrStage(o: {
  job: string;
  output: Extract<Output, { kind: "pr" }>;
  mediaPaths: readonly string[];
  mode: "shadow" | "live";
  stub: boolean;
  runName: string;
  runUrl?: string;
  report: ReportWriter;
  now: Date;
  media: { dir: string; manifest: MediaManifest };
  previews?: Readonly<Record<string, RepoPreview>>;
  openWriter(repos: readonly string[]): Promise<OpenedWriter>;
  notify?: PrNotify;
  openPoster?(): Promise<OpenedPoster>;
}): Promise<PrStageResult> {
  const pr = mediaPr(o.media.manifest);
  if ("error" in pr)
    return {
      record: { outcome: "report_only", reason: pr.error },
      failure: pr.error,
    };
  const input = { pages: pr.pages };
  o.report.writeJson("input.json", input);
  o.report.writeJson("answer.json", pr.answer);
  return runPrStage({
    job: o.job,
    output: o.output,
    mode: o.mode,
    stub: o.stub,
    answer: pr.answer,
    input,
    jobPrompt: "",
    untrusted: { seen: false, model: [], collect: [] },
    model: NO_MODEL,
    runName: o.runName,
    ...(o.runUrl === undefined ? {} : { runUrl: o.runUrl }),
    ...(o.previews === undefined ? {} : { previews: o.previews }),
    report: o.report,
    now: o.now,
    review: () =>
      Promise.resolve({ error: "a job with model: none has no second check" }),
    openWriter: o.openWriter,
    builtByCode: true,
    ...(o.notify === undefined ? {} : { notify: o.notify }),
    ...(o.openPoster === undefined ? {} : { openPoster: o.openPoster }),
    media: { ...o.media, paths: o.mediaPaths },
  });
}
