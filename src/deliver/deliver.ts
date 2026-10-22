import { workspace } from "../lib/workspace.ts";
import type { RepoPreview } from "../lib/allowlists.ts";
import type { MediaFile } from "../lib/media.ts";
import { isPlainRelativePath, matchesAnyGlob } from "../output-check/glob.ts";
import { repoCitations, type PrPolicy } from "../output-check/pr.ts";
import {
  fileLines,
  fileText,
  type DeliveryPlan,
  type RepoPlan,
  type StampValue,
} from "./plan.ts";
import { firstLine } from "../lib/problem.ts";
import {
  code,
  commitLink,
  fileLink,
  imageUrl,
  plainList,
  plainText,
  previewSection,
  reviewingSection,
} from "./pr-text.ts";
import { renderSections, type PrSection } from "./pr-sections.ts";
import { applyStamps } from "./stamps.ts";
import {
  deliveryCheck,
  writeCheck,
  type CheckFields,
  type CheckRecord,
  type SecondCheckOutcome,
} from "./checks.ts";
import {
  commitAuthor,
  type CommitFile,
  isAgentBranch,
  isBranchKey,
  isWritableAgentBranch,
  jobBranchPrefix,
  keyedBranch,
  type OpenPull,
  type PrWriter,
} from "./writer.ts";

/** What the pull request says about the run behind it. */
export interface DeliveryMeta {
  model: string;
  runName: string;
  /** The workflow run's page, when the run is one. */
  runUrl?: string;
  /** The tools whose untrusted text the model saw; empty when none. */
  untrustedTools: readonly string[];
  /** The second check's reasons for approving (model text). */
  reviewReasons: readonly string[];
  /** The attribution check confirmed every credit on the delivered pages. */
  attributionChecked?: boolean;
  /** Pages left out because the PR checker or the second check found a problem on them, with the first problem. */
  leftOut?: readonly { repo: string; path: string; why?: string }[];
  /** Changes the second check refused, left out of their pages before it approved the rest: what each was, and its reasons. */
  leftOutChanges?: readonly {
    repo: string;
    path: string;
    what: string;
    why: string;
  }[];
  /** Cited commits' titles, as repo@sha, so a citation can name its pull request. */
  sourceTitles?: Readonly<Record<string, string>>;
  /** repos.yml's preview instructions, by repository. */
  previews?: Readonly<Record<string, RepoPreview>>;
  /** The job's code built the change (model: none). */
  builtByCode?: boolean;
  /** The job's publish.ts made the change from the model's answer: it adds to a page rather than correcting one. */
  published?: boolean;
  /** How the second check ended, when it ran. */
  secondCheck?: SecondCheckOutcome;
  /** What the run's model calls cost, read when delivery starts. */
  costUsd?: number;
  /** Sections the job's publish.ts wrote for the body, shown in order before Reviewing; none when not set. */
  sections?: readonly PrSection[];
  /** The job fixes code (output.code_fix): the body counts files, not pages. */
  codeFix?: boolean;
}

export interface DeliveredPull {
  repo: string;
  number: number;
  url: string;
  branch: string;
  commit: string;
  /** true when the branch already had an open pull request from an earlier run today, which now shows the new commit. */
  updated: boolean;
  /** Earlier open pull requests of this job, closed as replaced by this one. */
  replaced: number[];
  /** Who a new pull request asked to review, and whom GitHub refused; not set on an update. */
  reviews?: ReviewRequests;
  /** The ${workspace().displayName} check run on the pull request's new head commit. */
  check?: CheckRecord;
  /** Whether delivery merged it (output.auto_merge), and why not when it did not; not set without auto_merge. */
  autoMerge?: { merged: true; sha: string } | { merged: false; why: string };
}

/** What auto_merge decides for a pull request before it is opened: merge, or stay open and why. */
export type AutoMergeDecision = { merge: true } | { merge: false; why: string };

