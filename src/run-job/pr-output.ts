import {
  plannedCheck,
  writeCheck,
  type CheckRecord,
} from "../deliver/checks.ts";
import {
  autoMergeDecision,
  deliverPlan,
  deliverRevision,
  plannedPaths,
  pullBody,
  pullCheck,
  pullTitle,
  reviewerNames,
  type DeliveredPull,
  type DeliveryMeta,
} from "../deliver/deliver.ts";
import type { OpenedWriter } from "../deliver/github-writer.ts";
import { planDelivery, type DeliveryPlan } from "../deliver/plan.ts";
import {
  cleanMessage,
  postProblem,
  shadowMessage,
} from "../deliver/slack-message.ts";
import type { OpenedPoster, PostedMessage } from "../deliver/slack-poster.ts";
import { inputStamps, type Stamp } from "../deliver/stamps.ts";
import type { RepoCode, RepoPreview } from "../lib/allowlists.ts";
import type { Output } from "../lib/job.ts";
import { readMediaFile, type MediaManifest } from "../lib/media.ts";
import { firstLine } from "../lib/problem.ts";
import {
  checkPatchSet,
  proposedMedia,
  resultLines,
  type CheckContext,
  type CheckResult,
  type ProposedMedia,
  type ProposedPage,
} from "../output-check/pr.ts";
import { prOutputContext } from "../output-check/report.ts";
import { untrustedToolList, type UntrustedInputRecord } from "./input-gate.ts";
import type { PrNotify } from "./load.ts";
import type { Published } from "./publish-script.ts";
import type { PrSection } from "../deliver/pr-sections.ts";
import { PAGES_ON_DEMAND_FILE, readPagesOnDemand } from "./pages-on-demand.ts";
import type { ReportWriter } from "./report.ts";
import {
  citationProblems,
  citedFiles,
  type CitedFile,
  type CitedFileReader,
} from "./review-files.ts";
import { attributionProblems } from "./attribution.ts";
import { creditedCommits, type GithubJsonReader } from "./review-commits.ts";
import {
  buildReviewInput,
  fitReviewInput,
  mergeVerdicts,
  reviewFolder,
  type ReviewInput,
  type ReviewVerdict,
} from "./review.ts";
import {
  escapeMrkdwn,
  footerBlock,
  type SlackMessage,
} from "./slack-render.ts";

/** What happened to a pull request job's answer after it passed the schema and the quotes. */
export interface DeliveryRecord {
  /**
   * nothing: every page was no_change. report_only: kept in the report
   * because the model saw untrusted text or the second check rejected it.
   * shadow: a shadow or stub run, which opens nothing. delivered:
   * pull requests were opened or updated.
   */
  outcome: "nothing" | "report_only" | "shadow" | "delivered";
  reason?: string;
  /** The branch delivery writes, agent/<job>/<YYYY-MM-DD>. */
  branch?: string;
  pages?: { repo: string; path: string; changedLines: number }[];
  /** Media files the pull request writes; left out when there are none. */
  media?: { repo: string; path: string; file: string; sha256: string }[];
  /** Pages whose only change is a stamp the job's code set; left out when there are none. */
  stamped?: { repo: string; path: string }[];
  /** Pages left out of delivery: the PR checker or the second check found a problem on them; the other pages went on. */
  dropped?: DroppedPage[];
  /** Changes the second check refused, which the job's code left out of their pages before it checked the rest again (output.drop_refused_changes). */
  droppedChanges?: DroppedChange[];
  /** The second check's verdict, when it ran; the last one when it ran again without the changes its rejection named. */
  review?: {
    verdict: ReviewVerdict["verdict"];
    reasons: number;
    /** Set when the check rejected only some pages: how many it left out, and how many it approved. */
    leftOut?: number;
    approved?: number;
    /** Set when it checked the answer again without the changes it refused first: how many were left out. */
    changesLeftOut?: number;
  };
  pulls?: DeliveredPull[];
  /** A revision: the commit pushed onto the pull request's branch, when a page changed, and the check run on it. */
  revision?: {
    repo: string;
    branch: string;
    commit?: string;
    check?: CheckRecord;
  };
  /** The notice about the pull requests a live run opened, posted to output.notify, or a shadow run's to the shadow channel. */
  notice?: PostedMessage;
  /** What went wrong after delivery, such as revoking the writer token or posting the notice. */
  problems?: string[];
}

/** A page left out of delivery, and why. */
export interface DroppedPage {
  repo: string;
  path: string;
  by: "pr-check" | "citation-check" | "attribution-check" | "second-check";
  problems: string[];
}

