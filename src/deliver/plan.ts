import { applyHunks, parseUnifiedDiff } from "../output-check/diff.ts";
import type { MediaFile } from "../lib/media.ts";
import {
  repoCitations,
  sourcesFor,
  type Change,
  type CheckContext,
  type MediaChange,
  type ProposedMedia,
  type ProposedPage,
  type Source,
} from "../output-check/pr.ts";
import { GITHUB_LOGIN } from "../lib/login.ts";
import { applyStamps, type Stamp } from "./stamps.ts";
import { deliveryBranch, keyedBranch } from "./writer.ts";

/** A frontmatter value the job's code set on a page. */
export type StampValue = Pick<Stamp, "key" | "value">;

/** One page as delivery writes it: the lines the checker accepted, and the lines it was checked against. */
export interface PlannedFile {
  path: string;
  /** The page as the run was given it. */
  before: readonly string[];
  /** The page with the checked patch applied, then its stamps. */
  after: string[];
  /** Lines the patch removes and adds; stamps do not count. */
  changedLines: number;
  /** Model text: what the patch corrects. */
  reason: string;
  changes: readonly Change[];
  stamps: StampValue[];
  /** The patch creates the file, which is not there at the base (output.new_files); left out otherwise. */
  created?: true;
}

/** A page whose only change is its stamps. */
export interface StampedFile {
  path: string;
  stamps: StampValue[];
  /** The page as the run was given it, when it was; otherwise delivery reads it at the base commit. */
  before?: readonly string[];
  /** The page with its stamps set, when the run was given it. */
  after?: string[];
}

/** A file from the run's media stage, written byte for byte. */
export interface PlannedMedia {
  path: string;
  file: MediaFile;
  /** What the job's code says changed in it. */
  change?: MediaChange;
}

/** One pull request: the pages of one repository, all read at one commit. */
export interface RepoPlan {
  repo: string;
  /** The commit every page was read at; the branch starts there. */
  base: string;
  files: PlannedFile[];
  stamped: StampedFile[];
  /** Media files; left out when there are none. */
  media?: PlannedMedia[];
  /** People asked to review: the authors of the changes the patches cite, at most MAX_REVIEWERS. */
  reviewers: string[];
}

export interface DeliveryPlan {
  job: string;
  branch: string;
  /** The key of a job with output.branch_key, whose branch is agent/<job>/<key>; left out otherwise. */
  key?: string;
  repos: RepoPlan[];
}

/**
 * Turns an answer the PR checker accepted into what delivery writes: per
 * repository, the pages with their patch applied, the pages whose only
 * change is a stamp, and the one commit they were all read at. Pages
 * without a patch or a stamp are left out. A stamp on a page the model was
 * given applies only when the answer lists that page; a stamp on any
 * other page always applies. Pages of one repository read at different
 * commits cannot share a pull request, so that is refused. Media files go
 * on the commit the repository's pages were read at.
 */
