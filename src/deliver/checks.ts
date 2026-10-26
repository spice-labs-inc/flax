import { workspace } from "../lib/workspace.ts";
import { firstLine } from "../lib/problem.ts";
import { plainText } from "./pr-text.ts";
import type { PrWriter } from "./writer.ts";

/** Every check run a job writes is named this, then the job: Notes Agent / <job>. */
export function checkNamePrefix(): string {
  return workspace().displayName;
}

/** The check run name of a job's pull requests. */
export function checkName(job: string): string {
  return `${checkNamePrefix()} / ${job}`;
}

export type CheckConclusion = "success" | "neutral" | "failure";

/** What a check run shows: its state, a one-line title and a short markdown summary. */
export interface CheckFields {
  status: "queued" | "in_progress" | "completed";
  /** Set exactly when status is completed. */
  conclusion?: CheckConclusion;
  title: string;
  summary: string;
  /** The Actions run behind it. */
  detailsUrl?: string;
}

/** A check run on a pull request's head commit, as the report keeps it. */
export interface CheckRecord {
  repo: string;
  name: string;
  head: string;
  status: CheckFields["status"];
  conclusion?: CheckConclusion;
  title: string;
  /** Set when GitHub made or updated it. */
  id?: number;
  /** Why GitHub refused it; a refusal never fails delivery or a revision. */
  refused?: string;
}

/** GitHub caps a check's title and summary; the kit keeps well under. */
export const MAX_CHECK_TITLE = 200;
export const MAX_CHECK_SUMMARY = 60_000;

export function clampTitle(title: string): string {
  const one = title.replace(/\s+/g, " ").trim();
  return one.length <= MAX_CHECK_TITLE
    ? one
    : `${one.slice(0, MAX_CHECK_TITLE - 1)}…`;
}

export function clampSummary(summary: string): string {
  return summary.length <= MAX_CHECK_SUMMARY
    ? summary
    : `${summary.slice(0, MAX_CHECK_SUMMARY - 60)}\n\n(cut; the run's report has the rest)`;
}

/**
 * Creates a check run on an agent branch's head commit, or updates the
 * one given; never throws. A refusal (the writer app without the Checks
 * permission, a branch that moved) is recorded in the result instead.
 */
export async function writeCheck(
  writer: Pick<PrWriter, "createCheck" | "updateCheck">,
  target: { repo: string; job: string; branch: string; head: string },
  fields: CheckFields,
  existing?: number,
): Promise<CheckRecord> {
  const record: CheckRecord = {
    repo: target.repo,
    name: checkName(target.job),
    head: target.head,
    status: fields.status,
    ...(fields.conclusion === undefined
      ? {}
      : { conclusion: fields.conclusion }),
    title: clampTitle(fields.title),
  };
  const clamped: CheckFields = {
    ...fields,
    title: record.title,
    summary: clampSummary(fields.summary),
  };
  try {
    if (existing !== undefined) {
      await writer.updateCheck(target.repo, existing, clamped);
      record.id = existing;
    } else {
      record.id = await writer.createCheck(target.repo, {
        name: record.name,
        branch: target.branch,
        headSha: target.head,
        ...clamped,
      });
    }
  } catch (err) {
    record.refused = firstLine(err);
  }
  return record;
}

/** The check a shadow or stub run would write, as its plan says; nothing is called. */
export function plannedCheck(
  repo: string,
  job: string,
  fields: CheckFields,
): Omit<CheckRecord, "head"> {
  return {
    repo,
    name: checkName(job),
    status: fields.status,
    ...(fields.conclusion === undefined
      ? {}
      : { conclusion: fields.conclusion }),
    title: clampTitle(fields.title),
  };
}

const code = (text: string) =>
  `\`${text.replaceAll("`", "'").replaceAll("\n", " ")}\``;

/** How the second check ended, when it approved. */
export type SecondCheckOutcome =
  | "approved"
  | "approved without the pages left out"
  | "approved without the changes left out";