/** A change left out of its page because the second check refused it, and why. */
export interface DroppedChange {
  repo: string;
  path: string;
  /** Its number on the page in the second check's input, from 1. */
  change: number;
  /** What it was: the writer's why, else its first added line. */
  what: string;
  problems: string[];
}

/** A change a rejection named: its page, its number there, its lines and the reasons that name it. */
export interface RefusedChange {
  repo: string;
  path: string;
  change: number;
  removed: string[];
  added: string[];
  why?: string;
  reasons: string[];
}

export interface PrStageOptions {
  job: string;
  /** repos.yml's preview instructions, by repository, for the pull request body. */
  previews?: Readonly<Record<string, RepoPreview>>;
  /** repos.yml's code settings, by repository, for a job with output.code_fix. */
  repoCode?: Readonly<Record<string, RepoCode>>;
  output: Extract<Output, { kind: "pr" }>;
  mode: "shadow" | "live";
  stub: boolean;
  answer: unknown;
  input: unknown;
  /** The job's prompt.md: the rules the second check holds the proposal to. */
  jobPrompt: string;
  untrusted: UntrustedInputRecord;
  model: string;
  runName: string;
  runUrl?: string;
  report: ReportWriter;
  now: Date;
  /** The second check: a fresh model call that sees only the review input. Not called for an answer the job's code built; called once per input when the input is split per page. */
  review(
    input: ReviewInput,
  ): Promise<{ verdict: ReviewVerdict } | { error: string }>;
  /** Called once the second check's calls are done, so the run can close its model access before delivery. */
  reviewDone?(): Promise<void>;
  /**
   * output.drop_refused_changes: the job's code rebuilds the answer without
   * the changes a rejection refused, for the second check to check once
   * more. Called at most once, never in a revision.
   */
  dropRefused?(refused: readonly RefusedChange[]): Promise<Published>;
  /** Why the run cannot pay for another second check, or undefined when it can; asked before checking a rebuilt answer. */
  reviewBudget?(): Promise<string | undefined>;
  /** Reads a cited file at a commit for the second check; without it the second check sees only the sources. */
  readCitedFile?: CitedFileReader;
  /** Reads GitHub's commits and pull requests for the second check; without it the second check gets no credited commits. */
  readGithub?: GithubJsonReader;
  /** The answer was built by the job's code (model: none): its lines need no evidence and there is no second check. */
  builtByCode?: boolean;
  /** The job's publish.ts built the answer from the model's: it is checked like a model's, and the pull request says it adds to the page. */
  published?: boolean;
  /** The run's checked media and the job's media.pr_paths, when the job may write media files into its pull request. */
  media?: { dir: string; manifest: MediaManifest; paths: readonly string[] };
  /** Makes the writer for these repositories; only live, real runs call it. */
  openWriter(repos: readonly string[]): Promise<OpenedWriter>;
  /** A revision of an open pull request: its branch is written, forward from its head, and no pull request is opened or closed. */
  revision?: { branch: string; round: number };
  /** What the run's model calls cost; read when delivery starts, after the second check. */
  costUsd?: () => number | undefined;
  /** output.notify's channel, the shadow channel and the prefixes the notice may link to; no notice when not set. */
  notify?: PrNotify;
  /** Makes the Slack poster for the notice; stub runs never call it. */
  openPoster?(): Promise<OpenedPoster>;
  /** output.branch_key: the run's key; its pull request is agent/<job>/<key>, and the job's pull requests of other keys stay as they are. Never set in a revision. */
  branchKey?: string;
  /** Sections the job's publish.ts wrote for the pull request body. */
  sections?: readonly PrSection[];
  /** output.pages_on_demand: reads the pages a patch names that the input did not give; without readers (a stub run) nothing is read. */
  pagesOnDemand?: {
    paths: readonly string[];
    read?: CitedFileReader;
    json?: GithubJsonReader;
  };
  /** output.tool_citations: the tools a quote may name and, in a real run, what they returned. */
  toolQuotes?: CheckContext["toolQuotes"];
}

export type PrStageResult = { record: DeliveryRecord; failure?: string };

function slug(repo: string): string {
  return repo.replace("/", "-");
}

/** The check run line of a pull request kept in the report. */
function checkLine(c: Omit<CheckRecord, "head">): string {
  return `Check run, when opened: \`${c.name}\`, ${c.conclusion ?? c.status}: ${c.title}.`;
}