export function planDelivery(
  job: string,
  answer: { pages: readonly ProposedPage[]; media?: readonly ProposedMedia[] },
  context: CheckContext,
  now: Date,
  stamps: readonly Stamp[] = [],
  /** The branch to write; the job's branch for the day when not given (a revision writes its pull request's branch). */
  branch?: string,
  /** The run's branch key (output.branch_key): the branch is agent/<job>/<key> unless branch is given. */
  key?: string,
): DeliveryPlan | { error: string } {
  const byRepo = new Map<string, RepoPlan>();
  const stampsOf = new Map<string, Stamp[]>();
  for (const s of stamps) {
    const id = `${s.repo}/${s.path}`;
    stampsOf.set(id, [...(stampsOf.get(id) ?? []), s]);
  }
  const repoPlan = (
    repo: string,
    base: string,
  ): RepoPlan | { error: string } => {
    const plan = byRepo.get(repo) ?? {
      repo,
      base,
      files: [],
      stamped: [],
      reviewers: [],
    };
    if (plan.base !== base)
      return {
        error: `the pages of ${repo} were read at different commits (${plan.base.slice(0, 12)} and ${base.slice(0, 12)}); one pull request needs one base`,
      };
    byRepo.set(repo, plan);
    return plan;
  };
  const stampValues = (
    id: string,
    commit: string,
  ): StampValue[] | { error: string } => {
    const own = stampsOf.get(id) ?? [];
    stampsOf.delete(id);
    const other = own.find((s) => s.commit !== commit);
    if (other !== undefined)
      return {
        error: `the ${other.key} stamp of ${id} is for commit ${other.commit.slice(0, 12)}, but the page was read at ${commit.slice(0, 12)}`,
      };
    return own.map((s) => ({ key: s.key, value: s.value }));
  };
  const listed = new Set(answer.pages.map((p) => `${p.repo}/${p.path}`));
  for (const page of answer.pages) {
    if (page.decision !== "patch") continue;
    const pinned = context.pinned.find(
      (p) => p.repo === page.repo && p.path === page.path,
    );
    if (pinned === undefined)
      return { error: `${page.repo}/${page.path} was not given to the run` };
    const parsed = parseUnifiedDiff(page.patch ?? "");
    if ("error" in parsed || parsed.files.length !== 1)
      return { error: `the patch of ${page.repo}/${page.path} does not parse` };
    const file = parsed.files[0]!;
    const applied = applyHunks(pinned.lines, file.hunks);
    if ("error" in applied)
      return { error: `${page.repo}/${page.path}: ${applied.error}` };
    const changedLines = file.hunks
      .flatMap((h) => h.lines)
      .filter((l) => l.op !== " ").length;
    const plan = repoPlan(page.repo, pinned.commit);
    if ("error" in plan) return plan;
    const own = stampValues(`${page.repo}/${page.path}`, pinned.commit);
    if ("error" in own) return own;
    const stamped = applyStamps(applied.lines, own);
    if ("error" in stamped)
      return { error: `${page.repo}/${page.path} ${stamped.error}` };
    plan.files.push({
      path: page.path,
      before: pinned.lines,
      after: stamped.lines,
      changedLines,
      reason: page.reason,
      changes: page.changes ?? [],
      stamps: own,
      ...(pinned.absent === true ? { created: true as const } : {}),
    });
  }
  for (const [id, own] of [...stampsOf]) {
    const { repo, path, commit } = own[0]!;
    const pinned = context.pinned.find(
      (p) => p.repo === repo && p.path === path,
    );
    if (pinned !== undefined && !listed.has(id)) continue;
    const values = stampValues(id, pinned?.commit ?? commit);
    if ("error" in values) return values;
    let file: StampedFile = { path, stamps: values };
    if (pinned !== undefined) {
      const stamped = applyStamps(pinned.lines, values);
      if ("error" in stamped) return { error: `${id} ${stamped.error}` };
      if (stamped.lines.join("\n") === pinned.lines.join("\n")) continue;
      file = { ...file, before: pinned.lines, after: stamped.lines };
    }
    const plan = repoPlan(repo, pinned?.commit ?? commit);
    if ("error" in plan) return plan;
    plan.stamped.push(file);
  }
  for (const m of answer.media ?? []) {
    const file = context.media?.files.find((f) => f.path === m.file);
    if (file === undefined)
      return { error: `${m.file} is not a file of the run's media.json` };
    const base =
      byRepo.get(m.repo)?.base ??
      context.pinned.find((p) => p.repo === m.repo)?.commit;
    if (base === undefined)
      return {
        error: `no page of ${m.repo} was given to the run, so there is no commit to put ${m.path} on`,
      };
    const plan = repoPlan(m.repo, base);
    if ("error" in plan) return plan;
    (plan.media ??= []).push({
      path: m.path,
      file,
      ...(m.change === undefined ? {} : { change: m.change }),
    });
  }
  for (const plan of byRepo.values())
    plan.reviewers = citedAuthors(plan.files, context.sources ?? []);
  return {
    job,
    branch:
      branch ??
      (key === undefined ? deliveryBranch(job, now) : keyedBranch(job, key)),
    ...(key === undefined ? {} : { key }),
    repos: [...byRepo.values()],
  };
}

/** A page's lines as a file: joined with newlines, with a final newline when the file had one. */
export function fileText(lines: readonly string[], finalNewline: boolean) {
  return `${lines.join("\n")}${finalNewline && lines.length > 0 ? "\n" : ""}`;
}

/** A file's text as the run's lines, and whether it ended with a newline. */
export function fileLines(text: string): {
  lines: string[];
  finalNewline: boolean;
} {
  const finalNewline = text.endsWith("\n");
  const body = finalNewline ? text.slice(0, -1) : text;
  return { lines: text === "" ? [] : body.split("\n"), finalNewline };
}

/** The most people one pull request asks to review. */
export const MAX_REVIEWERS = 10;

/** The people whose changes the patches cite as evidence, first cited first, without repeats. */
export function citedAuthors(
  files: readonly Pick<PlannedFile, "changes">[],
  sources: readonly Source[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const file of files)
    for (const change of file.changes)
      for (const c of repoCitations(change.evidence))
        for (const s of sourcesFor(c, sources)) {
          if (s.kind !== "commit") continue;
          for (const login of s.authors ?? []) {
            const key = login.toLowerCase();
            if (!GITHUB_LOGIN.test(login) || seen.has(key)) continue;
            seen.add(key);
            out.push(login);
          }
        }
  return out.slice(0, MAX_REVIEWERS);
}