/** Merge only when every changed path matches one of the globs; undefined when the job sets no auto_merge. */
export function autoMergeDecision(
  globs: readonly string[] | undefined,
  paths: readonly string[],
): AutoMergeDecision | undefined {
  if (globs === undefined) return undefined;
  const outside = paths.filter((p) => !matchesAnyGlob(p, globs));
  if (outside.length === 0) return { merge: true };
  return {
    merge: false,
    why: `${outside.map(code).join(", ")} ${outside.length === 1 ? "is" : "are"} outside the paths it merges (${globs.map(code).join(", ")})`,
  };
}

/** Every path a repository's plan changes. */
export function plannedPaths(plan: RepoPlan): string[] {
  return [
    ...plan.files.map((f) => f.path),
    ...plan.stamped.map((s) => s.path),
    ...(plan.media ?? []).map((m) => m.path),
  ];
}

/** The review requests of a new pull request: people by login, the team as team:<slug>. */
export interface ReviewRequests {
  requested: string[];
  refused: { who: string; why: string }[];
}

const MAX_BODY_CHARS = 60_000;

function mediaCount(plan: RepoPlan): string {
  const m = plan.media?.length ?? 0;
  return m === 0 ? "" : `, ${m} media file${m === 1 ? "" : "s"}`;
}

export function pullTitle(
  job: string,
  plan: RepoPlan,
  day: string,
  key?: string,
  noun: "page" | "file" = "page",
): string {
  const n = plan.files.length;
  const stamped =
    plan.stamped.length === 0 ? "" : `, ${plan.stamped.length} stamped`;
  return `${job}: ${key === undefined ? "" : `${key}, `}${n} ${noun}${n === 1 ? "" : "s"}${stamped}${mediaCount(plan)} (${day})`;
}

function describeStamps(stamps: readonly StampValue[]): string {
  return stamps.map((s) => code(`${s.key}: ${s.value}`)).join(", ");
}

/** The completed check run a delivered pull request gets on its head commit, from the plan and the run. */
export function pullCheck(plan: RepoPlan, meta: DeliveryMeta): CheckFields {
  const citations = new Set<string>();
  let changes = 0;
  for (const file of plan.files)
    for (const change of file.changes) {
      changes++;
      for (const c of change.evidence) citations.add(JSON.stringify(c));
    }
  return deliveryCheck({
    pages: plan.files.map((f) => ({
      path: f.path,
      changedLines: f.changedLines,
    })),
    leftOut: (meta.leftOut ?? [])
      .filter((p) => p.repo === plan.repo)
      .map((p) => ({ path: p.path, why: p.why ?? "failed the checks" })),
    leftOutChanges: (meta.leftOutChanges ?? [])
      .filter((c) => c.repo === plan.repo)
      .map((c) => ({ path: c.path, what: c.what, why: c.why })),
    stamped: plan.stamped.length,
    media: plan.media?.length ?? 0,
    changes,
    citations: citations.size,
    ...(meta.secondCheck === undefined
      ? {}
      : { secondCheck: meta.secondCheck }),
    builtByCode: meta.builtByCode === true,
    ...(meta.costUsd === undefined ? {} : { costUsd: meta.costUsd }),
    ...(meta.runUrl === undefined ? {} : { runUrl: meta.runUrl }),
  });
}

/** How the second check ended, for the Checks row of the pull request body. */
function secondCheckWords(meta: DeliveryMeta): string {
  const n = (meta.leftOutChanges ?? []).length;
  return n === 0
    ? "second check approved"
    : `second check approved after the ${n === 1 ? "change" : `${n} changes`} it refused ${n === 1 ? "was" : "were"} left out`;
}

function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
}