/** The reviewers line of a pull request kept in the report. */
function reviewLine(people: readonly string[], team: string | undefined) {
  const names = reviewerNames(people, team);
  return names.length === 0
    ? "Review requests: none."
    : `Review requests, when opened: ${names.map((n) => `\`${n}\``).join(", ")}.`;
}

const pageId = (p: { repo: string; path: string }) => `${p.repo}/${p.path}`;

/**
 * Why the PR checker's result fails the run, or undefined when delivery
 * can go on without the pages it found a problem on. A problem with the
 * answer as a whole fails it, and so does a page problem in a revision
 * (its replies would describe changes that are not pushed) or one that
 * leaves no patch to deliver.
 */
function checkFailure(
  check: CheckResult,
  revision: boolean,
  file = "pr-check.json",
) {
  if (check.ok) return undefined;
  const lines = resultLines(check);
  const failure = `the answer fails the PR checker (${lines.length} problem${lines.length === 1 ? "" : "s"}; first: ${lines[0] ?? "none named"}); see ${file}`;
  if (check.problems.length > 0 || revision) return failure;
  if (!check.pages.some((p) => p.ok && p.decision === "patch"))
    return `${failure}; no page with a patch is left to deliver`;
  return undefined;
}

/**
 * The pages a rejection rejects, with its reasons for each, when every
 * reason names a proposed page and at least one proposed page is not
 * named; otherwise undefined, and the rejection holds for the whole
 * proposal.
 */
function rejectedPages(
  verdict: ReviewVerdict,
  pages: readonly ProposedPage[],
): Map<string, string[]> | undefined {
  if (verdict.verdict !== "reject") return undefined;
  const proposed = new Set(
    pages.filter((p) => p.decision === "patch").map(pageId),
  );
  const named = new Map<string, string[]>();
  for (const r of verdict.reasons) {
    const id = `${r.repo}/${r.path}`;
    if (r.repo === undefined || r.path === undefined || !proposed.has(id))
      return undefined;
    named.set(id, [...(named.get(id) ?? []), r.text]);
  }
  return named.size < proposed.size ? named : undefined;
}

/**
 * The changes a rejection refuses, when every reason names a proposed page
 * and a change on it (by its number in the second check's input);
 * otherwise undefined, and the rejection is judged by page as before.
 */
export function refusedChanges(
  verdict: ReviewVerdict,
  pages: readonly ProposedPage[],
): RefusedChange[] | undefined {
  if (verdict.verdict !== "reject") return undefined;
  const named = new Map<string, RefusedChange>();
  for (const r of verdict.reasons) {
    const page = pages.find(
      (p) => p.decision === "patch" && p.repo === r.repo && p.path === r.path,
    );
    const change =
      r.change === undefined ? undefined : page?.changes?.[r.change - 1];
    if (page === undefined || change === undefined) return undefined;
    const key = `${pageId(page)}#${r.change}`;
    const got = named.get(key) ?? {
      repo: page.repo,
      path: page.path,
      change: r.change!,
      removed: [...change.removed],
      added: [...change.added],
      ...(change.why === undefined ? {} : { why: change.why }),
      reasons: [],
    };
    got.reasons.push(r.text);
    named.set(key, got);
  }
  return named.size === 0 ? undefined : [...named.values()];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The steps after a pull request job's answer passed its schema and its
 * quotes: the PR checker, then the plan, the untrusted-input gate, the
 * second check, and delivery. A page the PR checker finds a problem on is
 * left out and the rest goes on; a problem with the answer as a whole
 * fails the run. A rejection by the second check that names pages leaves
 * them out and delivers the rest. For a job with
 * output.drop_refused_changes, a first rejection whose every reason names a
 * change has the job's code rebuild the answer without those changes, and
 * the rebuilt answer goes through the checks and the second check once
 * more. Any other rejection, like the gate, turns delivery into a report
 * and never fails the run. Shadow and
 * stub runs go through every step but delivery, and keep what they would
 * have opened in the report.
 */
