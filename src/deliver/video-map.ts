import { workspace } from "../lib/workspace.ts";
import { byCodePoint } from "../lib/sort.ts";
import { SCENARIO_ID } from "../output-check/youtube.ts";
import {
  createInstallationToken,
  GITHUB_API,
  githubOrg,
} from "../tools-server/github.ts";
import type { RepoPreview } from "../lib/allowlists.ts";
import { requestReviews, type ReviewRequests } from "./deliver.ts";
import { code, plainText, previewSection } from "./pr-text.ts";
import { MAX_UPLOADS_PER_RUN, studioUrl } from "./youtube.ts";
import { writeCheck, type CheckFields, type CheckRecord } from "./checks.ts";
import {
  commitAuthor,
  deliveryBranch,
  isAgentBranch,
  jobBranchPrefix,
  type PrWriter,
} from "./writer.ts";

/** One scenario's entry in the map file: the video the docs embed for it. */
export interface VideoEntry {
  youtubeId: string;
  title: string;
  /** The media hash of the files that were uploaded. */
  hash: string;
  /** sha256 of what the uploaded video was made from, when its media stage recorded it. */
  source?: string;
  publishedAt: string;
  /** For the docs' video page, written when the job sets docs_media_dir: the scenario's description, without the chapter lines. */
  description?: string;
  chapters?: { start: number; title: string }[];
  /** Seconds. */
  duration?: number;
  /** Site paths of the files the pull request commits beside the map, such as /videos/<scenario>/poster.png. */
  poster?: string;
  captions?: string;
}

/** The poster and captions a video's map pull request commits for the docs, from the run's checked media files. */
export interface VideoDocsFiles {
  poster: { bytes: Buffer; type: string };
  captions: Buffer;
}

/** The map file in the docs repository as a run read it, at one commit of the default branch. */
export interface DocsState {
  repo: string;
  path: string;
  /** The default branch. */
  branch: string;
  /** The commit the file was read at; delivery writes on top of it. */
  base: string;
  /** The file's text; undefined when the file does not exist yet. */
  text?: string;
  /** The job's own open pull requests in the repository; a run uploads nothing while one is open. */
  openPulls: { number: number; url: string; branch: string }[];
}

const SHA = /^[0-9a-f]{40}$/;
const MAX_MAP_BYTES = 1024 * 1024;

/** The permissions the map read asks for, and all its token may have. */
export const MAP_READ_PERMISSIONS: Readonly<Record<string, "read">> = {
  contents: "read",
  metadata: "read",
  pull_requests: "read",
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The recorded entries of a map file, by scenario; entries of another shape are kept in the file but count as not recorded. */
export function parseVideoMap(
  text: string | undefined,
): { entries: Map<string, VideoEntry> } | { error: string } {
  const entries = new Map<string, VideoEntry>();
  if (text === undefined) return { entries };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "is not JSON" };
  }
  if (!isObject(data)) return { error: "is not a JSON object" };
  for (const [scenario, v] of Object.entries(data)) {
    if (
      isObject(v) &&
      typeof v.youtubeId === "string" &&
      typeof v.title === "string" &&
      typeof v.hash === "string" &&
      typeof v.publishedAt === "string"
    )
      entries.set(scenario, {
        youtubeId: v.youtubeId,
        title: v.title,
        hash: v.hash,
        ...(typeof v.source === "string" ? { source: v.source } : {}),
        publishedAt: v.publishedAt,
        ...pageFields(v),
      });
  }
  return { entries };
}

function pageFields(v: Record<string, unknown>): Partial<VideoEntry> {
  const chapters = Array.isArray(v.chapters)
    ? v.chapters.filter(
        (c): c is { start: number; title: string } =>
          isObject(c) &&
          typeof c.start === "number" &&
          typeof c.title === "string",
      )
    : undefined;
  return {
    ...(typeof v.description === "string"
      ? { description: v.description }
      : {}),
    ...(chapters === undefined ? {} : { chapters }),
    ...(typeof v.duration === "number" ? { duration: v.duration } : {}),
    ...(typeof v.poster === "string" ? { poster: v.poster } : {}),
    ...(typeof v.captions === "string" ? { captions: v.captions } : {}),
  };
}