/** What the check of a delivered pull request says about the run behind it. */
export interface DeliveryCheckFacts {
  /** Pages the pull request changes, with their changed lines. */
  pages: readonly { path: string; changedLines: number }[];
  /** Pages left out, with the first line of each one's problem. */
  leftOut: readonly { path: string; why: string }[];
  /** Pages whose only change is a stamp the job's code set. */
  stamped: number;
  /** Media files the pull request writes. */
  media: number;
  /** Changes (line groups) and distinct citations across the pages. */
  changes: number;
  citations: number;
  /** Changes the second check refused, left out of their pages: what each was, and why. */
  leftOutChanges?: readonly { path: string; what: string; why: string }[];
  /** approve, or undefined when no second check ran. */
  secondCheck?: SecondCheckOutcome;
  builtByCode: boolean;
  /** What the run's model calls cost, when the run read it. */
  costUsd?: number;
  runUrl?: string;
}

/** The completed check on a delivered pull request's head commit: success, or neutral when pages were left out. */
export function deliveryCheck(facts: DeliveryCheckFacts): CheckFields {
  const n = facts.pages.length;
  const parts = [`${n} page${n === 1 ? "" : "s"} changed`];
  if (facts.stamped > 0) parts.push(`${facts.stamped} stamped`);
  if (facts.media > 0)
    parts.push(`${facts.media} media file${facts.media === 1 ? "" : "s"}`);
  if (facts.leftOut.length > 0) parts.push(`${facts.leftOut.length} left out`);
  const changesOut = facts.leftOutChanges ?? [];
  if (changesOut.length > 0)
    parts.push(
      `${changesOut.length} change${changesOut.length === 1 ? "" : "s"} left out`,
    );
  parts.push(
    facts.builtByCode
      ? "built by the job's code"
      : facts.secondCheck === undefined
        ? "no second check needed"
        : "second check approved",
  );
  const lines = [
    `**PR checker:** ${facts.leftOut.length === 0 ? "passed" : `passed for the pages in this pull request; ${facts.leftOut.length} left out`}`,
    `**Second check:** ${facts.builtByCode ? "none, no model ran" : (facts.secondCheck ?? "none ran")}`,
    `**Changes:** ${facts.changes} change${facts.changes === 1 ? "" : "s"}, ${facts.citations} citation${facts.citations === 1 ? "" : "s"}`,
    `**Model cost:** ${facts.builtByCode ? "none" : facts.costUsd === undefined ? "not read" : `$${facts.costUsd.toFixed(4)}`}`,
    "",
  ];
  if (n > 0) {
    lines.push("**Pages changed:**", "");
    for (const p of facts.pages)
      lines.push(
        `- ${code(p.path)}: ${p.changedLines} line${p.changedLines === 1 ? "" : "s"}`,
      );
    lines.push("");
  }
  if (facts.leftOut.length > 0 || changesOut.length > 0) {
    lines.push("**Left out:**", "");
    // A problem line can quote the model: escaped, its links and mentions do not render.
    for (const p of facts.leftOut)
      lines.push(`- ${code(p.path)}: ${plainText(p.why)}`);
    for (const c of changesOut)
      lines.push(
        `- From ${code(c.path)}, refused by the second check: ${plainText(c.what)} Why: ${plainText(c.why)}`,
      );
    lines.push("");
  }
  lines.push(
    facts.runUrl === undefined
      ? "The run's report has the details."
      : `[The run](${facts.runUrl}); its report artifact has the details.`,
  );
  return {
    status: "completed",
    conclusion:
      facts.leftOut.length > 0 || changesOut.length > 0 ? "neutral" : "success",
    title: parts.join(", "),
    summary: lines.join("\n"),
    ...(facts.runUrl === undefined ? {} : { detailsUrl: facts.runUrl }),
  };
}