export async function runPrStage(o: PrStageOptions): Promise<PrStageResult> {
  const context = prOutputContext(
    o.output,
    o.input,
    o.media === undefined
      ? undefined
      : { paths: o.media.paths, files: o.media.manifest.files },
    o.repoCode,
  );
  if ("error" in context)
    return {
      record: { outcome: "report_only", reason: context.error },
      failure: `the run's input has no pages for the PR checker: ${context.error}`,
    };
  if (o.builtByCode === true) context.builtByCode = true;
  if (o.toolQuotes !== undefined) context.toolQuotes = o.toolQuotes;
  if (o.pagesOnDemand !== undefined) {
    const onDemand = await readPagesOnDemand({
      answer: o.answer,
      pinned: context.pinned,
      repos: o.output.repos,
      paths: o.pagesOnDemand.paths,
      ...(o.pagesOnDemand.read === undefined
        ? {}
        : { read: o.pagesOnDemand.read }),
      ...(o.pagesOnDemand.json === undefined
        ? {}
        : { json: o.pagesOnDemand.json }),
    });
    o.report.writeJson(PAGES_ON_DEMAND_FILE, onDemand);
    if (onDemand.pages.length > 0)
      context.pinned = [...context.pinned, ...onDemand.pages];
  }
  let sections = o.sections;
  const check = checkPatchSet(o.answer, context);
  o.report.writeJson("pr-check.json", check);
  const dropped: DroppedPage[] = check.pages
    .filter((p) => !p.ok)
    .map((p) => ({
      repo: p.repo,
      path: p.path,
      by: "pr-check",
      problems: p.problems,
    }));
  const failure = checkFailure(check, o.revision !== undefined);
  if (failure !== undefined)
    return {
      record: {
        outcome: "report_only",
        reason: "the PR checker rejected the answer",
        ...(dropped.length === 0 ? {} : { dropped }),
      },
      failure,
    };
  const stamps = inputStamps(o.input, context.policy);
  if ("error" in stamps)
    return {
      record: { outcome: "report_only", reason: stamps.error },
      failure: `the run's input has stamps delivery cannot apply: ${stamps.error}`,
    };
  const media = proposedMedia(o.answer);
  if ("error" in media)
    return {
      record: { outcome: "report_only", reason: media.error },
      failure: media.error,
    };
  let pages = (o.answer as { pages: ProposedPage[] }).pages;
  let built = planWithout(o, context, pages, media, stamps.stamps, dropped);
  if ("error" in built.plan)
    return {
      record: { outcome: "report_only", reason: built.plan.error },
      failure: built.plan.error,
    };
  let plan: DeliveryPlan = built.plan;
  pages = built.pages;
  const record: DeliveryRecord = { outcome: "nothing" };
  const describe = () => {
    record.branch = plan.branch;
    record.pages = plan.repos.flatMap((r) =>
      r.files.map((f) => ({
        repo: r.repo,
        path: f.path,
        changedLines: f.changedLines,
      })),
    );
    const stamped = plan.repos.flatMap((r) =>
      r.stamped.map((s) => ({ repo: r.repo, path: s.path })),
    );
    if (stamped.length > 0) record.stamped = stamped;
    else delete record.stamped;
    const planned = plan.repos.flatMap((r) =>
      (r.media ?? []).map((m) => ({
        repo: r.repo,
        path: m.path,
        file: m.file.path,
        sha256: m.file.sha256,
      })),
    );
    if (planned.length > 0) record.media = planned;
    else delete record.media;
    if (dropped.length > 0) record.dropped = dropped;
  };
  describe();
  if (plan.repos.length === 0) {
    record.reason =
      stamps.stamps.length === 0
        ? "every page is no_change"
        : "every page is no_change and no stamp applies";
    return { record };
  }

  const seen = untrustedToolList(o.untrusted);
  if (o.untrusted.seen && o.output.untrusted_input === "report_only") {
    record.outcome = "report_only";
    record.reason = `the model saw untrusted text (from ${seen.join(", ")}) and the job delivers such runs as a report (untrusted_input: report_only)`;
    return { record };
  }

  // Stamps alone are the job's code, not the model's: there is nothing for a second check to judge.
  let reviewReasons: string[] = [];
  let attributionChecked = false;
  let secondCheck: DeliveryMeta["secondCheck"];
  const droppedChanges: DroppedChange[] = [];
  if (o.builtByCode !== true && plan.repos.some((r) => r.files.length > 0)) {
    // Each cited file is read once, for the citation check and the second check alike.
    const reads = new Map<string, Promise<string | undefined>>();
    const read: CitedFileReader | undefined =
      o.readCitedFile === undefined
        ? undefined
        : (repo, commit, path) => {
            const key = `${repo}@${commit}:${path}`;
            let got = reads.get(key);
            if (got === undefined) {
              got = o.readCitedFile!(repo, commit, path);
              reads.set(key, got);
            }
            return got;
          };
    // Each GitHub path is read once, for the attribution check and the second check alike.
    const githubReads = new Map<string, Promise<unknown>>();
    const readGithub: GithubJsonReader | undefined =
      o.readGithub === undefined
        ? undefined
        : (path) => {
            let got = githubReads.get(path);
            if (got === undefined) {
              got = o.readGithub!(path);
              githubReads.set(path, got);
            }
            return got;
          };
    const replan = (): { error: string } | undefined => {
      built = planWithout(o, context, pages, media, stamps.stamps, dropped);
      if ("error" in built.plan) return built.plan;
      plan = built.plan;
      pages = built.pages;
      describe();
      return undefined;
    };
    const planFailure = (error: string): PrStageResult => ({
      record: { ...record, outcome: "report_only", reason: error },
      failure: error,
    });
    let calls = 0;
    try {
      // A second round checks the answer the job's code rebuilt without the changes the first refused (output.drop_refused_changes).
      for (let round = 1; ; round++) {
        const folder = round === 1 ? "review" : "recheck";
        let cited: CitedFile[] | undefined;
        if (read !== undefined) {
          cited = await citedFiles(pages, context, read);
          // A page citing a file that is not at its commit, or a line past its end, is left out before any model judges it.
          const disproved = citationProblems(pages, context, cited);
          if (disproved.size > 0) {
            for (const page of pages)
              if (disproved.has(pageId(page)))
                dropped.push({
                  repo: page.repo,
                  path: page.path,
                  by: "citation-check",
                  problems: disproved.get(pageId(page))!,
                });
            const error = replan();
            if (error !== undefined) return planFailure(error.error);
            if (!plan.repos.some((r) => r.files.length > 0)) {
              record.reason =
                "every changed page cites a file or line that is not there; none reached the second check";
              return { record };
            }
            cited = await citedFiles(pages, context, read);
          }
        }
        if (o.output.attribution_check === true && readGithub !== undefined) {
          attributionChecked = true;
          // A page crediting a change to a commit or pull request that did not make it, or dating it wrong, is left out before any model judges it.
          const wrong = await attributionProblems(pages, context, readGithub);
          if (wrong.size > 0) {
            for (const page of pages)
              if (wrong.has(pageId(page)))
                dropped.push({
                  repo: page.repo,
                  path: page.path,
                  by: "attribution-check",
                  problems: wrong.get(pageId(page))!,
                });
            const error = replan();
            if (error !== undefined) return planFailure(error.error);
            if (!plan.repos.some((r) => r.files.length > 0)) {
              record.reason =
                "every changed page credits a change the attribution check could not confirm; none reached the second check";
              return { record };
            }
            if (read !== undefined)
              cited = await citedFiles(pages, context, read);
          }
        }
        const reviewInput = buildReviewInput(
          pages,
          context,
          o.jobPrompt,
          sections,
        );
        if (cited !== undefined) reviewInput.cited_files = cited;
        if (readGithub !== undefined) {
          const commits = await creditedCommits(pages, context, readGithub);
          if (commits.length > 0) reviewInput.credited_commits = commits;
        }
        // Too big for one review: trimmed, or reviewed one page (or one part of a page's credited commits) at a time.
        const fitted = fitReviewInput(reviewInput);
        if (fitted.inputs.length !== 1 || fitted.tooBig.length > 0)
          o.report.writeJson(`${folder}/split.json`, {
            reviews: fitted.inputs.map((i, n) => ({
              input: `${reviewFolder(calls + n + 1)}/input.json`,
              pages: i.proposal.map((p) => `${p.repo}/${p.path}`),
              ...(i.part?.credits === undefined
                ? {}
                : {
                    credits: {
                      part: i.part.credits.part,
                      of: i.part.credits.of,
                      commits: i.credited_commits?.length ?? 0,
                    },
                  }),
            })),
            too_big: fitted.tooBig,
          });
        const verdicts: ReviewVerdict[] = [];
        let reviewError: string | undefined;
        for (const input of fitted.inputs) {
          calls += 1;
          const one = await o.review(input);
          if ("error" in one) {
            reviewError = one.error;
            break;
          }
          verdicts.push(one.verdict);
        }
        if (reviewError !== undefined)
          return {
            record: { ...record, outcome: "report_only", reason: reviewError },
            failure: `the second check gave no verdict: ${reviewError}`,
          };
        const verdict = mergeVerdicts(verdicts, fitted.tooBig);
        o.report.writeJson(`${folder}/verdict.json`, verdict);

        // A rejection whose every reason names a change, for a job that opts in: its code rebuilds the answer without them, checked once more.
        const refused =
          round === 1 && o.dropRefused !== undefined && o.revision === undefined
            ? refusedChanges(verdict, pages)
            : undefined;
        if (refused !== undefined) {
          const n = plural(refused.length, "change", "changes");
          const leftOut = refused.map((c): DroppedChange => ({
            repo: c.repo,
            path: c.path,
            change: c.change,
            what: c.why ?? c.added.find((l) => l.trim() !== "") ?? "a change",
            problems: c.reasons,
          }));
          const nothing = (why: string): PrStageResult => {
            record.droppedChanges = leftOut;
            record.review = {
              verdict: verdict.verdict,
              reasons: verdict.reasons.length,
            };
            record.outcome = "report_only";
            record.reason = `the second check refused ${n} and ${why}; its reasons are in review/verdict.json`;
            return { record };
          };
          const short = await o.reviewBudget?.();
          if (short !== undefined)
            return nothing(`the rest is not checked again: ${short}`);
          let rebuilt: Published;
          try {
            rebuilt = await o.dropRefused!(refused);
          } catch (err) {
            return planFailure(
              `rebuilding the answer without the changes the second check refused failed: ${firstLine(err)}`,
            );
          }
          o.report.writeJson("recheck/publish.json", rebuilt);
          if (!rebuilt.publish)
            return nothing(
              `the job's code publishes nothing without them: ${rebuilt.reason}`,
            );
          if (rebuilt.sections !== undefined) sections = rebuilt.sections;
          const again = checkPatchSet(rebuilt.answer, context);
          o.report.writeJson("recheck/pr-check.json", again);
          const failure = checkFailure(again, false, "recheck/pr-check.json");
          if (failure !== undefined)
            return {
              record: {
                ...record,
                droppedChanges: leftOut,
                outcome: "report_only",
                reason:
                  "the PR checker rejected the answer rebuilt without the changes the second check refused",
              },
              failure,
            };
          const out = new Set(dropped.map(pageId));
          for (const p of again.pages)
            if (!p.ok && !out.has(pageId(p)))
              dropped.push({
                repo: p.repo,
                path: p.path,
                by: "pr-check",
                problems: p.problems,
              });
          pages = (rebuilt.answer as { pages: ProposedPage[] }).pages;
          const error = replan();
          if (error !== undefined) return planFailure(error.error);
          droppedChanges.push(...leftOut);
          record.droppedChanges = droppedChanges;
          if (!plan.repos.some((r) => r.files.length > 0))
            return nothing("no page is left to check again");
          continue;
        }

        // A rejection whose every reason names a proposed page rejects those pages only: the rest are approved.
        const rejected =
          o.revision === undefined ? rejectedPages(verdict, pages) : undefined;
        if (rejected !== undefined) {
          for (const page of pages)
            if (rejected.has(pageId(page)))
              dropped.push({
                repo: page.repo,
                path: page.path,
                by: "second-check",
                problems: rejected.get(pageId(page))!,
              });
          const error = replan();
          if (error !== undefined) return planFailure(error.error);
        }
        record.review = {
          verdict: verdict.verdict,
          reasons: verdict.reasons.length,
          ...(rejected === undefined
            ? {}
            : {
                leftOut: dropped.filter((d) => d.by === "second-check").length,
                approved: pages.filter((p) => p.decision === "patch").length,
              }),
          ...(droppedChanges.length === 0
            ? {}
            : { changesLeftOut: droppedChanges.length }),
        };
        if (verdict.verdict === "reject" && rejected === undefined) {
          record.outcome = "report_only";
          record.reason =
            droppedChanges.length === 0
              ? "the second check rejected the proposal; its reasons are in review/verdict.json"
              : `the second check rejected the proposal again without the ${plural(droppedChanges.length, "change", "changes")} it refused; its reasons are in review/verdict.json and recheck/verdict.json`;
          return { record };
        }
        reviewReasons =
          rejected === undefined
            ? verdict.reasons.map((r) => r.text)
            : [
                "It rejected only the pages left out of this pull request and raised nothing about the others.",
              ];
        secondCheck =
          rejected !== undefined
            ? "approved without the pages left out"
            : droppedChanges.length > 0
              ? "approved without the changes left out"
              : "approved";
        break;
      }
    } finally {
      await o.reviewDone?.();
    }
  }

  const meta: DeliveryMeta = {
    model: o.model,
    runName: o.runName,
    ...(o.runUrl === undefined ? {} : { runUrl: o.runUrl }),
    untrustedTools: seen,
    reviewReasons,
    ...(attributionChecked ? { attributionChecked } : {}),
    leftOut: dropped.map((d) => ({
      repo: d.repo,
      path: d.path,
      why: d.problems[0] ?? "failed the checks",
    })),
    ...(droppedChanges.length === 0
      ? {}
      : {
          leftOutChanges: droppedChanges.map((d) => ({
            repo: d.repo,
            path: d.path,
            what: d.what,
            why: d.problems.join(" "),
          })),
        }),
    sourceTitles: sourceTitles(o.input),
    ...(o.previews === undefined ? {} : { previews: o.previews }),
    ...(o.builtByCode === true ? { builtByCode: true } : {}),
    ...(o.published === true ? { published: true } : {}),
    ...(secondCheck === undefined ? {} : { secondCheck }),
    ...(sections === undefined ? {} : { sections }),
    ...(context.policy.codeFix === undefined ? {} : { codeFix: true }),
  };
  const cost = o.costUsd?.();
  if (cost !== undefined) meta.costUsd = cost;
  const day = o.now.toISOString().slice(0, 10);
  const noun = context.policy.codeFix === undefined ? "page" : "file";
  for (const repo of o.revision === undefined ? plan.repos : [])
    o.report.write(
      `delivery/${slug(repo.repo)}.md`,
      `# ${pullTitle(o.job, repo, day, plan.key, noun)}\n\n${reviewLine(repo.reviewers, context.policy.reviewTeam)}\n\n${checkLine(plannedCheck(repo.repo, o.job, pullCheck(repo, meta)))}\n\n${pullBody(o.job, repo, meta, plan.branch, autoMergeDecision(context.policy.autoMergePaths, plannedPaths(repo)))}`,
    );
  o.report.writeJson(
    "delivery/plan.json",
    plan.repos.map((r) => ({
      repo: r.repo,
      base: r.base,
      branch: plan.branch,
      files: r.files.map((f) => ({ path: f.path, lines: f.after })),
      stamped: r.stamped.map((s) => ({ path: s.path, stamps: s.stamps })),
      reviewers: reviewerNames(r.reviewers, context.policy.reviewTeam),
      check: plannedCheck(r.repo, o.job, pullCheck(r, meta)),
      media: (r.media ?? []).map((m) => ({
        path: m.path,
        file: m.file.path,
        sha256: m.file.sha256,
        bytes: m.file.bytes,
      })),
    })),
  );
  if (o.stub || o.mode === "shadow") {
    record.outcome = "shadow";
    record.reason = o.stub
      ? "a stub run opens no pull request"
      : "a shadow run opens no pull request; delivery/ holds what it would open";
    if (o.revision === undefined)
      await postNotice(
        o,
        record,
        plan.repos.map((r) => ({
          repo: r.repo,
          title: pullTitle(o.job, r, day, plan.key, noun),
          merged:
            autoMergeDecision(context.policy.autoMergePaths, plannedPaths(r))
              ?.merge === true,
        })),
      );
    return { record };
  }

  let opened: OpenedWriter;
  try {
    opened = await o.openWriter(plan.repos.map((r) => r.repo));
  } catch (err) {
    return {
      record: { ...record, outcome: "report_only", reason: firstLine(err) },
      failure: `the pull request writer could not start: ${firstLine(err)}`,
    };
  }
  o.report.addSecrets(opened.secrets);
  if ((opened.missing ?? []).length > 0)
    record.problems = [
      `the writer app's installation has not accepted ${opened.missing!.join(" and ")} yet, so no check run is written and team review requests are refused`,
    ];
  try {
    if (o.revision !== undefined) {
      const pushed = await deliverRevision(
        plan,
        context.policy,
        opened.writer,
        { runName: o.runName, round: o.revision.round },
        o.now,
      );
      const revised = plan.repos[0];
      record.revision = {
        repo: revised?.repo ?? "",
        branch: plan.branch,
        ...(pushed === undefined ? {} : { commit: pushed.commit }),
      };
      if (pushed !== undefined && revised !== undefined)
        record.revision.check = await writeCheck(
          opened.writer,
          {
            repo: revised.repo,
            job: o.job,
            branch: plan.branch,
            head: pushed.commit,
          },
          pullCheck(revised, meta),
        );
      record.outcome = "delivered";
      return { record };
    }
    const mediaDir = o.media?.dir;
    record.pulls = await deliverPlan(
      plan,
      context.policy,
      opened.writer,
      meta,
      o.now,
      mediaDir === undefined
        ? undefined
        : (file) => readMediaFile(mediaDir, file),
    );
    record.outcome = "delivered";
  } catch (err) {
    return {
      record: { ...record, outcome: "report_only", reason: firstLine(err) },
      failure: `delivering the pull request failed: ${firstLine(err)}`,
    };
  } finally {
    await opened.close().catch((err: unknown) => {
      record.problems = [
        `revoking the writer token failed: ${firstLine(err)}; it expires within the hour`,
      ];
    });
  }
  const fresh = (record.pulls ?? []).filter((p) => !p.updated);
  await postNotice(
    o,
    record,
    fresh.map((p) => {
      const repo = plan.repos.find((r) => r.repo === p.repo);
      return {
        repo: p.repo,
        title:
          repo === undefined
            ? o.job
            : pullTitle(o.job, repo, day, plan.key, noun),
        number: p.number,
        url: p.url,
        merged: p.autoMerge?.merged === true,
      };
    }),
  );
  return { record };
}

