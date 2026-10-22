import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  asPinnedInput,
  asReplayInput,
  replayContext,
} from "./pinned-input.ts";
import { usesModel, type Output } from "../lib/job.ts";
import { loadAllowlists, type RepoCode } from "../lib/allowlists.ts";
import {
  onDemandPages,
  PAGES_ON_DEMAND_FILE,
} from "../run-job/pages-on-demand.ts";
import { MEDIA_DIR, MEDIA_MANIFEST, type MediaManifest } from "../lib/media.ts";
import { jobFile } from "../lib/paths.ts";
import { firstLine } from "../lib/problem.ts";
import { loadJob } from "../lib/repo.ts";
import {
  checkPatchSet,
  type CheckContext,
  type CheckResult,
  type MediaContext,
} from "./pr.ts";

export interface ReportCheck {
  job: string;
  model: string;
  answer: unknown;
  result: CheckResult;
}

function readJson(dir: string, file: string): unknown {
  const path = join(dir, file);
  if (!existsSync(path)) throw new Error(`${file} is missing from ${dir}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${file} in ${dir} is not JSON: ${firstLine(err)}`);
  }
}

/** What the PR checker holds a job with output kind pr to: its job.yml, the pages, sources and dashboard source in the run's input, and the run's media files when its media stage made any. */
export function prOutputContext(
  output: Extract<Output, { kind: "pr" }>,
  input: unknown,
  media?: MediaContext,
  repoCode: Readonly<Record<string, RepoCode>> = {},
): CheckContext | { error: string } {
  const pinned = asPinnedInput(input);
  if ("error" in pinned) return pinned;
  return {
    policy: {
      repos: output.repos,
      paths: output.paths,
      maxChangedLines: output.max_changed_lines,
      ...(output.frontmatter_keys === undefined
        ? {}
        : { frontmatterKeys: output.frontmatter_keys }),
      ...(output.stamp_keys === undefined
        ? {}
        : { stampKeys: output.stamp_keys }),
      ...(output.review_team === undefined
        ? {}
        : { reviewTeam: output.review_team }),
      ...(output.auto_merge === undefined
        ? {}
        : { autoMergePaths: output.auto_merge.paths }),
      ...(media === undefined ? {} : { mediaPaths: media.paths }),
      ...(output.new_files === undefined ? {} : { newFiles: output.new_files }),
      ...(output.tool_citations === true ? { toolCitations: true } : {}),
      ...(output.code_fix === true ? { codeFix: { repos: repoCode } } : {}),
      ...(output.draft === true ? { draft: true } : {}),
    },
    pinned: pinned.pages,
    ...(media === undefined ? {} : { media }),
    ...(pinned.sources === undefined ? {} : { sources: pinned.sources }),
    ...(pinned.uiSource === undefined ? {} : { ui: pinned.uiSource }),
  };
}

/**
 * Runs the PR checker over a run report (the job-<name>-report artifact).
 * A job with output kind pr is held to its job.yml; a replay job, whose
 * output is a file, to the rules in its input. A report whose input came
 * from the fixture must carry the fixture committed here, so an answer is
 * never checked against pages it was not given. A job with model: none is
 * held to the rules for an answer its code built, with the media.json the
 * report kept.
 */
export function checkReport(root: string, dir: string): ReportCheck {
  const status = readJson(dir, "status.json") as {
    job?: unknown;
    model?: unknown;
    inputSource?: unknown;
  };
  if (typeof status.job !== "string")
    throw new Error(`status.json in ${dir} names no job`);
  const job = loadJob(root, status.job);
  if (job.config === undefined)
    throw new Error(
      `${jobFile(status.job, "job.yml")} is missing or invalid here`,
    );
  // A job with publish.ts delivers the patch set it built from the answer; one that published nothing proposes no page.
  const published = existsSync(join(dir, "publish.json"))
    ? (readJson(dir, "publish.json") as { publish?: unknown; answer?: unknown })
    : undefined;
  const answer =
    published === undefined
      ? readJson(dir, "answer.json")
      : published.publish === true
        ? published.answer
        : { pages: [] };
  const input = readJson(dir, "input.json");
  if (status.inputSource === "fixture") {
    const fixture = readJson(
      join(root, jobFile(status.job, "fixtures")),
      "input.json",
    );
    if (!isDeepStrictEqual(input, fixture))
      throw new Error(
        `the report's input.json is not ${jobFile(status.job, "fixtures/input.json")} as committed here; check out the commit the run used`,
      );
  }
  let context: CheckContext;
  const output = job.config.output;
  if (output.kind === "pr") {
    const paths = job.config.media?.pr_paths;
    const manifest =
      paths !== undefined && existsSync(join(dir, MEDIA_DIR, MEDIA_MANIFEST))
        ? (readJson(join(dir, MEDIA_DIR), MEDIA_MANIFEST) as MediaManifest)
        : undefined;
    const pr = prOutputContext(
      output,
      input,
      paths === undefined || manifest === undefined
        ? undefined
        : { paths, files: manifest.files },
      loadAllowlists(root).allowlists.repoCode,
    );
    if ("error" in pr) throw new Error(pr.error);
    // The pages the runner read on demand were checked like given ones; the tools' results are not in the report, so quotes are not looked up again.
    const onDemand = existsSync(join(dir, PAGES_ON_DEMAND_FILE))
      ? onDemandPages(readJson(dir, PAGES_ON_DEMAND_FILE))
      : [];
    if (onDemand.length > 0) pr.pinned = [...pr.pinned, ...onDemand];
    if (output.tool_citations === true)
      pr.toolQuotes = { tools: job.config.tools };
    context = usesModel(job.config) ? pr : { ...pr, builtByCode: true };
  } else {
    const replay = asReplayInput(input);
    if ("error" in replay)
      throw new Error(
        `${status.job} has no pr output and ${replay.error}, so there is nothing to check its answer against`,
      );
    context = replayContext(replay);
  }
  return {
    job: status.job,
    model: typeof status.model === "string" ? status.model : "unknown",
    answer,
    result: checkPatchSet(answer, context),
  };
}
