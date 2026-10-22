import type { CheckRecord } from "../deliver/checks.ts";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolSecretEnv, NOT_SECRET_ENV } from "../lib/tools.ts";
import { mediaSecretEnv } from "../lib/media.ts";
import { RUNNER_SECRET_ENV } from "./argv.ts";
import type { ThinkingLevel } from "../lib/job.ts";
import type { RepairRecord } from "./repair.ts";
import { plainMarkdown, type MaintainerNote } from "../lib/maintainer-notes.ts";
import type { CitationCheck } from "./evidence.ts";
import type { UntrustedInputRecord } from "./input-gate.ts";
import type { LaunchResult } from "./launcher.ts";
import type { DeliveryRecord } from "./pr-output.ts";
import type { AnalysisRecord } from "./analysis-output.ts";
import type { SlackDeliveryRecord } from "./slack-output.ts";
import type { MediaRecord } from "./media.ts";
import type { MediaModelRecord } from "./media-model.ts";
import type { YouTubeDeliveryRecord } from "./youtube-output.ts";
import type { YouTubeTidyRecord } from "./youtube-tidy.ts";
import type { ResultsDeliveryRecord } from "./results-output.ts";
import type { LedgerRecord } from "./job-ledger.ts";

export interface Timing {
  step: string;
  startedAt: string;
  ms: number;
}

export interface GatewayRecord {
  url: string;
  /** The run key's alias, <team>/<job>/<YYYY-MM>/<run name>. */
  keyAlias?: string;
  /** LiteLLM's id for the run key (its sha256), never the key. */
  keyId?: string;
  maxBudgetUsd?: number;
  minutes?: number;
  expires?: string;
  /** Whether the key was blocked when the run ended. */
  blocked: boolean;
  /** What the key spent, read after blocking it. */
  spendUsd?: number;
  /** How the box's calls through the forwarder ended; each is in forwarder.json. */
  forwarder?: {
    forwarded: number;
    refused: number;
    failed: number;
    polls?: number;
  };
  /** Anything that went wrong with the key after it was issued. */
  problems: string[];
}

/** The box had no network: the model through the forwarder, the tools over a socket. */
export interface SocketsRecord {
  /** How the box's calls through the forwarder ended; each is in forwarder.json. */
  forwarder?: {
    forwarded: number;
    refused: number;
    failed: number;
    polls?: number;
  };
  problems: string[];
}

export interface RevisionRecord {
  repo: string;
  pull: number;
  /** revise: a round ran; limit: the round limit comment; nothing: no round was due. */
  decision: "revise" | "limit" | "nothing";
  reason?: string;
  round?: number;
  requests: string[];
  originalRun?: number;
  /** The comment the round left on the pull request was posted. */
  commented: boolean;
  problems: string[];
  /** The Notes Agent check run of the round, as it ended. */
  check?: CheckRecord;
}