/** A pull request the notice names: one a live run opened, or one a shadow run would open. */
interface NoticePull {
  repo: string;
  title: string;
  number?: number;
  url?: string;
  merged: boolean;
}

/** The notice: one line per pull request, and the footer. */
function noticeMessage(o: PrStageOptions, pulls: readonly NoticePull[]) {
  const lines = pulls.map((p) => {
    const what = p.merged ? "opened and merged" : "opened";
    const review = p.merged ? "" : " for review";
    const ref = p.number === undefined ? undefined : `${p.repo}#${p.number}`;
    return {
      mrkdwn:
        p.url === undefined
          ? `*${o.job}* ${what} a pull request on ${p.repo}${review}: ${escapeMrkdwn(p.title)}`
          : `*${o.job}* ${what} <${p.url}|${ref}>${review}: ${escapeMrkdwn(p.title)}`,
      text:
        p.url === undefined
          ? `${o.job} ${what} a pull request on ${p.repo}${review}: ${p.title}`
          : `${o.job} ${what} ${ref}${review}: ${p.url}`,
    };
  });
  const message: SlackMessage = {
    text: lines.map((l) => l.text).join("; "),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.map((l) => l.mrkdwn).join("\n") },
      },
      footerBlock({ runUrl: o.runUrl, job: o.job, model: o.model }),
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
  return message;
}

