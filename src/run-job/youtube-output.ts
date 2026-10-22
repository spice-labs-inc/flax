import { checkName } from "../deliver/checks.ts";
import type {
  PostChannel,
  RepoPreview,
  ShadowChannel,
} from "../lib/allowlists.ts";
import type { Output } from "../lib/job.ts";
import type { LinkHosts } from "../lib/link-hosts.ts";
import { firstLine } from "../lib/problem.ts";
import { plainText } from "../deliver/pr-text.ts";
import type { OpenedWriter } from "../deliver/github-writer.ts";
import {
  failedScenarios,
  scenarioMedia,
  videoAnswer,
  type FailedScenario,
  type ScenarioMedia,
} from "../deliver/media.ts";
import {
  readMediaFile,
  type MediaFile,
  type MediaManifest,
} from "../lib/media.ts";
import {
  cleanMessage,
  postProblem,
  shadowMessage,
} from "../deliver/slack-message.ts";
import type { OpenedPoster, PostedMessage } from "../deliver/slack-poster.ts";
import {
  deliverVideoMap,
  parseVideoMap,
  posterName,
  sitePath,
  videoNoun,
  type DeliveredMapPull,
  type DocsState,
  type UploadedVideo,
  type VideoEntry,
} from "../deliver/video-map.ts";
import {
  DAILY_QUOTA_UNITS,
  MAX_UPLOADS_PER_RUN,
  QUOTA_UNITS,
  studioUrl,
  videoResource,
  type OpenedYouTube,
  type VideoResource,
} from "../deliver/youtube.ts";
import {
  checkVideoAnswer,
  fullDescription,
  type VideoMetadata,
} from "../output-check/youtube.ts";
import type { ReportWriter } from "./report.ts";
import {
  escapeMrkdwn,
  footerBlock,
  type SlackMessage,
} from "./slack-render.ts";

/** What happened to a youtube job's videos. */
export interface YouTubeDeliveryRecord {
  /**
   * nothing: every video's media matches the map, or the media stage made
   * no video this run. report_only: kept in
   * the report, uploading nothing, while the job's map pull request is
   * open. shadow: a shadow or stub run, which uploads nothing. delivered:
   * videos were uploaded and recorded in a pull request.
   */
  outcome: "nothing" | "report_only" | "shadow" | "delivered";
  reason?: string;
  docsRepo: string;
  mapPath: string;
  /** The commit the map file was read at; none in a stub run. */
  base?: string;
  videos: {
    scenario: string;
    /** defer: over one run's upload limit; the next run uploads it. */
    action: "upload" | "skip" | "defer";
    hash: string;
    source?: string;
    playlist?: string;
    youtubeId?: string;
    /** The video the map recorded before, when it records another. */
    replaces?: string;
  }[];
  quotaUnits: number;
  /** Scenarios the media stage could not record this run; the run fails after delivering the rest. */
  notRecorded?: { scenario: string; reason: string }[];
  pull?: DeliveredMapPull;
  /** The review notice a live run posted, or the line a shadow run posted to the shadow channel. */
  notice?: PostedMessage;
  /** Videos on the channel that the map does not record, because a later step failed; delete them in Studio. */
  orphans?: { scenario: string; youtubeId: string }[];
  /** What went wrong after delivery, such as forgetting a token, or a shadow run's notice that could not be posted. */
  problems?: string[];
}

export interface YouTubeStageOptions {
  job: string;
  /** repos.yml's preview instructions for docs_repo, for the map pull request's body. */
  preview?: RepoPreview;
  output: Extract<Output, { kind: "youtube" }>;
  mode: "shadow" | "live";
  stub: boolean;
  runName: string;
  runUrl?: string;
  report: ReportWriter;
  now: Date;
  /** The media the media stage made: its directory and its checked media.json. */
  media: { dir: string; manifest: MediaManifest };
  /** link-hosts.yml: where the videos' texts may link. */
  linkHosts: LinkHosts;
  /** The channel the review notice goes to, if any, and the prefixes it may link to. */
  notify?: PostChannel;
  /** Where a shadow run of a job with notify posts its one line; without it a shadow run posts nothing. */
  shadowChannel?: ShadowChannel;
  slackLinks: readonly string[];
  /** Reads the map file and the job's open pull requests; a stub run without it reads nothing. */
  readDocs?: () => Promise<{ state: DocsState; secrets: string[] }>;
  openYouTube(): Promise<OpenedYouTube>;
  openWriter(repos: readonly string[]): Promise<OpenedWriter>;
  openPoster(): Promise<OpenedPoster>;
}