/** Each changed image the job described, as the base has it beside the branch's, or the branch's alone when it is new. */
function beforeAndAfter(plan: RepoPlan, branch: string): string[] {
  const shown = (plan.media ?? []).filter(
    (m) => m.change !== undefined && isImage(m.path),
  );
  if (shown.length === 0) return [];
  const out = ["**Before and after**", ""];
  for (const m of shown) {
    const after = `![after](${imageUrl(plan.repo, branch, m.path)})`;
    out.push(
      code(m.path),
      "",
      ...(m.change!.before
        ? [
            "| Before | After |",
            "| --- | --- |",
            `| ![before](${imageUrl(plan.repo, plan.base, m.path)}) | ${after} |`,
          ]
        : ["| New |", "| --- |", `| ${after} |`]),
      "",
    );
  }
  return out;
}

/** The pull request body: written by the kit; text a model wrote appears only as escaped plain text. */
export function pullBody(
  job: string,
  plan: RepoPlan,
  meta: DeliveryMeta,
  branch: string,
  autoMerge?: AutoMergeDecision,
): string {
  const builtByCode = meta.builtByCode === true;
  const who =
    autoMerge === undefined
      ? "a person reviews and merges it."
      : autoMerge.merge
        ? "it is merged automatically, since every change is under the paths the job merges."
        : `a person reviews and merges it. Not merged automatically: ${autoMerge.why}.`;
  const repoName = plan.repo.split("/").pop() ?? plan.repo;
  const n = plan.files.length + plan.stamped.length;
  const m = (plan.media ?? []).filter((f) => isImage(f.path)).length;
  const other = (plan.media?.length ?? 0) - m;
  const parts = [
    ...(n > 0
      ? [`${n} ${meta.codeFix === true ? "file" : "page"}${n === 1 ? "" : "s"}`]
      : []),
    ...(m > 0 ? [`${m} image${m === 1 ? "" : "s"}`] : []),
    ...(other > 0 ? [`${other} other file${other === 1 ? "" : "s"}`] : []),
  ];
  const lines = [
    `Updates ${parts.length === 0 ? "nothing" : parts.join(" and ")} in ${code(repoName)}${builtByCode || meta.published === true || meta.codeFix === true || plan.files.length === 0 ? "" : " that no longer matched the code"}. Opened by the ${workspace().displayName} ${code(job)}; ${who}`,
    "",
    "**What changed and why**",
    "",
  ];
  for (const file of plan.files) {
    const head = `- ${fileLink(plan.repo, branch, file.path)}${file.created === true ? " (new file)" : ""}: ${plainText(file.reason)}`;
    if (builtByCode) {
      lines.push(head);
      continue;
    }
    const cited = new Map<string, string>();
    for (const change of file.changes)
      for (const c of repoCitations(change.evidence))
        if (c.commit !== undefined)
          cited.set(
            `${c.repo}@${c.commit}`,
            commitLink(
              c.repo,
              c.commit,
              meta.sourceTitles?.[`${c.repo}@${c.commit}`],
            ),
          );
    lines.push(
      cited.size === 0
        ? head
        : `${head} Source: ${[...new Set(cited.values())].join(", ")}.`,
    );
    if (file.stamps.length > 0)
      lines.push(`  The job's code also set ${describeStamps(file.stamps)}.`);
  }
  for (const media of plan.media ?? []) {
    lines.push(
      `- ${fileLink(plan.repo, branch, media.path)}: retaken by the run (${Math.max(1, Math.round(media.file.bytes / 1024))} KB), written byte for byte, never by a model.`,
    );
    for (const line of media.change?.lines ?? [])
      lines.push(`  - ${plainText(line)}`);
  }
  for (const stamped of plan.stamped)
    lines.push(
      `- ${fileLink(plan.repo, branch, stamped.path)}: the job's code set ${describeStamps(stamped.stamps)}.`,
    );
  for (const p of (meta.leftOut ?? []).filter((p) => p.repo === plan.repo))
    lines.push(
      `- Left out: ${code(p.path)}${p.why === undefined ? " failed the checks" : `: ${plainText(p.why)}`}`,
    );
  for (const c of (meta.leftOutChanges ?? []).filter(
    (c) => c.repo === plan.repo,
  ))
    lines.push(
      `- Left out of ${code(c.path)}, refused by the second check: ${plainText(c.what)} Why: ${plainText(c.why)}`,
    );
  lines.push("");
  lines.push(...beforeAndAfter(plan, branch));
  lines.push(
    ...previewSection(
      meta.previews?.[plan.repo],
      [...plan.files.map((f) => f.path), ...plan.stamped.map((f) => f.path)],
      branch,
    ),
  );
  lines.push(...renderSections(meta.sections ?? []));
  lines.push(...reviewingSection(builtByCode));
  const run =
    meta.runUrl === undefined
      ? code(meta.runName)
      : `[${meta.runName}](${meta.runUrl})`;
  lines.push(
    "<details><summary>Run details</summary>",
    "",
    "| | |",
    "| --- | --- |",
    `| Run | ${run} |`,
    `| Model | ${builtByCode ? "none" : code(meta.model)} |`,
    `| Base | ${code(plan.base.slice(0, 12))} |`,
    `| Untrusted input | ${meta.untrustedTools.length === 0 ? "none seen" : `seen, from ${meta.untrustedTools.map(code).join(", ")}; this job opens pull requests anyway`} |`,
    `| Checks | ${builtByCode ? "PR checker; the job's code built this change, so there was no second check" : meta.reviewReasons.length > 0 ? `schema, quotes, PR checker, ${meta.attributionChecked === true ? "attribution check, " : ""}${secondCheckWords(meta)}` : "schema, quotes, PR checker; no page changed, so there was no second check"} |`,
    "",
  );
  if ((plan.media ?? []).length > 0)
    lines.push(
      "Images, as the run's media stage made them (media.json in the run's report):",
      "",
      ...(plan.media ?? []).map(
        (m) =>
          `- ${code(m.path)}: ${m.file.bytes} bytes, sha256 ${code(m.file.sha256.slice(0, 12))}`,
      ),
      "",
    );
  if (meta.reviewReasons.length > 0)
    lines.push(
      "The second check saw only this change, its sources and the job's rules, and approved it:",
      "",
      ...plainList(meta.reviewReasons),
      "",
    );
  lines.push("</details>", "");
  const body = lines.join("\n");
  return body.length <= MAX_BODY_CHARS
    ? body
    : `${body.slice(0, MAX_BODY_CHARS)}\n\n(cut; the run's report has the rest)\n`;
}

