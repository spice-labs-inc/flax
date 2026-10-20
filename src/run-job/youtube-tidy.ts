import type { PostChannel } from "../lib/allowlists.ts";
import type { UnlistReplaced } from "../lib/job.ts";
import { firstLine } from "../lib/problem.ts";
import { cleanMessage, postProblem } from "../deliver/slack-message.ts";
import type { OpenedPoster, PostedMessage } from "../deliver/slack-poster.ts";
import {
  replacedVideos,
  type MappedVideo,
  type VideoHistory,
} from "../deliver/video-history.ts";
import {
  QUOTA_UNITS,
  studioUrl,
  tidyGuard,
  type OpenedYouTube,
  type PlaylistEntry,
  type VideoStatus,
} from "../deliver/youtube.ts";
import type { ReportWriter } from "./report.ts";
import {
  escapeMrkdwn,
  footerBlock,
  type SlackMessage,
} from "./slack-render.ts";

/** One replaced video in a tidy run: where it was found and what is done to it. */
export interface TidyVideo {
  scenario: string;
  youtubeId: string;
  /** The map pull request that added it. */
  pull: number;
  /** As YouTube reports it; gone when the channel no longer has it, unread when the run read no YouTube state. */
  privacy: string;
  /** Titles of the managed playlists that hold it. */
  playlists: string[];
  unlist: boolean;
  /** What a live run did. */
  done?: string[];
}

export interface YouTubeTidyRecord {
  /** nothing: no replaced video needs a change. shadow: planned only. tidied: a live run made the changes. */
  outcome: "nothing" | "shadow" | "tidied";
  mode: "shadow" | "live";
  reason?: string;
  docsRepo: string;
  mapPath: string;
  base?: string;
  videos: TidyVideo[];
  /** Added only by map pull requests closed without merging: uploaded, never in the docs; a person decides. */
  neverMapped: MappedVideo[];
  /** Map pull requests whose map could not be read. */
  unread: number[];
  quotaUnits: number;
  notice?: PostedMessage;
  problems?: string[];
}

export interface YouTubeTidyOptions {
  job: string;
  tidy: UnlistReplaced;
  docsRepo: string;
  mapPath: string;
  stub: boolean;
  runUrl?: string;
  report: ReportWriter;
  /** Reads the map now and the job's map pull requests; a stub run without it reads nothing. */
  readHistory?: () => Promise<{ history: VideoHistory; secrets: string[] }>;
  /** Opens the grant to read the videos' state, and in live mode to change them; a run without it plans from the map history alone. */
  openYouTube?: () => Promise<OpenedYouTube>;
  notify?: PostChannel;
  slackLinks: readonly string[];
  openPoster(): Promise<OpenedPoster>;
}

function planMarkdown(o: YouTubeTidyOptions, r: YouTubeTidyRecord): string {
  const lines = [
    `# ${o.job}: replaced videos`,
    "",
    `Mode ${r.mode}${o.stub ? " (stub)" : ""}. A replaced video is one the job's merged map pull requests added to \`${r.docsRepo}/${r.mapPath}\` and the map no longer records. It is taken out of the job's playlists (${o.tidy.playlists.map((p) => `\`${p}\``).join(", ")}) and set from public to unlisted; nothing is deleted or made public, and no other video is touched.`,
    "",
    `Map read at ${r.base === undefined ? "nothing (a stub run reads nothing)" : `\`${r.base.slice(0, 12)}\``}. About ${r.quotaUnits} quota units.`,
    "",
  ];
  if (r.videos.length === 0) lines.push("No replaced video.", "");
  for (const v of r.videos) {
    const changes = [
      ...v.playlists.map((p) => `take out of \`${p}\``),
      ...(v.unlist ? ["set to unlisted"] : []),
    ];
    lines.push(
      `## ${v.scenario}: \`${v.youtubeId}\``,
      "",
      `Added by #${v.pull}; now ${v.privacy}. ${changes.length === 0 ? "Nothing to change." : `${r.mode === "live" && !o.stub ? "Changes" : "Would"}: ${changes.join(", ")}.`}${v.done === undefined || v.done.length === 0 ? "" : ` Done: ${v.done.join(", ")}.`}`,
      "",
    );
  }
  if (r.neverMapped.length > 0)
    lines.push(
      "## Uploaded but never in the docs",
      "",
      "Added only by map pull requests closed without merging. The run leaves them; delete or keep them in YouTube Studio.",
      "",
      ...r.neverMapped.map(
        (v) => `- \`${v.youtubeId}\` (${v.scenario}, #${v.pull})`,
      ),
      "",
    );
  if (r.unread.length > 0)
    lines.push(
      `Map pull requests whose map could not be read, so their videos are not known: ${r.unread.map((n) => `#${n}`).join(", ")}.`,
      "",
    );
  for (const p of r.problems ?? []) lines.push(`Problem: ${p}`, "");
  return lines.join("\n");
}

