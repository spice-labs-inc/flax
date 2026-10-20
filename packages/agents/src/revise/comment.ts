import { workspace } from "../lib/workspace.ts";
import type { PrWriter } from "../deliver/writer.ts";
import { code, plainText } from "../deliver/pr-text.ts";
import { firstLine } from "../lib/problem.ts";
import type { RevisionReply } from "./answer.ts";
import {
  LIMIT_MARKER,
  MAX_ROUNDS,
  revisionMarker,
  type RevisionRequest,
} from "./requests.ts";

const MAX_COMMENT_CHARS = 60_000;
const QUOTE_CHARS = 80;

export interface RevisionOutcome {
  job: string;
  round: number;
  runName: string;
  runUrl?: string;
  requests: readonly RevisionRequest[];
  replies: readonly RevisionReply[];
  /** The commit pushed to the branch, when a page changed. */
  commit?: string;
  pages?: readonly { path: string; changedLines: number }[];
  /** Why nothing was pushed, when the round failed or a check refused it. */
  problem?: string;
  /** Requests already answered with a reply in their own review thread. */
  threaded?: ReadonlySet<string>;
}

/** The review comment a line request came from, by its id; undefined for a review body or an issue comment. */
export function threadOf(r: RevisionRequest): number | undefined {
  const m = /^line-(\d+)$/.exec(r.id);
  return r.kind === "line" && m !== null ? Number(m[1]) : undefined;
}

function quoted(r: RevisionRequest): string {
  const first = r.text.split("\n")[0]!.trim();
  const short =
    first.length <= QUOTE_CHARS ? first : `${first.slice(0, QUOTE_CHARS)}…`;
  const what = r.kind === "review" ? "review" : "comment";
  const link = r.url === "" ? what : `[${what}](${r.url})`;
  return `${code(r.author)}'s ${link}: "${plainText(short)}"`;
}

/**
 * The summary comment a revision round leaves on the pull request, written
 * by the kit: one line on what happened, the answers to requests that have
 * no thread of their own (a review's text, an /agent comment, or a line
 * comment whose thread reply GitHub refused), and a hidden marker naming
 * the round and every request it answered, so they are not asked again. A
 * failed round answers them too, saying what went wrong, so the poller
 * never repeats a round by itself.
 */
export function revisionComment(o: RevisionOutcome): string {
  const run =
    o.runUrl === undefined ? code(o.runName) : `[${o.runName}](${o.runUrl})`;
  const threaded = o.threaded ?? new Set<string>();
  const changed = (o.pages ?? []).length;
  const what =
    o.problem !== undefined
      ? `nothing was pushed: ${o.problem}. Reply with ${code("/agent")} and more detail to try again`
      : o.commit !== undefined
        ? `pushed ${code(o.commit.slice(0, 7))}, changed ${changed} page${changed === 1 ? "" : "s"}`
        : "no page changed";
  const inThreads = o.requests.some((r) => threaded.has(r.id));
  const lines = [
    `Revision ${o.round} of ${MAX_ROUNDS} by the ${workspace().displayName} ${code(o.job)}: ${what}${inThreads ? "; replied in each thread" : ""}. (${run})`,
    "",
  ];
  const replies = new Map(o.replies.map((r) => [r.request, r]));
  for (const r of o.requests) {
    if (threaded.has(r.id)) continue;
    const reply = replies.get(r.id);
    lines.push(
      `- ${quoted(r)}`,
      `  ${
        reply === undefined
          ? o.problem === undefined
            ? `The ${workspace().displayName} gave no reply to this one.`
            : "Not answered in this round."
          : plainText(reply.reply)
      }`,
    );
  }
  const body = lines.join("\n").trimEnd();
  const marker = revisionMarker(
    o.round,
    o.requests.map((r) => r.id),
  );
  return `${body.length <= MAX_COMMENT_CHARS ? body : `${body.slice(0, MAX_COMMENT_CHARS)}\n\n(cut; the run's report has the rest)`}\n\n${marker}\n`;
}

export interface PostedRevision {
  /** Requests answered in their own review thread. */
  threaded: string[];
  /** Thread replies GitHub refused; those requests are answered in the summary instead. */
  refused: { request: string; why: string }[];
  summary: string;
}

/**
 * Answers each line request with a reply in its own review thread, then
 * leaves the summary comment, which answers everything else and any
 * request whose thread reply GitHub refused. A refused reply never fails
 * the round.
 */
export async function postRevision(
  writer: Pick<PrWriter, "comment" | "replyToReviewComment">,
  repo: string,
  number: number,
  o: RevisionOutcome,
): Promise<PostedRevision> {
  const threaded: string[] = [];
  const refused: PostedRevision["refused"] = [];
  const replies = new Map(o.replies.map((r) => [r.request, r]));
  for (const r of o.requests) {
    const thread = threadOf(r);
    const reply = replies.get(r.id);
    if (thread === undefined || reply === undefined) continue;
    try {
      await writer.replyToReviewComment(
        repo,
        number,
        thread,
        plainText(reply.reply),
      );
      threaded.push(r.id);
    } catch (err) {
      refused.push({ request: r.id, why: firstLine(err) });
    }
  }
  const summary = revisionComment({ ...o, threaded: new Set(threaded) });
  await writer.comment(repo, number, summary);
  return { threaded, refused, summary };
}

/** The comment a pull request gets once it has had its rounds. */
export function limitComment(job: string): string {
  return `This pull request has had ${MAX_ROUNDS} revision rounds, the most the ${workspace().displayName} ${code(job)} makes. A person needs to take it from here: edit the branch, or close the pull request and let the next run start over.\n\n${LIMIT_MARKER}\n`;
}