export function commitMessage(job: string, plan: RepoPlan, runName: string) {
  const paths = plan.files.map((f) => f.path);
  const stamped = plan.stamped.map((s) => s.path);
  const media = (plan.media ?? []).map((m) => m.path);
  return [
    `${job}: ${paths.length} page${paths.length === 1 ? "" : "s"}${stamped.length === 0 ? "" : `, ${stamped.length} stamped`}${mediaCount(plan)}`,
    "",
    ...paths.map((p) => `- ${p}`),
    ...stamped.map((p) => `- ${p} (stamped)`),
    ...media.map((p) => `- ${p} (media)`),
    "",
    `Run: ${runName}`,
  ].join("\n");
}

function isOurs(pull: OpenPull, job: string): boolean {
  return (
    pull.sameRepo &&
    pull.byBot &&
    isAgentBranch(pull.branch) &&
    pull.branch.startsWith(jobBranchPrefix(job))
  );
}

/** The job's pull request of one key: its branch, by the writer app, in the repository. */
function isOurKey(pull: OpenPull, branch: string): boolean {
  return pull.sameRepo && pull.byBot && pull.branch === branch;
}

/** Why this plan may not be delivered under this policy, or undefined when it may. Checked again here, not only by the PR checker. */
export function planProblem(
  plan: DeliveryPlan,
  policy: PrPolicy,
): string | undefined {
  if (
    plan.key === undefined
      ? !isWritableAgentBranch(plan.branch) ||
        !plan.branch.startsWith(jobBranchPrefix(plan.job))
      : !isBranchKey(plan.key) ||
        plan.branch !== keyedBranch(plan.job, plan.key)
  )
    return `${plan.branch} is not a branch of ${plan.job}`;
  for (const repo of plan.repos) {
    if (!policy.repos.includes(repo.repo))
      return `${repo.repo} is not a repository this job may change`;
    for (const f of [...repo.files, ...repo.stamped]) {
      if (!isPlainRelativePath(f.path) || !matchesAnyGlob(f.path, policy.paths))
        return `${repo.repo}/${f.path} is outside the paths this job may change`;
      for (const s of f.stamps)
        if (!(policy.stampKeys ?? []).includes(s.key))
          return `${repo.repo}/${f.path}: ${s.key} is not a key this job's code may stamp`;
    }
    for (const m of repo.media ?? [])
      if (
        !isPlainRelativePath(m.path) ||
        !matchesAnyGlob(m.path, policy.mediaPaths ?? [])
      )
        return `${repo.repo}/${m.path} is outside the paths this job's media files may go`;
    const created = repo.files.filter((f) => f.created === true);
    for (const f of created)
      if (
        policy.newFiles === undefined ||
        !matchesAnyGlob(f.path, policy.newFiles.paths)
      )
        return `${repo.repo}/${f.path} is a new file outside the paths this job may create`;
    if (created.length > (policy.newFiles?.max ?? 0))
      return `${repo.repo}: ${created.length} new files, more than the ${policy.newFiles?.max ?? 0} this job may create`;
    const lines = repo.files.reduce((n, f) => n + f.changedLines, 0);
    if (lines > policy.maxChangedLines)
      return `${repo.repo}: ${lines} changed lines, more than the limit of ${policy.maxChangedLines}`;
  }
  return undefined;
}