/**
 * Tells output.notify about the pull requests a live run opened, never
 * one it only updated. A shadow run posts what it would post to the
 * shadow channel, under the shadow line, or nothing when channels.yml
 * gives that channel no id; a stub run posts nothing.
 * delivery/pr-notice.json keeps the exact body. A notice that cannot be
 * posted is recorded in problems and never fails the run.
 */
async function postNotice(
  o: PrStageOptions,
  record: DeliveryRecord,
  pulls: readonly NoticePull[],
): Promise<void> {
  const notify = o.notify;
  if (notify === undefined || pulls.length === 0) return;
  const cleaned = cleanMessage(noticeMessage(o, pulls), {
    prefixes: notify.links,
    exact: [
      ...(o.runUrl === undefined ? [] : [o.runUrl]),
      ...pulls.flatMap((p) => (p.url === undefined ? [] : [p.url])),
    ],
  });
  const shadow = o.mode === "shadow";
  const message = shadow
    ? shadowMessage(cleaned.message, o.job, notify.channel.name)
    : cleaned.message;
  const channel = shadow ? notify.shadow : notify.channel;
  o.report.writeJson("delivery/pr-notice.json", {
    channel: channel?.id ?? null,
    text: message.text,
    blocks: message.blocks,
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (o.stub || channel === undefined) return;
  const problem = (why: string) => {
    record.problems = [...(record.problems ?? []), why];
  };
  const tooBig = postProblem(message);
  if (tooBig !== undefined)
    return problem(`the notice breaks Slack's limits: ${tooBig}`);
  if (channel.id === undefined)
    return problem(`#${channel.name} has no id in channels.yml`);
  if (o.openPoster === undefined)
    return problem(`no Slack poster for the notice to #${channel.name}`);
  try {
    const poster = await o.openPoster();
    o.report.addSecrets(poster.secrets);
    record.notice = await poster.poster.post(channel.id, message);
  } catch (err) {
    problem(`the notice to #${channel.name} failed: ${firstLine(err)}`);
  }
}

/** The plan for the answer's pages without the dropped ones: their patches are not delivered and no stamp is set on them. */
function planWithout(
  o: PrStageOptions,
  context: CheckContext,
  pages: readonly ProposedPage[],
  media: readonly ProposedMedia[],
  stamps: readonly Stamp[],
  dropped: readonly DroppedPage[],
): { pages: ProposedPage[]; plan: DeliveryPlan | { error: string } } {
  const out = new Set(dropped.map(pageId));
  const kept = pages.filter((p) => !out.has(pageId(p)));
  return {
    pages: kept,
    plan: planDelivery(
      o.job,
      { pages: kept, media },
      context,
      o.now,
      stamps.filter((s) => !out.has(pageId(s))),
      o.revision?.branch,
      o.revision === undefined ? o.branchKey : undefined,
    ),
  };
}

/** The titles of the input's sources, as repo@commit, so the pull request can name a cited commit's pull request. */
export function sourceTitles(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const sources =
    typeof input === "object" && input !== null
      ? (input as { sources?: unknown }).sources
      : undefined;
  if (!Array.isArray(sources)) return out;
  for (const src of sources) {
    if (typeof src !== "object" || src === null) continue;
    const { repo, commit, title } = src as Record<string, unknown>;
    if (
      typeof repo === "string" &&
      typeof commit === "string" &&
      typeof title === "string"
    )
      out[`${repo}@${commit}`] = title;
  }
  return out;
}