export type YouTubeStageResult = {
  record: YouTubeDeliveryRecord;
  failure?: string;
};

interface PlannedVideo {
  meta: VideoMetadata;
  media: ScenarioMedia;
  playlist?: string;
  resource: VideoResource;
  recorded?: VideoEntry;
  action: "upload" | "skip" | "defer";
}

/**
 * Holds back the uploads past one run's limit (YouTube's daily quota) for
 * the next run, which uploads them since the map still lacks them: videos
 * the map has never had go first, then those it has had longest.
 */
export function deferOverLimit<
  T extends { action: string; recorded?: { publishedAt?: string } },
>(plan: T[], limit = MAX_UPLOADS_PER_RUN): T[] {
  const uploads = plan.filter((v) => v.action === "upload");
  if (uploads.length <= limit) return plan;
  const age = (v: T) =>
    v.recorded === undefined ? "" : (v.recorded.publishedAt ?? "");
  const first = new Set(
    [...uploads]
      .sort((a, b) => (age(a) < age(b) ? -1 : age(a) > age(b) ? 1 : 0))
      .slice(0, limit),
  );
  return plan.map((v) =>
    v.action === "upload" && !first.has(v) ? { ...v, action: "defer" } : v,
  );
}

/** What the docs' video page shows beyond the embed: the description without its chapter lines, the chapters, the length and the committed files. */
function pageFields(v: PlannedVideo, dir: string): Partial<VideoEntry> {
  const at = `${sitePath(dir)}/${v.meta.scenario}`;
  return {
    description: v.meta.description,
    ...(v.meta.chapters.length === 0 ? {} : { chapters: v.meta.chapters }),
    ...(v.media.duration === undefined ? {} : { duration: v.media.duration }),
    poster: `${at}/${posterName(v.media.poster.type)}`,
    captions: `${at}/captions.vtt`,
  };
}

/**
 * Whether the map already records this media: the same media hash, or the
 * same source when both the media stage and the map recorded one. A
 * recording's bytes differ every run, so a job whose media stage records
 * its source is skipped by source; without one on either side the hash
 * alone decides.
 */
export function alreadyRecorded(
  media: Pick<ScenarioMedia, "hash" | "source">,
  recorded: Pick<VideoEntry, "hash" | "source"> | undefined,
): "hash" | "source" | undefined {
  if (recorded === undefined) return undefined;
  if (recorded.hash === media.hash) return "hash";
  if (
    media.source !== undefined &&
    recorded.source !== undefined &&
    recorded.source === media.source
  )
    return "source";
  return undefined;
}

function short(sha: string | undefined): string {
  return sha === undefined ? "none" : `\`${sha.slice(0, 12)}\``;
}

function unitsFor(plan: readonly PlannedVideo[]): number {
  const uploads = plan.filter((v) => v.action === "upload");
  if (uploads.length === 0) return 0;
  const playlists = new Set(uploads.flatMap((v) => v.playlist ?? []));
  return (
    QUOTA_UNITS.read +
    playlists.size * QUOTA_UNITS.read +
    uploads.length *
      (QUOTA_UNITS.videoInsert +
        QUOTA_UNITS.captionInsert +
        QUOTA_UNITS.thumbnailSet) +
    uploads.filter((v) => v.playlist !== undefined).length *
      QUOTA_UNITS.playlistItemInsert
  );
}

function fileRecord(f: MediaFile) {
  return { path: f.path, sha256: f.sha256, bytes: f.bytes, type: f.type };
}