export interface RunReport {
  job: string;
  mode: "shadow" | "live";
  /** none: a job with model: none, which starts no box. */
  launcher: "lbx" | "stub" | "none";
  runName: string;
  model: string;
  /** The level passed to Pi as --thinking; absent for a job with model: none. */
  thinking?: ThinkingLevel;
  /** For a job with models: the model the run used and why collect.ts chose it. */
  modelChoice?: { model: string; thinking: ThinkingLevel; reason?: string };
  /** The model and level the second check ran on, when output.review_model or --review-model set one. */
  reviewModel?: { model: string; thinking: ThinkingLevel };
  /** The run whose input this run replayed (--replay), instead of collecting. */
  replayOf?: number;
  /** media: a job with model: none, whose answer the kit built from the media manifest. */
  inputSource: "fixture" | "collect" | "revision" | "media" | "map" | "replay";
  /** The one media part this run recorded, delivering nothing; absent for a run that delivers. */
  part?: string;
  /** For a check job (trigger.envs): the environment this run checked. */
  targetEnv?: string;
  ok: boolean;
  /** One line on why the run failed; absent when it succeeded. */
  failure?: string;
  launch?: LaunchResult;
  answerProblems: string[];
  /** Set when text after the answer's JSON was ignored: how much, and how it starts. */
  answerWarning?: string;
  /** The one repair turn, when the first answer was not JSON or did not match the schema. */
  repair?: RepairRecord;
  /** The lbx command line: paths and variable names only, never a value. */
  argv: string[];
  timings: Timing[];
  budget: {
    month: string;
    spentUsd: number;
    reserveUsd: number;
    ledger: "none" | "durable";
    /** Spend of all jobs this month, when the ledger knows it. */
    shared?: { who: string; spentUsd: number; limitUsd?: number };
  };
  /** The run's model gateway key: never the key itself, only its id. */
  gateway?: GatewayRecord;
  /** The runner's sockets, the box's only way out. */
  sockets?: SocketsRecord;
  /** Set for a job with tools; the full record is in tools.json. */
  tools?: {
    names: string[];
    /** The upstreams started; none in stub runs. */
    upstreams: string[];
    calls: number;
    ok: number;
  };
  /** The answer's quotes of tool results, checked against what the tools returned. */
  citations?: CitationCheck;
  /** Set when collect.ts called tools; the full record is in collect/tools.json. */
  collect?: {
    names: string[];
    calls: number;
    ok: number;
  };
  /** Set for a job with render.ts or output kind slack: the Slack message kept in slack.json and slack.md. */
  slack?: {
    blocks: number;
    posted: boolean;
    /** Set for a job with output kind slack once its answer passed the schema and the quotes. */
    delivery?: SlackDeliveryRecord;
  };
  /** Set for a job with publish.ts once its answer passed the schema and the quotes: whether it publishes, and why not; publish.json holds what it printed. */
  publish?: { publish: boolean; reason?: string };
  /** Set when publish.ts published nothing and gave an analysis to post to output.notify; delivery/analysis.json holds the body. */
  analysis?: AnalysisRecord;
  /** Set when collect.ts said the run has nothing to do (nothing_to_do in the input): no model ran and nothing was delivered. */
  nothingToDo?: { reason: string };
  /** What a job with a ledger did with it: read the previous one, wrote the next. */
  ledger?: LedgerRecord;
  /** The collect inputs filled in for this run (collect_inputs in job.yml), by name; absent when none was. */
  collectInputs?: Record<string, string>;
  /** Set once the box ran: whether the model saw text anyone can write, from which tools. */
  untrustedInput?: UntrustedInputRecord;
  /** Set for a pull request job once its answer passed the schema and the quotes. */
  delivery?: DeliveryRecord;
  /** Set for a youtube job: the plan, and what was uploaded and recorded. */
  youtube?: YouTubeDeliveryRecord;
  /** Set for a tidy run of a youtube job (unlist_replaced): the replaced videos and what was done. */
  youtubeTidy?: YouTubeTidyRecord;
  /** Set for a check job: the results it left, what changed since the previous run, and the alert. */
  results?: ResultsDeliveryRecord;
  /** Set for a revision run: the pull request, the round and the requests it answered. */
  revision?: RevisionRecord;
  /** Set for a job with media: what media.ts (or, in a stub run, the fixture) made; media.json and the kept files are under media/. */
  media?: MediaRecord;
  /** Set when the media stage got a model key (media.model): never the key, only its id; each call is in media-forwarder.json. */
  mediaModel?: MediaModelRecord;
  /** Set once the answer was parsed: the notes are in maintainer-notes.json, kept and never delivered. */
  maintainerNotes?: {
    count: number;
    /** Why the notes were dropped, when they were malformed. */
    warning?: string;
  };
}

/** The secret values present in this environment, the gateway issuer key, the writer app's secrets, every tool credential and every media secret, for scrubbing output. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return [...RUNNER_SECRET_ENV, ...toolSecretEnv(), ...mediaSecretEnv()]
    .filter((name) => !NOT_SECRET_ENV.has(name))
    .map((name) => env[name]?.trim() ?? "")
    .filter((v) => v.length >= 4);
}

export function redact(
  text: string,
  secrets: readonly string[],
): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const secret of secrets) {
    const parts = out.split(secret);
    hits += parts.length - 1;
    out = parts.join("[redacted]");
  }
  return { text: out, hits };
}

/**
 * Collects report files, scrubbing each against the secrets before it is
 * written. The model can read its own process environment, so a key could
 * reach the answer or the transcript even though it is never in argv.
 */
export class ReportWriter {
  readonly dir: string;
  private readonly secrets: string[];
  private hits = 0;

  constructor(dir: string, secrets: readonly string[]) {
    this.dir = dir;
    this.secrets = [...secrets];
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get secretHits(): number {
    return this.hits;
  }

  /** Adds values known only once the run started, such as a token made for it. */
  addSecrets(values: readonly string[]): void {
    for (const value of values)
      if (value.length >= 4 && !this.secrets.includes(value))
        this.secrets.push(value);
  }

  /** The values scrubbed from every file, for other output such as the job summary. */
  get secretList(): readonly string[] {
    return this.secrets;
  }

  write(name: string, text: string): void {
    const clean = redact(text, this.secrets);
    this.hits += clean.hits;
    const path = join(this.dir, name);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, clean.text, { mode: 0o600 });
  }