/** The reviewers a new pull request asks for: the people, then the team, as review requests name them. */
export function reviewerNames(
  people: readonly string[],
  team: string | undefined,
): string[] {
  return [...people, ...(team === undefined ? [] : [`team:${team}`])];
}

/**
 * Asks each person and the team on its own, so one that GitHub refuses
 * (no access to the repository, not a member) leaves the others asked. A
 * refusal never fails delivery; it is recorded.
 */
export async function requestReviews(
  writer: PrWriter,
  repo: string,
  number: number,
  people: readonly string[],
  team: string | undefined,
): Promise<ReviewRequests> {
  const out: ReviewRequests = { requested: [], refused: [] };
  for (const who of reviewerNames(people, team)) {
    const slug = who.startsWith("team:") ? who.slice(5) : undefined;
    try {
      await writer.requestReviewers(
        repo,
        number,
        slug === undefined ? { reviewers: [who] } : { teamReviewers: [slug] },
      );
      out.requested.push(who);
    } catch (err) {
      out.refused.push({ who, why: firstLine(err) });
    }
  }
  return out;
}

/**
 * Delivers a plan as one pull request per repository: checks each
 * page in the repository at the base commit is exactly the page the run
 * checked, sets the stamps of pages whose only change is a stamp (read at
 * the base), commits the pages to the job's branch for the day,
 * opens a pull request (or, on a second run the same day, updates
 * the one already open on that branch), then closes the job's other open
 * pull requests in that repository as replaced and deletes their
 * branches. The previous pull request is closed only once the new one is
 * open. Media files are read through readMedia, which checks each one's
 * sha256 again, and committed with the pages.
 */