/** Where the report keeps a scenario source file docs_source_dir commits. */
export const SOURCES_DIR = "delivery/youtube-sources";

/** Why a scenario source file is not UTF-8 JSON, or undefined when it is. */
function sourceProblem(bytes: Buffer): string | undefined {
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return undefined;
  } catch (err) {
    return err instanceof TypeError ? "is not UTF-8" : "is not JSON";
  }
}

function planMarkdown(
  o: YouTubeStageOptions,
  plan: readonly PlannedVideo[],
  docs: DocsState | undefined,
  units: number,
  missing: readonly FailedScenario[],
): string {
  const lines = [
    `# ${o.job}: YouTube upload plan`,
    "",
    `Mode ${o.mode}${o.stub ? " (stub)" : ""}. Every upload is private; a person publishes it in YouTube Studio.`,
    "",
    `Map: \`${o.output.docs_repo}/${o.output.map_path}\` ${docs === undefined ? "not read (a stub run reads nothing)" : `at \`${docs.base.slice(0, 12)}\`${docs.text === undefined ? ", not there yet" : ""}`}.`,
    "",
    `Uploads: ${plan.filter((v) => v.action === "upload").length} of at most ${MAX_UPLOADS_PER_RUN}, about ${units} of ${DAILY_QUOTA_UNITS} daily quota units.`,
    "",
    `Review: ${o.output.review_team === undefined ? "no team is asked to review the map pull request" : `team \`${o.output.review_team}\` is asked to review the map pull request when it is opened`}.`,
    "",
    `Docs page files: ${o.output.docs_media_dir === undefined ? "none; the map pull request changes only the map file" : `each upload's poster and captions are committed to \`${o.output.docs_media_dir}/<scenario>/\` with its description, chapters and length in the map entry`}.`,
    "",
    ...(o.output.docs_source_dir === undefined
      ? []
      : [
          `Scenario sources: each upload's scenario file is committed to \`${o.output.docs_source_dir}/\` at its path in the media directory; this run's are kept in \`${SOURCES_DIR}/\`.`,
          "",
        ]),
    `Check run: \`${checkName(o.job)}\` on the map pull request's head commit, completed when it is opened.`,
    "",
  ];
  if (docs !== undefined && docs.openPulls.length > 0)
    lines.push(
      `Open map pull requests of this job: ${docs.openPulls.map((p) => `#${p.number}`).join(", ")}; nothing is uploaded until they are merged or closed.`,
      "",
    );
  for (const m of missing)
    lines.push(
      `## ${m.scenario}: not recorded`,
      "",
      `The media stage could not record it this run, so its video is unchanged: ${plainText(m.reason)}`,
      "",
    );
  for (const v of plan) {
    lines.push(
      `## ${v.meta.scenario}: ${v.action}`,
      "",
      v.action === "defer"
        ? `Waits for the next run: one run uploads at most ${MAX_UPLOADS_PER_RUN} videos, within YouTube's daily quota. Media hash \`${v.media.hash.slice(0, 12)}\`, source ${short(v.media.source)}.`
        : v.action === "skip"
          ? alreadyRecorded(v.media, v.recorded) === "hash"
            ? `The map records \`${v.recorded!.youtubeId}\` with this media hash, \`${v.media.hash.slice(0, 12)}\`.`
            : `The map records \`${v.recorded!.youtubeId}\` with this source, ${short(v.media.source)}.`
          : `Media hash \`${v.media.hash.slice(0, 12)}\`, source ${short(v.media.source)}${v.recorded === undefined ? ", not in the map yet" : `, the map records \`${v.recorded.youtubeId}\` with media hash \`${v.recorded.hash.slice(0, 12)}\` and source ${short(v.recorded.source)}`}.`,
      "",
      `- Video: \`${v.media.video.path}\` (${v.media.video.bytes} bytes)`,
      `- Captions: \`${v.media.captions.path}\``,
      `- Poster: \`${v.media.poster.path}\``,
      `- Playlist: ${v.playlist === undefined ? "none" : `\`${v.playlist}\``}`,
      `- Tags: ${v.resource.snippet.tags.length === 0 ? "none" : v.resource.snippet.tags.map((t) => `\`${t}\``).join(", ")}`,
      ...(v.media.sourceFile === undefined ||
      o.output.docs_source_dir === undefined
        ? []
        : [
            `- Scenario source: \`${v.media.sourceFile.path}\`, committed as \`${o.output.docs_source_dir}/${v.media.sourceFile.path}\``,
          ]),
      ...(v.media.leftOut ?? []).map(
        (item) =>
          `- Left out: ${plainText(item.title)}: ${plainText(item.why)}`,
      ),
      "",
      "Title and description, as uploaded:",
      "",
      ...`${v.resource.snippet.title}\n\n${v.resource.snippet.description}`
        .split("\n")
        .map((line) => (line.trim() === "" ? ">" : `> ${plainText(line)}`)),
      "",
    );
  }
  return lines.join("\n");
}