  writeJson(name: string, value: unknown): void {
    this.write(name, `${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * Writes bytes that are not text, such as a video, unchanged. Bytes that
   * hold a secret value are not written and count as a hit.
   */
  writeBytes(name: string, data: Buffer): boolean {
    const hits = this.secrets.filter((s) => data.includes(s)).length;
    if (hits > 0) {
      this.hits += hits;
      return false;
    }
    const path = join(this.dir, name);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, data, { mode: 0o600 });
    return true;
  }
}

export function summaryMarkdown(
  report: RunReport,
  notes: readonly MaintainerNote[] = [],
): string {
  const status = report.launch?.status;
  const lines = [
    `### ${report.job}${report.part === undefined ? "" : ` part ${report.part}`}: ${report.ok ? (report.part === undefined ? "answer accepted" : "recorded") : "failed"}`,
    "",
    `| | |`,
    `| --- | --- |`,
    `| Mode | ${report.mode}${report.launcher === "stub" ? " (stub, no model called)" : report.launcher === "none" ? " (no model)" : ""} |`,
    `| Model | \`${report.model}\` |`,
    ...(report.modelChoice?.reason === undefined
      ? []
      : [`| Model choice | ${report.modelChoice.reason} |`]),
    ...(report.thinking === undefined
      ? []
      : [`| Thinking | \`${report.thinking}\` |`]),
    ...(report.reviewModel === undefined
      ? []
      : [
          `| Second check model | \`${report.reviewModel.model}\` at \`${report.reviewModel.thinking}\` |`,
        ]),
    ...(report.replayOf === undefined
      ? []
      : [
          `| Replay of | run ${report.replayOf} (its input, not a fresh collect) |`,
        ]),
    `| Run | \`${report.runName}\` |`,
    ...(report.targetEnv === undefined
      ? []
      : [`| Environment | ${report.targetEnv} |`]),
    `| Input | ${report.inputSource} |`,
    ...(report.launcher === "none"
      ? []
      : [
          `| lbx status | ${status === undefined ? "none" : `${status.status} code=${status.code}${status.cleanupIncomplete === true ? " cleanup=incomplete" : ""}`} |`,
        ]),
    `| Took | ${(report.timings.reduce((sum, t) => sum + t.ms, 0) / 1000).toFixed(1)} s |`,
  ];
  if (report.tools !== undefined)
    lines.push(
      `| Tools | ${report.tools.calls} call${report.tools.calls === 1 ? "" : "s"}, ${report.tools.ok} answered (${report.tools.names.join(", ")}) |`,
    );
  if (report.media !== undefined)
    lines.push(`| Media | ${describeMedia(report.media)} |`);
  if (report.mediaModel !== undefined)
    lines.push(
      `| Media model | \`${report.mediaModel.model}\`, ${describeGateway(report.mediaModel)} |`,
    );
  if (report.collect !== undefined)
    lines.push(
      `| Tools of collect.ts | ${report.collect.calls} call${report.collect.calls === 1 ? "" : "s"}, ${report.collect.ok} answered (${report.collect.names.join(", ")}) |`,
    );
  if (report.slack !== undefined)
    lines.push(`| Slack message | ${describeSlack(report.slack)} |`);
  if (report.citations !== undefined)
    lines.push(
      `| Quotes of tool results | ${describeCitations(report.citations)} |`,
    );
  if (report.gateway !== undefined)
    lines.push(`| Model gateway | ${describeGateway(report.gateway)} |`);
  if (report.sockets !== undefined)
    lines.push(`| Network | ${describeSockets(report.sockets)} |`);
  if (report.untrustedInput !== undefined)
    lines.push(
      `| Untrusted input | ${describeUntrusted(report.untrustedInput)} |`,
    );
  if (report.revision !== undefined)
    lines.push(`| Revision | ${describeRevision(report.revision)} |`);
  if (report.collectInputs !== undefined)
    lines.push(
      `| Collect inputs | ${Object.entries(report.collectInputs)
        .map(([k, v]) => `${k}: ${plainMarkdown(v)}`)
        .join(", ")} |`,
    );
  if (report.nothingToDo !== undefined)
    lines.push(
      `| Nothing to do | ${plainMarkdown(report.nothingToDo.reason)}; no model ran |`,
    );
  if (report.publish !== undefined)
    lines.push(
      `| Publish | ${report.publish.publish ? "publish.ts built the pull request from the answer" : `nothing to deliver: ${plainMarkdown(report.publish.reason ?? "")}`} |`,
    );
  if (report.analysis !== undefined)
    lines.push(`| Analysis | ${describeAnalysis(report.analysis)} |`);
  if (report.delivery !== undefined)
    lines.push(`| Delivery | ${describeDelivery(report.delivery)} |`);
  if (report.youtube !== undefined)
    lines.push(`| YouTube | ${describeYouTube(report.youtube)} |`);
  if (report.youtubeTidy !== undefined)
    lines.push(`| Replaced videos | ${describeTidy(report.youtubeTidy)} |`);
  if (report.results !== undefined)
    lines.push(`| Results | ${describeResults(report.results)} |`);
  if (report.answerWarning !== undefined)
    lines.push(`| Answer | ${plainMarkdown(report.answerWarning)} |`);
  if (report.repair !== undefined)
    lines.push(`| Repair turn | ${describeRepair(report.repair)} |`);
  if (report.maintainerNotes !== undefined)
    lines.push(
      `| Maintainer notes | ${report.maintainerNotes.warning === undefined ? `${report.maintainerNotes.count} in maintainer-notes.json` : "dropped, malformed"} |`,
    );
  if (report.failure !== undefined)
    lines.push("", `Failure: ${report.failure.replaceAll("\n", " ")}`);
  for (const p of report.answerProblems.slice(0, 10)) lines.push(`- ${p}`);
  if (notes.length > 0) {
    lines.push("", "#### Maintainer notes", "");
    for (const n of notes)
      lines.push(`- \`${n.kind}\` ${plainMarkdown(n.text)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function describeRepair(r: RepairRecord): string {
  const first = `${r.problems.length} problem${r.problems.length === 1 ? "" : "s"} in the first answer`;
  if (r.outcome === "repaired")
    return `repaired ${first}; the first answer is answer.txt, the repaired one repair/answer.txt`;
  if (r.outcome === "failed")
    return `did not fix ${first}${r.reason === undefined ? "" : `: ${r.reason}`}`;
  return `not run for ${first}: ${r.reason ?? "no reason recorded"}`;
}

function describeMedia(m: MediaRecord): string {
  if (m.source === "none") return "none, a stub run has no media fixture";
  const mb = (m.bytes / (1024 * 1024)).toFixed(1);
  const kept =
    m.kept.length === 0
      ? "none kept in the report"
      : `${m.kept.length} kept in media/`;
  return `${m.files} file${m.files === 1 ? "" : "s"}, ${mb} MB, from ${m.source === "fixture" ? "the fixture" : m.source === "parts" ? "the parts' jobs" : "media.ts"}; ${kept}`;
}

function describeGateway(g: GatewayRecord): string {
  if (g.keyAlias === undefined) return "no key issued";
  const spend =
    g.spendUsd === undefined
      ? "spend not read"
      : `$${g.spendUsd.toFixed(4)} spent`;
  const cap =
    g.maxBudgetUsd === undefined ? "" : ` of $${g.maxBudgetUsd.toFixed(2)}`;
  const calls =
    g.forwarder === undefined
      ? ""
      : `, ${g.forwarder.forwarded} call${g.forwarder.forwarded === 1 ? "" : "s"} forwarded, ${g.forwarder.refused} refused`;
  return `key \`${g.keyAlias}\`, ${spend}${cap}${calls}, ${g.blocked ? "blocked" : "NOT blocked (it expires on its own)"}`;
}

function describeSockets(s: SocketsRecord): string {
  const calls =
    s.forwarder === undefined
      ? "no model forwarder"
      : `${s.forwarder.forwarded} model call${s.forwarder.forwarded === 1 ? "" : "s"} forwarded to the model gateway, ${s.forwarder.refused} refused, ${s.forwarder.failed} failed${(s.forwarder.polls ?? 0) > 0 ? ` (${s.forwarder.polls} usage polls declined, as expected)` : ""}`;
  return `none, only the runner's sockets; ${calls}`;
}

function describeUntrusted(u: UntrustedInputRecord): string {
  if (!u.seen) return "none seen";
  const from = [
    ...(u.model.length > 0 ? [`the model's ${u.model.join(", ")}`] : []),
    ...(u.collect.length > 0 ? [`collect.ts's ${u.collect.join(", ")}`] : []),
  ];
  return `seen, from ${from.join(" and ")}`;
}

function describeRevision(r: RevisionRecord): string {
  const target = `${r.repo}#${r.pull}`;
  const comment = r.commented ? ", reply posted" : "";
  const problems =
    r.problems.length === 0
      ? ""
      : `; ${r.problems.join("; ").replaceAll("|", "/")}`;
  switch (r.decision) {
    case "nothing":
      return `${target}: nothing to revise (${(r.reason ?? "").replaceAll("|", "/")})${problems}`;
    case "limit":
      return `${target}: round limit reached${comment}${problems}`;
    case "revise":
      return `${target}: round ${r.round}, ${r.requests.length} request${r.requests.length === 1 ? "" : "s"} (${r.requests.join(", ")}), from run ${r.originalRun ?? "unknown"}${comment}${problems}`;
  }
}

function describeDelivery(d: DeliveryRecord): string {
  const pages = d.pages?.length ?? 0;
  const stamped = d.stamped?.length ?? 0;
  const dropped = d.dropped?.length ?? 0;
  const what = `${pages} page${pages === 1 ? "" : "s"} changed${stamped === 0 ? "" : `, ${stamped} stamped`}${dropped === 0 ? "" : `, ${dropped} left out (${d.dropped!.map((p) => p.path).join(", ")})`}`;
  const review =
    d.review === undefined
      ? ""
      : d.review.leftOut !== undefined
        ? `, second check approved ${d.review.approved ?? 0} page${d.review.approved === 1 ? "" : "s"} and left out ${d.review.leftOut}`
        : d.review.changesLeftOut !== undefined
          ? `, second check refused ${d.review.changesLeftOut} change${d.review.changesLeftOut === 1 ? "" : "s"}, left out, then ${d.review.verdict === "approve" ? "approved" : "rejected"} the rest`
          : `, second check ${d.review.verdict === "approve" ? "approved" : "rejected"}`;
  const notice = `${d.notice === undefined ? "" : `; notice posted: ${d.notice.permalink}`}${(d.problems ?? []).length === 0 ? "" : `; ${d.problems!.join("; ").replaceAll("|", "/")}`}`;
  switch (d.outcome) {
    case "nothing":
      return dropped === 0
        ? "nothing to deliver, every page is no_change"
        : `${what}; nothing to deliver: ${(d.reason ?? "").replaceAll("|", "/")}`;
    case "shadow":
      return `${what}${review}; not opened (${d.reason ?? "shadow"}), see delivery/${notice}`;
    case "report_only":
      return `${what}${review}; report only: ${(d.reason ?? "").replaceAll("|", "/")}`;
    case "delivered":
      if (d.revision !== undefined)
        return `${what}${review}; ${d.revision.commit === undefined ? "nothing pushed" : `pushed ${d.revision.commit.slice(0, 12)} to ${d.revision.branch}`}`;
      return `${what}${review}; ${(d.pulls ?? []).map((p) => `${p.repo}#${p.number}${p.updated ? " updated" : " opened"}${p.replaced.length > 0 ? `, replacing #${p.replaced.join(", #")}` : ""}${p.autoMerge === undefined ? "" : p.autoMerge.merged ? ", merged automatically" : `, left open (${p.autoMerge.why})`}`).join("; ")}${notice}`;
  }
}

function describeAnalysis(a: AnalysisRecord): string {
  const where =
    a.channel === undefined
      ? ""
      : ` to #${a.channel.name}${a.shadow === true ? " as a shadow run" : ""}`;
  if (a.outcome === "delivered" && a.posted !== undefined)
    return `posted${where}: ${a.posted.permalink}`;
  return `not posted${where} (${(a.reason ?? "").replaceAll("|", "/")}), see delivery/analysis.json`;
}

function describeTidy(t: YouTubeTidyRecord): string {
  const pending = t.videos.filter((v) => v.unlist || v.playlists.length > 0);
  const extra = `${t.neverMapped.length === 0 ? "" : `; ${t.neverMapped.length} uploaded but never in the docs, left for a person`}${(t.problems ?? []).length === 0 ? "" : `; ${(t.problems ?? []).length} problem(s)`}`;
  const why = (t.reason ?? "").replaceAll("|", "/");
  switch (t.outcome) {
    case "nothing":
      return `${t.videos.length} replaced, nothing to change${why === "" ? "" : ` (${why})`}${extra}`;
    case "shadow":
      return `${t.videos.length} replaced, ${pending.length} to change; not changed (${why}), see delivery/youtube-tidy.md${extra}`;
    case "tidied": {
      const done = t.videos
        .filter((v) => (v.done ?? []).length > 0)
        .map((v) => `\`${v.youtubeId}\` ${v.done!.join(" and ")}`);
      return `${done.length === 0 ? "nothing changed" : done.join(", ")}${t.notice === undefined ? "" : `; notice posted: ${t.notice.permalink}`}${extra}`;
    }
  }
}

function describeResults(r: ResultsDeliveryRecord): string {
  const where =
    r.outcome === "written"
      ? `${r.files.length} files for the artifact \`${r.artifact}\``
      : `${r.files.length} files planned for the artifact \`${r.artifact}\`, nothing written`;
  const since =
    r.previous === null
      ? "no previous run to compare with"
      : `since run ${r.previous.id}: ${r.failing.length} failing that passed, ${r.recovered.length} passing again`;
  const alert =
    r.alert === undefined
      ? ""
      : r.alert.posted !== undefined
        ? `; alert posted to #${r.alert.channel.name}: ${r.alert.posted.permalink}`
        : `; alert not posted (${(r.alert.reason ?? "").replaceAll("|", "/")})`;
  const why =
    r.reason === undefined || r.reason === r.alert?.reason
      ? ""
      : `; ${r.reason.replaceAll("|", "/")}`;
  return `${r.shadow ? "shadow, " : ""}${r.env}: ${where}; ${since}${alert}${why}`;
}

function describeYouTube(y: YouTubeDeliveryRecord): string {
  const toUpload = y.videos.filter((v) => v.action === "upload").length;
  const deferred = y.videos.filter((v) => v.action === "defer").length;
  const skipped = y.videos.length - toUpload - deferred;
  const what = `${toUpload} to upload, ${skipped} skipped (media hash in the map)${deferred === 0 ? "" : `, ${deferred} left for the next run (upload limit)`}`;
  const why = (y.reason ?? "").replaceAll("|", "/");
  switch (y.outcome) {
    case "nothing":
      return y.videos.length === 0
        ? `nothing to upload: ${why}`
        : "nothing to upload, the map records every video's media hash";
    case "shadow":
      return `${what}; not uploaded (${why}), see delivery/youtube.md`;
    case "report_only":
      return `${what}; report only: ${why}`;
    case "delivered": {
      const ids = y.videos
        .filter((v) => v.youtubeId !== undefined)
        .map((v) => `${v.scenario} \`${v.youtubeId}\``);
      const pull =
        y.pull === undefined
          ? ""
          : `; recorded in ${y.pull.repo}#${y.pull.number}${y.pull.updated ? " (updated)" : ""}`;
      const notice =
        y.notice === undefined ? "" : `; notice posted: ${y.notice.permalink}`;
      return `uploaded private: ${ids.join(", ")}${pull}${notice}${why === "" ? "" : `; ${why}`}`;
    }
  }
}

function describeSlack(slack: NonNullable<RunReport["slack"]>): string {
  const kept = `${slack.blocks} blocks in slack.json and slack.md`;
  const d = slack.delivery;
  if (d === undefined) return `${kept}, not posted`;
  const changed =
    d.changes.length === 0
      ? ""
      : `, ${d.changes.length} change${d.changes.length === 1 ? "" : "s"} to keep the message rules (status.json)`;
  if (d.outcome === "delivered" && d.posted !== undefined)
    return `${kept}${changed}; posted to #${d.channel.name}${d.shadow === true ? " as a shadow run" : ""}: ${d.posted.permalink}`;
  const why = (d.reason ?? "").replaceAll("|", "/");
  return d.outcome === "shadow"
    ? `${kept}${changed}; not posted (${why})`
    : `${kept}${changed}; report only: ${why}`;
}

function describeCitations(check: CitationCheck): string {
  if (check.status === "skipped") return `not checked: ${check.reason}`;
  const found = check.citations.filter((c) => c.found).length;
  return `${found} of ${check.citations.length} found in what the tools returned`;
}

/** Adds the summary to the Actions job page when running there. */
export function appendStepSummary(
  env: NodeJS.ProcessEnv,
  markdown: string,
  secrets: readonly string[],
): void {
  const file = env.GITHUB_STEP_SUMMARY;
  if (file === undefined || file === "") return;
  appendFileSync(file, redact(markdown, secrets).text);
}