function noticeMessage(
  o: YouTubeTidyOptions,
  changed: readonly TidyVideo[],
): SlackMessage {
  const what = `${changed.length} replaced demo video${changed.length === 1 ? "" : "s"} unlisted and taken out of playlists`;
  return {
    text: `${o.job}: ${what}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${o.job}*: ${what}; old links still play them.\n${changed.map((v) => `• <${studioUrl(v.youtubeId)}|${escapeMrkdwn(v.scenario)}>`).join("\n")}`,
        },
      },
      footerBlock({ runUrl: o.runUrl, job: o.job, model: "none" }),
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

/**
 * The tidy run of a youtube job with unlist_replaced: reads which videos
 * the job's merged map pull requests added and the map no longer records,
 * reads their state on the channel, plans taking each out of the job's
 * playlists and setting it from public to unlisted, and in live mode does
 * it through tidyGuard, which refuses any other video. One notice goes out
 * only when something changed.
 */
export async function runYouTubeTidy(
  o: YouTubeTidyOptions,
): Promise<{ record: YouTubeTidyRecord; failure?: string }> {
  const record: YouTubeTidyRecord = {
    outcome: "nothing",
    mode: o.tidy.mode,
    docsRepo: o.docsRepo,
    mapPath: o.mapPath,
    videos: [],
    neverMapped: [],
    unread: [],
    quotaUnits: 0,
  };
  const problems: string[] = [];
  const finish = (
    failure?: string,
  ): { record: YouTubeTidyRecord; failure?: string } => {
    if (problems.length > 0) record.problems = problems;
    o.report.writeJson("delivery/youtube-tidy.json", record);
    o.report.write("delivery/youtube-tidy.md", planMarkdown(o, record));
    const why = failure ?? (problems.length > 0 ? problems[0] : undefined);
    return why === undefined ? { record } : { record, failure: why };
  };

  let history: VideoHistory | undefined;
  if (o.readHistory !== undefined) {
    try {
      const got = await o.readHistory();
      o.report.addSecrets(got.secrets);
      history = got.history;
    } catch (err) {
      record.reason = `reading ${o.docsRepo}/${o.mapPath} and its history failed: ${firstLine(err)}`;
      return finish(record.reason);
    }
    record.base = history.base;
    record.neverMapped = history.neverMapped;
    record.unread = history.unread;
  }
  const replaced = history === undefined ? [] : replacedVideos(history);
  record.videos = replaced.map((v) => ({
    ...v,
    privacy: "unread",
    playlists: [],
    unlist: false,
  }));
  const live = o.tidy.mode === "live" && !o.stub;

  let opened: OpenedYouTube | undefined;
  if (replaced.length > 0 && o.openYouTube !== undefined && !o.stub) {
    try {
      opened = await o.openYouTube();
    } catch (err) {
      record.reason = `the YouTube grant could not be opened: ${firstLine(err)}`;
      return finish(record.reason);
    }
    o.report.addSecrets(opened.secrets);
  }
  try {
    if (opened !== undefined) {
      if (opened.tidier === undefined) {
        record.reason = "the YouTube grant offers no tidier";
        return finish(record.reason);
      }
      const tidier = tidyGuard(
        opened.tidier,
        new Set(replaced.map((v) => v.youtubeId)),
      );
      let statuses: Map<string, VideoStatus>;
      const entries = new Map<string, PlaylistEntry[]>();
      try {
        statuses = await tidier.videoStatuses(replaced.map((v) => v.youtubeId));
        record.quotaUnits += Math.ceil(replaced.length / 50) * QUOTA_UNITS.read;
        for (const title of o.tidy.playlists) {
          let id: string;
          try {
            id = await tidier.findPlaylist(title);
          } catch (err) {
            problems.push(firstLine(err));
            continue;
          }
          entries.set(title, await tidier.playlistEntries(id));
          record.quotaUnits += 2 * QUOTA_UNITS.read;
        }
      } catch (err) {
        record.reason = `reading the videos' state failed: ${firstLine(err)}`;
        return finish(record.reason);
      }
      for (const v of record.videos) {
        const status = statuses.get(v.youtubeId);
        v.privacy = status?.privacyStatus ?? "gone";
        v.playlists = [...entries]
          .filter(([, list]) => list.some((e) => e.videoId === v.youtubeId))
          .map(([title]) => title);
        v.unlist = status?.privacyStatus === "public";
        record.quotaUnits +=
          v.playlists.length * QUOTA_UNITS.playlistItemDelete +
          (v.unlist ? QUOTA_UNITS.videoUpdate : 0);
      }
      const pending = record.videos.filter(
        (v) => v.unlist || v.playlists.length > 0,
      );
      if (pending.length === 0) {
        record.reason =
          "every replaced video is already out of the playlists and not public";
        return finish();
      }
      if (!live) {
        record.outcome = "shadow";
        record.reason = o.stub
          ? "a stub run changes nothing"
          : "unlist_replaced is in shadow mode; delivery/youtube-tidy.md holds what it would change";
        return finish();
      }
      for (const v of pending) {
        v.done = [];
        for (const title of v.playlists)
          for (const e of entries
            .get(title)!
            .filter((x) => x.videoId === v.youtubeId))
            try {
              await tidier.removePlaylistEntry(e);
              v.done.push(`out of ${title}`);
            } catch (err) {
              problems.push(
                `taking ${v.youtubeId} out of ${title} failed: ${firstLine(err)}`,
              );
            }
        if (v.unlist)
          try {
            await tidier.setUnlisted(v.youtubeId, statuses.get(v.youtubeId)!);
            v.done.push("unlisted");
          } catch (err) {
            problems.push(`unlisting ${v.youtubeId} failed: ${firstLine(err)}`);
          }
      }
      record.outcome = "tidied";
    } else if (replaced.length > 0) {
      record.outcome = "shadow";
      record.reason = o.stub
        ? "a stub run reads and changes nothing"
        : "no YouTube grant in this run, so the videos' state was not read and nothing changed";
      return finish();
    } else {
      record.reason = "no replaced video";
      return finish();
    }
  } finally {
    opened?.close();
  }

  const changed = record.videos.filter((v) => (v.done ?? []).length > 0);
  if (changed.length > 0 && o.notify !== undefined) {
    const cleaned = cleanMessage(noticeMessage(o, changed), {
      prefixes: o.slackLinks,
      exact: [
        ...(o.runUrl === undefined ? [] : [o.runUrl]),
        ...changed.map((v) => studioUrl(v.youtubeId)),
      ],
    });
    const problem = postProblem(cleaned.message);
    if (problem !== undefined)
      problems.push(`the notice breaks Slack's limits: ${problem}`);
    else if (o.notify.id === undefined)
      problems.push(`#${o.notify.name} has no id in channels.yml`);
    else
      try {
        const poster = await o.openPoster();
        o.report.addSecrets(poster.secrets);
        record.notice = await poster.poster.post(o.notify.id, cleaned.message);
      } catch (err) {
        problems.push(
          `the notice to #${o.notify.name} failed: ${firstLine(err)}`,
        );
      }
  }
  return finish();
}