function noticeMessage(
  o: YouTubeStageOptions,
  uploaded: readonly UploadedVideo[],
  pull: DeliveredMapPull,
): SlackMessage {
  const n = uploaded.length;
  const what = `${n} ${videoNoun(n, o.output.video_noun)} uploaded to YouTube as private, waiting for review`;
  const list = uploaded
    .map(
      (v) =>
        `• <${studioUrl(v.entry.youtubeId)}|${v.scenario}>: ${escapeMrkdwn(v.entry.title)}`,
    )
    .join("\n");
  const leftOut = uploaded.flatMap((v) =>
    v.leftOut === undefined || v.leftOut.length === 0
      ? []
      : [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: [
                `Left out of ${escapeMrkdwn(v.entry.title)}:`,
                ...v.leftOut.map(
                  (item) =>
                    `• ${escapeMrkdwn(item.title)}: ${escapeMrkdwn(item.why)}`,
                ),
              ].join("\n"),
            },
          },
        ],
  );
  return {
    text: `${o.job}: ${what}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${o.job}*: ${what}.` },
      },
      { type: "section", text: { type: "mrkdwn", text: list } },
      ...leftOut,
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Watch each one in YouTube Studio and set it to Public or Unlisted there, then merge <${pull.url}|${pull.repo}#${pull.number}>, which records the new ids for the docs.`,
        },
      },
      footerBlock({ runUrl: o.runUrl, job: o.job, model: "none" }),
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