export async function deliverPlan(
  plan: DeliveryPlan,
  policy: PrPolicy,
  writer: PrWriter,
  meta: DeliveryMeta,
  now: Date,
  readMedia?: (file: MediaFile) => Buffer,
): Promise<DeliveredPull[]> {
  const problem = planProblem(plan, policy);
  if (problem !== undefined) throw new Error(problem);
  const day = now.toISOString().slice(0, 10);
  const out: DeliveredPull[] = [];
  for (const repo of plan.repos) {
    const files: CommitFile[] = [];
    for (const f of repo.files) {
      const current = await writer.readFile(repo.repo, repo.base, f.path);
      if (f.created === true) {
        if (current !== undefined)
          throw new Error(
            `${repo.repo}/${f.path} exists at ${repo.base.slice(0, 12)}, so the patch that creates it cannot be delivered`,
          );
        files.push({
          path: f.path,
          text: fileText(f.after, true),
          mode: "100644",
        });
        continue;
      }
      if (current === undefined)
        throw new Error(
          `${repo.repo}/${f.path} does not exist at ${repo.base.slice(0, 12)}`,
        );
      const { lines, finalNewline } = fileLines(current.text);
      if (lines.join("\n") !== f.before.join("\n"))
        throw new Error(
          `${repo.repo}/${f.path} at ${repo.base.slice(0, 12)} is not the page the run was given, so its checked patch cannot be delivered`,
        );
      files.push({
        path: f.path,
        text: fileText(f.after, finalNewline),
        mode: current.mode,
      });
    }
    for (const s of repo.stamped) {
      const current = await writer.readFile(repo.repo, repo.base, s.path);
      if (current === undefined)
        throw new Error(
          `${repo.repo}/${s.path} does not exist at ${repo.base.slice(0, 12)}`,
        );
      const { lines, finalNewline } = fileLines(current.text);
      if (s.before !== undefined && lines.join("\n") !== s.before.join("\n"))
        throw new Error(
          `${repo.repo}/${s.path} at ${repo.base.slice(0, 12)} is not the page the run was given, so it cannot be stamped`,
        );
      const stamped = applyStamps(lines, s.stamps);
      if ("error" in stamped)
        throw new Error(`${repo.repo}/${s.path} ${stamped.error}`);
      if (stamped.lines.join("\n") === lines.join("\n")) continue;
      files.push({
        path: s.path,
        text: fileText(stamped.lines, finalNewline),
        mode: current.mode,
      });
    }
    for (const m of repo.media ?? []) {
      if (readMedia === undefined)
        throw new Error(
          `${repo.repo}/${m.path} is a media file, but the run gave delivery no media to read`,
        );
      files.push({ path: m.path, bytes: readMedia(m.file), mode: "100644" });
    }
    if (files.length === 0) continue;
    const commit = await writer.commitFiles(repo.repo, {
      base: repo.base,
      branch: plan.branch,
      message: commitMessage(plan.job, repo, meta.runName),
      author: commitAuthor(),
      date: now,
      files,
    });
    const title = pullTitle(
      plan.job,
      repo,
      day,
      plan.key,
      policy.codeFix === undefined ? "page" : "file",
    );
    const auto = autoMergeDecision(
      policy.autoMergePaths,
      files.map((f) => f.path),
    );
    const body = pullBody(plan.job, repo, meta, plan.branch, auto);
    // A job with one branch per key sees only its pull request of this key, and closes none of the others.
    const open = (await writer.openPulls(repo.repo)).filter((p) =>
      plan.key === undefined ? isOurs(p, plan.job) : isOurKey(p, plan.branch),
    );
    const same = open.find((p) => p.branch === plan.branch);
    let pull: { number: number; url: string };
    if (same !== undefined) {
      await writer.updatePull(repo.repo, same.number, { title, body });
      pull = same;
    } else {
      pull = await writer.openPull(repo.repo, {
        branch: plan.branch,
        base: await writer.defaultBranch(repo.repo),
        title,
        body,
        ...(policy.draft === true ? { draft: true } : {}),
      });
    }
    const reviews =
      same === undefined
        ? await requestReviews(
            writer,
            repo.repo,
            pull.number,
            repo.reviewers,
            policy.reviewTeam,
          )
        : undefined;
    const check = await writeCheck(
      writer,
      { repo: repo.repo, job: plan.job, branch: plan.branch, head: commit },
      pullCheck(repo, meta),
    );
    const replaced: number[] = [];
    for (const old of open) {
      if (old.number === pull.number || old.branch === plan.branch) continue;
      await writer.closePull(
        repo.repo,
        old.number,
        `Replaced by #${pull.number}, which the job ${code(plan.job)} opened from a newer run. The job keeps at most one open pull request per repository.`,
      );
      await writer.deleteBranch(repo.repo, old.branch);
      replaced.push(old.number);
    }
    let autoMerge: DeliveredPull["autoMerge"];
    if (auto?.merge === true) {
      try {
        const merged = await writer.mergePull(repo.repo, pull.number, commit);
        await writer.deleteBranch(repo.repo, plan.branch);
        autoMerge = { merged: true, sha: merged.sha };
      } catch (err) {
        const why = `the merge failed: ${firstLine(err)}`;
        autoMerge = { merged: false, why };
        await writer
          .comment(
            repo.repo,
            pull.number,
            `Not merged automatically: ${why}. It stays open for review.`,
          )
          .catch(() => undefined);
      }
    } else if (auto !== undefined) autoMerge = { merged: false, why: auto.why };
    out.push({
      repo: repo.repo,
      number: pull.number,
      url: pull.url,
      branch: plan.branch,
      commit,
      updated: same !== undefined,
      replaced,
      ...(reviews === undefined ? {} : { reviews }),
      check,
      ...(autoMerge === undefined ? {} : { autoMerge }),
    });
  }
  return out;
}