/** The map file with these entries set: scenarios sorted, two-space JSON, a final newline. Entries not updated stay as they were. */
export function updatedMapText(
  text: string | undefined,
  updates: ReadonlyMap<string, VideoEntry>,
): string {
  const data: Record<string, unknown> =
    text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>);
  for (const [scenario, e] of updates)
    data[scenario] = {
      youtubeId: e.youtubeId,
      title: e.title,
      hash: e.hash,
      ...(e.source === undefined ? {} : { source: e.source }),
      publishedAt: e.publishedAt,
      ...(e.description === undefined ? {} : { description: e.description }),
      ...(e.chapters === undefined ? {} : { chapters: e.chapters }),
      ...(e.duration === undefined ? {} : { duration: e.duration }),
      ...(e.poster === undefined ? {} : { poster: e.poster }),
      ...(e.captions === undefined ? {} : { captions: e.captions }),
    };
  const sorted = Object.fromEntries(
    Object.keys(data)
      .sort(byCodePoint)
      .map((k) => [k, data[k]]),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export function repoPath(repo: string): string {
  const [owner, name, ...rest] = repo.split("/");
  if (owner !== githubOrg() || name === undefined || rest.length > 0)
    throw new Error(`${repo} is not a ${githubOrg()} repository`);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export interface MapReaderOptions {
  appId: string;
  privateKey: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: Date;
}

/**
 * Reads the map file at the head of the docs repository's default branch,
 * and the job's open pull requests there, with an installation token of
 * the reader app for that repository only, asking for contents,
 * metadata and pull requests read and nothing more. The token is revoked
 * when the read ends.
 */
export async function readDocsState(
  repo: string,
  path: string,
  job: string,
  options: MapReaderOptions,
): Promise<{ state: DocsState; secrets: string[] }> {
  const base = repoPath(repo);
  const api = options.apiUrl ?? GITHUB_API;
  const fetchFn = options.fetch ?? fetch;
  const token = await createInstallationToken({
    appId: options.appId,
    privateKey: options.privateKey,
    permissions: MAP_READ_PERMISSIONS,
    repositories: [repo.split("/")[1]!],
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const get = async (
    url: string,
    allow404 = false,
  ): Promise<unknown | undefined> => {
    const res = await fetchFn(`${api}${url}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `token ${token.token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (allow404 && res.status === 404) {
      await res.body?.cancel();
      return undefined;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`GET ${url.split("?")[0]} returned ${res.status}`);
    }
    return res.json();
  };
  try {
    const info = await get(base);
    const branch = isObject(info) ? info.default_branch : undefined;
    if (typeof branch !== "string" || branch === "")
      throw new Error(`${repo} names no default branch`);
    const ref = await get(
      `${base}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
    );
    const object = isObject(ref) ? ref.object : undefined;
    const head = isObject(object) ? object.sha : undefined;
    if (typeof head !== "string" || !SHA.test(head))
      throw new Error(`${repo} ${branch} has no head commit`);
    const file = await get(
      `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${head}`,
      true,
    );
    let text: string | undefined;
    if (file !== undefined) {
      if (
        !isObject(file) ||
        file.type !== "file" ||
        file.encoding !== "base64" ||
        typeof file.content !== "string"
      )
        throw new Error(`${repo}/${path} is not a file GitHub sends whole`);
      const bytes = Buffer.from(file.content, "base64");
      if (bytes.length > MAX_MAP_BYTES)
        throw new Error(`${repo}/${path} is over ${MAX_MAP_BYTES} bytes`);
      text = bytes.toString("utf8");
    }
    const openPulls: DocsState["openPulls"] = [];
    const pulls = await get(`${base}/pulls?state=open&per_page=100`);
    for (const p of Array.isArray(pulls) ? pulls : []) {
      if (!isObject(p) || typeof p.number !== "number") continue;
      const headRef = isObject(p.head) ? p.head : {};
      const headRepo = isObject(headRef.repo) ? headRef.repo : {};
      const user = isObject(p.user) ? p.user : {};
      if (
        typeof headRef.ref === "string" &&
        headRef.ref.startsWith(jobBranchPrefix(job)) &&
        headRepo.full_name === repo &&
        user.type === "Bot"
      )
        openPulls.push({
          number: p.number,
          url: typeof p.html_url === "string" ? p.html_url : "",
          branch: headRef.ref,
        });
    }
    return {
      state: {
        repo,
        path,
        branch,
        base: head,
        ...(text === undefined ? {} : { text }),
        openPulls,
      },
      secrets: [token.token],
    };
  } finally {
    await token.revoke().catch(() => undefined);
  }
}

/** One uploaded video, as the pull request records it. */
export interface UploadedVideo {
  scenario: string;
  entry: VideoEntry;
  /** The video the docs embedded for the scenario before, when there was one. */
  replaces?: string;
  /** The files the pull request commits for the docs' video page, when the job sets docs_media_dir. */
  files?: VideoDocsFiles;
  /** The scenario source file the pull request commits under docs_source_dir: its path there, relative to that folder, and its bytes. */
  sourceFile?: { path: string; bytes: Buffer };
  /** Items the media stage left out of this video, with why. */
  leftOut?: readonly { title: string; why: string }[];
}

/** The default name of one video in the review notice and the map pull request. */
export const VIDEO_NOUN = "demo video";

/** The job's noun for n videos: "demo video" for one, "demo videos" for more. */
export function videoNoun(n: number, noun = VIDEO_NOUN): string {
  return `${noun}${n === 1 ? "" : "s"}`;
}

/** The poster's file name for its media type. */
export function posterName(type: string): string {
  return type === "image/jpeg" ? "poster.jpg" : "poster.png";
}

/** Where the docs serve a file committed at path under public/: public/videos/x/a.png is /videos/x/a.png. */
export function sitePath(path: string): string {
  return path.replace(/^public(?=\/)/, "");
}

export interface MapPullMeta {
  job: string;
  runName: string;
  runUrl?: string;
  /** The playlist each video was added to, by scenario; none when absent. */
  playlists: ReadonlyMap<string, string>;
  /** The team asked to review a newly opened pull request; none when absent. */
  reviewTeam?: string;
  /** repos.yml's preview instructions for the docs repository. */
  preview?: RepoPreview;
  /** docs_media_dir: the folder under public/ the videos' files are committed to; none when absent. */
  mediaDir?: string;
  /** Scenarios the media stage could not record this run; their videos stay as they are. */
  notRecorded?: readonly { scenario: string; reason: string }[];
  /** Scenarios recorded but left for the next run by the upload limit. */
  deferred?: readonly string[];
  /** docs_source_dir: the folder the videos' scenario source files are committed to; none when absent. */
  sourceDir?: string;
  /** video_noun: what the body calls one video; "demo video" when absent. */
  videoNoun?: string;
}

export function mapPullTitle(job: string, count: number, day: string) {
  return `${job}: ${count} video${count === 1 ? "" : "s"} (${day})`;
}

/** The pull request body, written by the kit: video titles come from scenario files, so they appear only as plain text. */
export function mapPullBody(
  state: Pick<DocsState, "path" | "base" | "branch">,
  videos: readonly UploadedVideo[],
  meta: MapPullMeta,
  branch?: string,
): string {
  const run =
    meta.runUrl === undefined
      ? code(meta.runName)
      : `[${meta.runName}](${meta.runUrl})`;
  const n = videos.length;
  const lines = [
    `Points the docs at ${n} new ${videoNoun(n, meta.videoNoun)}, uploaded to the ${workspace().video?.channel ?? "video"} channel as **private**. Opened by the ${workspace().displayName} ${code(meta.job)}; a person reviews and merges it.`,
    "",
    "**Before merging**",
    "",
    `1. Watch each video in YouTube Studio (links below) and set it to Public or Unlisted. The docs embed a video only once this pull request is merged.`,
    "2. Merge.",
    `3. Nothing else: within a day the ${workspace().displayName} takes each replaced video out of its playlist and sets it to unlisted.`,
    "",
    "**What changed and why**",
    "",
  ];
  for (const v of videos) {
    lines.push(
      `- ${code(v.scenario)}: [${plainText(v.entry.title)}](${studioUrl(v.entry.youtubeId)})${v.replaces === undefined ? ", the scenario's first video" : `, replaces ${code(v.replaces)}`}${meta.playlists.has(v.scenario) ? `, playlist ${plainText(meta.playlists.get(v.scenario)!)}` : ""}${v.files !== undefined && meta.mediaDir !== undefined ? `, with its poster and captions in ${code(`${meta.mediaDir}/${v.scenario}/`)} for the docs' video page` : ""}${v.sourceFile !== undefined && meta.sourceDir !== undefined ? `, with its scenario source at ${code(`${meta.sourceDir}/${v.sourceFile.path}`)}` : ""}. Recorded because the scenario changed since its last published video.`,
    );
    for (const item of v.leftOut ?? [])
      lines.push(
        `  - Left out of this video: ${plainText(item.title)}: ${plainText(item.why)}`,
      );
  }
  for (const f of meta.notRecorded ?? [])
    lines.push(
      `- ${code(f.scenario)}: not recorded this run, so its video is unchanged: ${plainText(f.reason)}`,
    );
  for (const scenario of meta.deferred ?? [])
    lines.push(
      `- ${code(scenario)}: recorded, but left for the next run, since one run uploads at most ${MAX_UPLOADS_PER_RUN} videos.`,
    );
  lines.push(
    "",
    ...(branch === undefined ? [] : previewSection(meta.preview, [], branch)),
    "**Reviewing**",
    "",
    `No model wrote this change, so no ${workspace().displayName} answers comments here.`,
    "",
    "<details><summary>Run details</summary>",
    "",
    "| | |",
    "| --- | --- |",
    `| Run | ${run} |`,
    `| Base | ${code(state.base.slice(0, 12))} |`,
    `| Map file | ${code(state.path)} |`,
    "",
    "| Scenario | Video | Media hash |",
    "| --- | --- | --- |",
    ...videos.map(
      (v) =>
        `| ${code(v.scenario)} | ${code(v.entry.youtubeId)} | ${code(v.entry.hash.slice(0, 12))} |`,
    ),
    "",
    "</details>",
    "",
  );
  return lines.join("\n");
}

export interface DeliveredMapPull {
  repo: string;
  number: number;
  url: string;
  branch: string;
  commit: string;
  /** true when the day's branch already had an open pull request, which now shows the new commit. */
  updated: boolean;
  /** The review requests of a newly opened pull request; none on an update. */
  reviews?: ReviewRequests;
  /** The ${workspace().displayName} check run on the pull request's new head commit. */
  check?: CheckRecord;
}

/** The completed check on the map pull request: which private uploads it records and what a reviewer does first. */
export function mapPullCheck(
  videos: readonly UploadedVideo[],
  runUrl?: string,
  notRecorded: readonly { scenario: string; reason: string }[] = [],
): CheckFields {
  const n = videos.length;
  const m = notRecorded.length;
  return {
    status: "completed",
    conclusion: m === 0 ? "success" : "neutral",
    title: `${n} video${n === 1 ? "" : "s"} uploaded as private; publish in YouTube Studio before merging${m === 0 ? "" : `; ${m} not recorded this run`}`,
    summary: [
      "**Uploaded as private:**",
      "",
      ...videos.map(
        (v) =>
          `- \`${v.scenario}\`: [\`${v.entry.youtubeId}\`](${studioUrl(v.entry.youtubeId)})${v.replaces === undefined ? "" : `, replaces \`${v.replaces}\``}`,
      ),
      ...(m === 0
        ? []
        : [
            "",
            "**Not recorded this run** (their videos are unchanged):",
            "",
            ...notRecorded.map(
              (f) => `- \`${f.scenario}\`: ${plainText(f.reason)}`,
            ),
          ]),
      "",
      "Watch each one and set it to Public or Unlisted in YouTube Studio, then merge.",
      "",
      runUrl === undefined
        ? "The run's report has the details."
        : `[The run](${runUrl}); its report artifact has the details.`,
    ].join("\n"),
    ...(runUrl === undefined ? {} : { detailsUrl: runUrl }),
  };
}

/**
 * Commits the map file with the uploaded videos to the job's branch for
 * the day, on top of the commit the run read it at, after checking the
 * file there is exactly what the run read; then opens a pull
 * request, or updates the one already open on that branch. It closes no
 * other pull request.
 */
export async function deliverVideoMap(
  writer: PrWriter,
  state: DocsState,
  videos: readonly UploadedVideo[],
  meta: MapPullMeta,
  now: Date,
): Promise<DeliveredMapPull> {
  if (videos.length === 0) throw new Error("no video to record");
  for (const v of videos)
    if (!SCENARIO_ID.test(v.scenario))
      throw new Error(`"${v.scenario}" is not a scenario id`);
  const branch = deliveryBranch(meta.job, now);
  if (!isAgentBranch(branch))
    throw new Error(`${branch} is not an agent branch`);
  const current = await writer.readFile(state.repo, state.base, state.path);
  if (current?.text !== state.text)
    throw new Error(
      `${state.repo}/${state.path} at ${state.base.slice(0, 12)} is not the file the run read, so the videos were not recorded`,
    );
  const text = updatedMapText(
    state.text,
    new Map(videos.map((v) => [v.scenario, v.entry])),
  );
  const commit = await writer.commitFiles(state.repo, {
    base: state.base,
    branch,
    message: [
      `${meta.job}: ${videos.length} video${videos.length === 1 ? "" : "s"}`,
      "",
      ...videos.map((v) => `- ${v.scenario}: ${v.entry.youtubeId}`),
      "",
      `Run: ${meta.runName}`,
    ].join("\n"),
    author: commitAuthor(),
    date: now,
    files: [
      { path: state.path, text, mode: current?.mode ?? "100644" },
      ...videos.flatMap((v) =>
        v.files === undefined || meta.mediaDir === undefined
          ? []
          : [
              {
                path: `${meta.mediaDir}/${v.scenario}/${posterName(v.files.poster.type)}`,
                bytes: v.files.poster.bytes,
                mode: "100644",
              },
              {
                path: `${meta.mediaDir}/${v.scenario}/captions.vtt`,
                bytes: v.files.captions,
                mode: "100644",
              },
            ],
      ),
      ...videos.flatMap((v) =>
        v.sourceFile === undefined || meta.sourceDir === undefined
          ? []
          : [
              {
                path: `${meta.sourceDir}/${v.sourceFile.path}`,
                bytes: v.sourceFile.bytes,
                mode: "100644",
              },
            ],
      ),
    ],
  });
  const day = now.toISOString().slice(0, 10);
  const title = mapPullTitle(meta.job, videos.length, day);
  const body = mapPullBody(state, videos, meta, branch);
  const same = (await writer.openPulls(state.repo)).find(
    (p) => p.sameRepo && p.byBot && p.branch === branch,
  );
  const check = () =>
    writeCheck(
      writer,
      { repo: state.repo, job: meta.job, branch, head: commit },
      mapPullCheck(videos, meta.runUrl, meta.notRecorded),
    );
  if (same !== undefined) {
    await writer.updatePull(state.repo, same.number, { title, body });
    return {
      repo: state.repo,
      number: same.number,
      url: same.url,
      branch,
      commit,
      updated: true,
      check: await check(),
    };
  }
  const opened = await writer.openPull(state.repo, {
    branch,
    base: state.branch,
    title,
    body,
  });
  return {
    repo: state.repo,
    number: opened.number,
    url: opened.url,
    branch,
    commit,
    updated: false,
    ...(meta.reviewTeam === undefined
      ? {}
      : {
          reviews: await requestReviews(
            writer,
            state.repo,
            opened.number,
            [],
            meta.reviewTeam,
          ),
        }),
    check: await check(),
  };
}