/** A shadow run's one line: what it would upload, and the run that keeps the plan. */
function shadowNoticeMessage(
  o: YouTubeStageOptions,
  uploads: readonly PlannedVideo[],
): SlackMessage {
  const n = uploads.length;
  const what = `would upload ${n} ${videoNoun(n, o.output.video_noun)} to YouTube as private for review`;
  const titles = uploads.map((v) => escapeMrkdwn(v.meta.title)).join("; ");
  const run =
    o.runUrl === undefined
      ? "the run's report"
      : `<${o.runUrl}|workflow run ${o.runUrl.slice(o.runUrl.lastIndexOf("/") + 1)}>`;
  return {
    text:
      o.runUrl === undefined
        ? `${o.job} ${what}`
        : `${o.job} ${what}: ${o.runUrl}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${o.job}* ${what} (${titles}); ${run} keeps ${n === 1 ? "it" : "them"} and the upload plan.`,
        },
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

/**
 * A shadow run of a job with notify posts one line to the shadow channel,
 * under the shadow line, when it would upload something; nothing when
 * channels.yml gives the shadow channel no id. delivery/youtube-notice.json
 * keeps the exact body. A post that fails is a problem in the record and
 * never fails the run.
 */
async function postShadowNotice(
  o: YouTubeStageOptions,
  record: YouTubeDeliveryRecord,
  uploads: readonly PlannedVideo[],
): Promise<void> {
  if (o.notify === undefined || uploads.length === 0) return;
  const cleaned = cleanMessage(shadowNoticeMessage(o, uploads), {
    prefixes: o.slackLinks,
    exact: o.runUrl === undefined ? [] : [o.runUrl],
  });
  const message = shadowMessage(cleaned.message, o.job, o.notify.name);
  const channel = o.shadowChannel;
  o.report.writeJson("delivery/youtube-notice.json", {
    channel: channel?.id ?? null,
    text: message.text,
    blocks: message.blocks,
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (channel === undefined) return;
  const problem = (why: string) => {
    record.problems = [...(record.problems ?? []), why];
  };
  const tooBig = postProblem(message);
  if (tooBig !== undefined)
    return problem(`the shadow notice breaks Slack's limits: ${tooBig}`);
  try {
    const poster = await o.openPoster();
    o.report.addSecrets(poster.secrets);
    record.notice = await poster.poster.post(channel.id, message);
  } catch (err) {
    problem(`the shadow notice to #${channel.name} failed: ${firstLine(err)}`);
  }
}

/**
 * The youtube output kind, after the job ran: the media manifest and its
 * files, the videos' metadata held to YouTube's limits and the kit's link
 * rules, the map file (the skip rule: media whose hash the map records is
 * not uploaded again), the upload limit, then the plan in the report. A
 * live run uploads each video private with its captions, thumbnail and
 * playlist, records the new ids in one pull request on the docs
 * repository, and posts a review notice. Shadow and stub runs stop at the
 * plan; a shadow run of a job with notify posts one line to the shadow
 * channel. Scenarios the media stage could not record (data.failed) are
 * named in the record and the map pull request; the rest are delivered as
 * usual, and the run still fails. A media stage that made no video ends
 * with nothing to deliver.
 */
export async function runYouTubeStage(
  o: YouTubeStageOptions,
): Promise<YouTubeStageResult> {
  const missing = failedScenarios(o.media.manifest);
  const result = await deliverRecorded(o, missing);
  if (missing.length === 0) return result;
  result.record.notRecorded = missing;
  const note = `${missing.length} scenario${missing.length === 1 ? " was" : "s were"} not recorded: ${missing.map((m) => `${m.scenario} (${m.reason})`).join("; ")}`;
  result.record.reason =
    result.record.reason === undefined
      ? note
      : `${result.record.reason}; ${note}`;
  return {
    record: result.record,
    failure: result.failure === undefined ? note : `${result.failure}; ${note}`,
  };
}

async function deliverRecorded(
  o: YouTubeStageOptions,
  missing: readonly FailedScenario[],
): Promise<YouTubeStageResult> {
  const record: YouTubeDeliveryRecord = {
    outcome: "report_only",
    docsRepo: o.output.docs_repo,
    mapPath: o.output.map_path,
    videos: [],
    quotaUnits: 0,
  };
  const fail = (reason: string, failure = reason): YouTubeStageResult => {
    record.reason = reason;
    return { record, failure };
  };

  const mediaDir = o.media.dir;
  const media = scenarioMedia(o.media.manifest);
  if ("error" in media) return fail(media.error);
  const answer = videoAnswer(o.media.manifest);
  o.report.writeJson("answer.json", answer);
  if (media.scenarios.size === 0) {
    record.outcome = "nothing";
    record.reason = "the media stage made no video this run";
    o.report.write(
      "delivery/youtube.md",
      `# ${o.job}: YouTube upload plan\n\nMode ${o.mode}${o.stub ? " (stub)" : ""}. The media stage made no video this run, so nothing is uploaded and the map is not read.\n`,
    );
    return { record };
  }
  const durations = new Map(
    [...media.scenarios.values()].flatMap((m) =>
      m.duration === undefined ? [] : [[m.scenario, m.duration] as const],
    ),
  );
  const checked = checkVideoAnswer(answer, {
    links: o.linkHosts,
    durations,
  });
  o.report.writeJson("youtube-check.json", checked);
  if (!checked.ok)
    return fail(
      "the videos' metadata breaks YouTube's or the kit's rules",
      `the videos' metadata breaks YouTube's or the kit's rules (${checked.problems.length} problem${checked.problems.length === 1 ? "" : "s"}; first: ${checked.problems[0]}); see youtube-check.json`,
    );
  for (const m of media.scenarios.values())
    for (const f of [m.video, m.captions, m.poster]) {
      try {
        readMediaFile(mediaDir, f);
      } catch (err) {
        return fail(firstLine(err));
      }
    }
  if (o.output.docs_source_dir !== undefined)
    for (const m of media.scenarios.values()) {
      if (m.sourceFile === undefined)
        return fail(
          `media.json: data.scenarios.${m.scenario} names no scenarioFile, and docs_source_dir commits one for every video`,
        );
      let bytes: Buffer;
      try {
        bytes = readMediaFile(mediaDir, m.sourceFile);
      } catch (err) {
        return fail(firstLine(err));
      }
      const problem = sourceProblem(bytes);
      if (problem !== undefined)
        return fail(
          `${m.scenario}'s scenarioFile ${m.sourceFile.path} ${problem}`,
        );
      if (!o.report.writeBytes(`${SOURCES_DIR}/${m.sourceFile.path}`, bytes))
        return fail(
          `${m.scenario}'s scenarioFile ${m.sourceFile.path} holds a secret value, so it is neither kept nor committed`,
        );
    }

  let docs: DocsState | undefined;
  if (o.readDocs !== undefined) {
    try {
      const got = await o.readDocs();
      o.report.addSecrets(got.secrets);
      docs = got.state;
    } catch (err) {
      return fail(
        `reading ${o.output.docs_repo}/${o.output.map_path} failed: ${firstLine(err)}`,
      );
    }
    record.base = docs.base;
  }
  const recorded = parseVideoMap(docs?.text);
  if ("error" in recorded)
    return fail(
      `${o.output.docs_repo}/${o.output.map_path} ${recorded.error}, so the skip rule cannot be applied`,
    );

  const plan: PlannedVideo[] = deferOverLimit(
    checked.videos.map((meta) => {
      const m = media.scenarios.get(meta.scenario)!;
      const before = recorded.entries.get(meta.scenario);
      const playlist = meta.playlist ?? o.output.playlist ?? undefined;
      return {
        meta,
        media: m,
        ...(playlist === undefined ? {} : { playlist }),
        resource: videoResource({
          title: meta.title,
          description: fullDescription(meta),
          tags: meta.tags,
        }),
        ...(before === undefined ? {} : { recorded: before }),
        action: alreadyRecorded(m, before) === undefined ? "upload" : "skip",
      } satisfies PlannedVideo;
    }),
  );
  const uploads = plan.filter((v) => v.action === "upload");
  record.quotaUnits = unitsFor(plan);
  record.videos = plan.map((v) => ({
    scenario: v.meta.scenario,
    action: v.action,
    hash: v.media.hash,
    ...(v.media.source === undefined ? {} : { source: v.media.source }),
    ...(v.playlist === undefined ? {} : { playlist: v.playlist }),
    ...(v.recorded === undefined || v.action !== "upload"
      ? {}
      : { replaces: v.recorded.youtubeId }),
  }));
  o.report.writeJson("delivery/youtube-plan.json", {
    job: o.job,
    mode: o.mode,
    docsRepo: o.output.docs_repo,
    mapPath: o.output.map_path,
    base: docs?.base ?? null,
    mapRead: docs !== undefined,
    openPulls: docs?.openPulls ?? [],
    uploads: uploads.length,
    maxUploads: MAX_UPLOADS_PER_RUN,
    quotaUnits: record.quotaUnits,
    dailyQuotaUnits: DAILY_QUOTA_UNITS,
    videos: plan.map((v) => ({
      scenario: v.meta.scenario,
      action: v.action,
      hash: v.media.hash,
      source: v.media.source ?? null,
      recorded: v.recorded ?? null,
      playlist: v.playlist ?? null,
      files: {
        video: fileRecord(v.media.video),
        captions: fileRecord(v.media.captions),
        poster: fileRecord(v.media.poster),
        ...(v.media.sourceFile === undefined
          ? {}
          : { scenarioFile: fileRecord(v.media.sourceFile) }),
      },
      ...(v.media.leftOut === undefined ? {} : { leftOut: v.media.leftOut }),
      resource: v.resource,
    })),
  });
  o.report.write(
    "delivery/youtube.md",
    planMarkdown(o, plan, docs, record.quotaUnits, missing),
  );

  if (o.stub || o.mode === "shadow") {
    record.outcome = "shadow";
    record.reason = o.stub
      ? "a stub run uploads nothing"
      : "a shadow run uploads nothing; delivery/youtube.md holds what it would upload";
    if (!o.stub) await postShadowNotice(o, record, uploads);
    return { record };
  }
  if (uploads.length === 0) {
    record.outcome = "nothing";
    record.reason = "the map records every video's media hash or source";
    return { record };
  }
  if (docs === undefined)
    return fail("a live run needs the map file read before it uploads");
  if (docs.openPulls.length > 0) {
    record.reason = `the job's map pull request ${docs.openPulls.map((p) => `#${p.number}`).join(", ")} in ${o.output.docs_repo} is still open; merge or close it, then run again`;
    return { record };
  }

  let opened: OpenedYouTube;
  try {
    opened = await o.openYouTube();
  } catch (err) {
    return fail(
      firstLine(err),
      `the YouTube uploader could not start: ${firstLine(err)}`,
    );
  }
  o.report.addSecrets(opened.secrets);
  const uploaded: UploadedVideo[] = [];
  const orphans: { scenario: string; youtubeId: string }[] = [];
  let uploadFailure: string | undefined;
  try {
    const playlistIds = new Map<string, string>();
    for (const title of new Set(uploads.flatMap((v) => v.playlist ?? [])))
      playlistIds.set(title, await opened.youtube.findPlaylist(title));
    for (const v of uploads) {
      const scenario = v.meta.scenario;
      let id: string | undefined;
      let source: { path: string; bytes: Buffer } | undefined;
      try {
        if (
          o.output.docs_source_dir !== undefined &&
          v.media.sourceFile !== undefined
        )
          source = {
            path: v.media.sourceFile.path,
            bytes: readMediaFile(mediaDir, v.media.sourceFile),
          };
        const video = readMediaFile(mediaDir, v.media.video);
        const captions = readMediaFile(mediaDir, v.media.captions);
        const poster = readMediaFile(mediaDir, v.media.poster);
        const done = await opened.youtube.uploadVideo(video, v.resource);
        id = done.id;
        await opened.youtube.insertCaptions(id, captions);
        await opened.youtube.setThumbnail(id, poster, v.media.poster.type);
        if (v.playlist !== undefined)
          await opened.youtube.addToPlaylist(playlistIds.get(v.playlist)!, id);
      } catch (err) {
        if (id !== undefined) orphans.push({ scenario, youtubeId: id });
        uploadFailure = `uploading ${scenario} failed: ${firstLine(err)}`;
        break;
      }
      const dir = o.output.docs_media_dir;
      uploaded.push({
        scenario,
        entry: {
          youtubeId: id,
          title: v.meta.title,
          hash: v.media.hash,
          ...(v.media.source === undefined ? {} : { source: v.media.source }),
          publishedAt: o.now.toISOString(),
          ...(dir === undefined ? {} : pageFields(v, dir)),
        },
        ...(v.recorded === undefined ? {} : { replaces: v.recorded.youtubeId }),
        ...(dir === undefined
          ? {}
          : {
              files: {
                poster: {
                  bytes: readMediaFile(mediaDir, v.media.poster),
                  type: v.media.poster.type,
                },
                captions: readMediaFile(mediaDir, v.media.captions),
              },
            }),
        ...(source === undefined ? {} : { sourceFile: source }),
        ...(v.media.leftOut === undefined ? {} : { leftOut: v.media.leftOut }),
      });
      record.videos.find((r) => r.scenario === scenario)!.youtubeId = id;
    }
  } catch (err) {
    uploadFailure = `the playlist lookup failed: ${firstLine(err)}; nothing was uploaded`;
  } finally {
    opened.close();
  }
  if (orphans.length > 0) {
    record.orphans = orphans;
    uploadFailure = `${uploadFailure}; ${orphans.map((x) => `${x.youtubeId} (${x.scenario})`).join(", ")} is on the channel, private and incomplete: delete it in YouTube Studio`;
  }
  if (uploaded.length === 0) return fail(uploadFailure ?? "nothing uploaded");

  let writer: OpenedWriter;
  try {
    writer = await o.openWriter([o.output.docs_repo]);
  } catch (err) {
    return fail(
      firstLine(err),
      `the videos are uploaded but the pull request writer could not start: ${firstLine(err)}; record ${uploaded.map((v) => `${v.scenario} = ${v.entry.youtubeId}`).join(", ")} by hand`,
    );
  }
  o.report.addSecrets(writer.secrets);
  try {
    record.pull = await deliverVideoMap(
      writer.writer,
      docs,
      uploaded,
      {
        job: o.job,
        runName: o.runName,
        ...(o.runUrl === undefined ? {} : { runUrl: o.runUrl }),
        ...(o.output.review_team === undefined
          ? {}
          : { reviewTeam: o.output.review_team }),
        ...(o.preview === undefined ? {} : { preview: o.preview }),
        ...(o.output.docs_media_dir === undefined
          ? {}
          : { mediaDir: o.output.docs_media_dir }),
        ...(o.output.docs_source_dir === undefined
          ? {}
          : { sourceDir: o.output.docs_source_dir }),
        ...(o.output.video_noun === undefined
          ? {}
          : { videoNoun: o.output.video_noun }),
        ...(missing.length === 0 ? {} : { notRecorded: missing }),
        ...(plan.some((v) => v.action === "defer")
          ? {
              deferred: plan
                .filter((v) => v.action === "defer")
                .map((v) => v.meta.scenario),
            }
          : {}),
        playlists: new Map(
          uploads.flatMap((v) =>
            v.playlist === undefined
              ? []
              : [[v.meta.scenario, v.playlist] as const],
          ),
        ),
      },
      o.now,
    );
  } catch (err) {
    return fail(
      firstLine(err),
      `the videos are uploaded but recording them failed: ${firstLine(err)}; record ${uploaded.map((v) => `${v.scenario} = ${v.entry.youtubeId}`).join(", ")} by hand`,
    );
  } finally {
    await writer.close().catch((err: unknown) => {
      record.problems = [
        `revoking the writer token failed: ${firstLine(err)}; it expires within the hour`,
      ];
    });
  }
  record.outcome = "delivered";

  if (o.notify !== undefined) {
    const message = noticeMessage(o, uploaded, record.pull);
    const cleaned = cleanMessage(message, {
      prefixes: o.slackLinks,
      exact: [
        ...(o.runUrl === undefined ? [] : [o.runUrl]),
        ...uploaded.map((v) => studioUrl(v.entry.youtubeId)),
      ],
    });
    o.report.writeJson("delivery/youtube-notice.json", {
      channel: o.notify.id ?? null,
      text: cleaned.message.text,
      blocks: cleaned.message.blocks,
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    const problem = postProblem(cleaned.message);
    const channelId = o.notify.id;
    const noticeFailure =
      problem !== undefined
        ? `the review notice breaks Slack's limits: ${problem}`
        : channelId === undefined
          ? `#${o.notify.name} has no id in channels.yml`
          : undefined;
    if (noticeFailure !== undefined)
      uploadFailure ??= `the videos are uploaded and recorded, but ${noticeFailure}`;
    else
      try {
        const poster = await o.openPoster();
        o.report.addSecrets(poster.secrets);
        record.notice = await poster.poster.post(channelId!, cleaned.message);
      } catch (err) {
        uploadFailure ??= `the videos are uploaded and recorded, but the review notice to #${o.notify.name} failed: ${firstLine(err)}`;
      }
  }
  if (uploadFailure !== undefined) record.reason = uploadFailure;
  return uploadFailure === undefined
    ? { record }
    : { record, failure: uploadFailure };
}