/**
 * Delivers a revision: the plan's pages, checked against the pull
 * request's head, committed onto its branch with the head as parent. The
 * branch only moves forward; if anyone pushed to it since the run read it,
 * nothing is written. No pull request is opened, updated or closed.
 */
export async function deliverRevision(
  plan: DeliveryPlan,
  policy: PrPolicy,
  writer: PrWriter,
  meta: { runName: string; round: number },
  now: Date,
): Promise<{ repo: string; commit: string } | undefined> {
  const problem = planProblem(plan, policy);
  if (problem !== undefined) throw new Error(problem);
  if (plan.repos.length > 1)
    throw new Error("a revision changes one pull request, in one repository");
  const repo = plan.repos[0];
  if (repo === undefined || repo.files.length === 0) return undefined;
  if (repo.stamped.length > 0)
    throw new Error("a revision sets no stamps; only the first run does");
  if ((repo.media ?? []).length > 0)
    throw new Error(
      "a revision writes no media files; only the first run does",
    );
  const files = [];
  for (const f of repo.files) {
    const current = await writer.readFile(repo.repo, repo.base, f.path);
    const { lines, finalNewline } =
      current === undefined
        ? { lines: [] as string[], finalNewline: true }
        : fileLines(current.text);
    if (lines.join("\n") !== f.before.join("\n"))
      throw new Error(
        `${repo.repo}/${f.path} at ${repo.base.slice(0, 12)} is not the page the run was given, so its checked patch cannot be delivered`,
      );
    files.push({
      path: f.path,
      text: fileText(f.after, finalNewline),
      mode: current?.mode ?? "100644",
    });
  }
  const paths = repo.files.map((f) => f.path);
  const commit = await writer.commitFiles(repo.repo, {
    base: repo.base,
    branch: plan.branch,
    message: [
      `${plan.job}: revision ${meta.round}, ${paths.length} page${paths.length === 1 ? "" : "s"}`,
      "",
      ...paths.map((p) => `- ${p}`),
      "",
      `Run: ${meta.runName}`,
    ].join("\n"),
    author: commitAuthor(),
    date: now,
    files,
    fastForwardFrom: repo.base,
  });
  return { repo: repo.repo, commit };
}
