/** The YouTube grant, by the repository secrets that hold it; only the runner holds them. */
export const YOUTUBE_CLIENT_ID_ENV = "YOUTUBE_CLIENT_ID";
export const YOUTUBE_CLIENT_SECRET_ENV = "YOUTUBE_CLIENT_SECRET";
export const YOUTUBE_REFRESH_TOKEN_ENV = "YOUTUBE_REFRESH_TOKEN";
export const YOUTUBE_CHANNEL_ID_ENV = "YOUTUBE_CHANNEL_ID";
export const YOUTUBE_SECRET_ENV = [
  YOUTUBE_CLIENT_ID_ENV,
  YOUTUBE_CLIENT_SECRET_ENV,
  YOUTUBE_REFRESH_TOKEN_ENV,
  YOUTUBE_CHANNEL_ID_ENV,
] as const;

/** The scopes the grant may carry: upload, and manage (captions, thumbnails, playlists). A token with any other is refused. */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
] as const;

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_UPLOAD_API =
  "https://www.googleapis.com/upload/youtube/v3";

/** Quota units per call (YouTube Data API v3); a project gets 10,000 a day. */
export const QUOTA_UNITS = {
  read: 1,
  videoInsert: 1600,
  captionInsert: 400,
  thumbnailSet: 50,
  playlistItemInsert: 50,
  playlistItemDelete: 50,
  videoUpdate: 50,
} as const;
export const DAILY_QUOTA_UNITS = 10_000;
/** The most videos one run uploads: four full uploads (about 8,400 units) fit one day's quota with room for reads. */
export const MAX_UPLOADS_PER_RUN = 4;

/** Science and Technology. */
export const VIDEO_CATEGORY_ID = "28";
export const VIDEO_LANGUAGE = "en";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const REASON = /^[A-Za-z0-9_]{1,60}$/;
const MAX_ATTEMPTS = 3;
const MAX_PLAYLIST_PAGES = 5;
const CALL_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

/** Where a video's page in YouTube Studio is. */
export function studioUrl(videoId: string): string {
  return `https://studio.youtube.com/video/${videoId}/edit`;
}

/** The videos resource a run uploads: always private, so a person publishes it in Studio. */
export interface VideoResource {
  snippet: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
    defaultLanguage: string;
    defaultAudioLanguage: string;
  };
  status: {
    privacyStatus: "private";
    selfDeclaredMadeForKids: false;
    embeddable: true;
  };
}

export function videoResource(meta: {
  title: string;
  description: string;
  tags: readonly string[];
}): VideoResource {
  return {
    snippet: {
      title: meta.title,
      description: meta.description,
      tags: [...meta.tags],
      categoryId: VIDEO_CATEGORY_ID,
      defaultLanguage: VIDEO_LANGUAGE,
      defaultAudioLanguage: VIDEO_LANGUAGE,
    },
    status: {
      privacyStatus: "private",
      selfDeclaredMadeForKids: false,
      embeddable: true,
    },
  };
}

/** What an upload run may do on the channel, and nothing more: upload private videos, their captions and thumbnails, and add them to an existing playlist. Nothing deletes, publishes or changes another video; a tidy run gets YouTubeTidier instead. */
export interface YouTubeUploader {
  /** The id of the channel's one playlist with exactly this title; refuses none or several. */
  findPlaylist(title: string): Promise<string>;
  uploadVideo(
    bytes: Buffer,
    resource: VideoResource,
  ): Promise<{ id: string; privacyStatus: string }>;
  insertCaptions(videoId: string, vtt: Buffer): Promise<string>;
  setThumbnail(videoId: string, image: Buffer, type: string): Promise<void>;
  addToPlaylist(playlistId: string, videoId: string): Promise<void>;
}

/** A video's status as videos.list returns it to the channel's owner; only the fields videos.update may write are kept. */
export interface VideoStatus {
  privacyStatus: string;
  embeddable?: boolean;
  license?: string;
  publicStatsViewable?: boolean;
  selfDeclaredMadeForKids?: boolean;
  containsSyntheticMedia?: boolean;
}

/** The fields of a video's status that videos.update writes back; any it is not sent revert to their defaults. */
const WRITABLE_STATUS = [
  "embeddable",
  "license",
  "publicStatsViewable",
  "selfDeclaredMadeForKids",
  "containsSyntheticMedia",
] as const;

/** One playlist entry: the playlist item's own id, which playlistItems.delete takes, and the video it holds. */
export interface PlaylistEntry {
  itemId: string;
  videoId: string;
}

/**
 * What a tidy run may do on the channel: read videos' status and playlists'
 * entries, take an entry out of a playlist and set a public video to
 * unlisted. tidyGuard limits the two changes to the replaced videos.
 */
export interface YouTubeTidier {
  findPlaylist(title: string): Promise<string>;
  /** The status of each video the channel still has, by id; a deleted video is absent. */
  videoStatuses(ids: readonly string[]): Promise<Map<string, VideoStatus>>;
  playlistEntries(playlistId: string): Promise<PlaylistEntry[]>;
  removePlaylistEntry(entry: PlaylistEntry): Promise<void>;
  /** Sets a public video to unlisted, writing back the rest of its status as it was. */
  setUnlisted(videoId: string, status: VideoStatus): Promise<void>;
}

/**
 * The tidier with its two changes held to the replaced videos: taking out
 * an entry that holds another video, or unlisting another video or one
 * that is not public, throws before any call.
 */
export function tidyGuard(
  tidier: YouTubeTidier,
  replaced: ReadonlySet<string>,
): YouTubeTidier {
  const allowed = new Set(replaced);
  return {
    findPlaylist: (title) => tidier.findPlaylist(title),
    videoStatuses: (ids) => tidier.videoStatuses(ids),
    playlistEntries: (id) => tidier.playlistEntries(id),
    removePlaylistEntry: async (entry) => {
      if (!allowed.has(entry.videoId))
        throw new Error(
          `${entry.videoId} is not a replaced video; its playlist entry stays`,
        );
      await tidier.removePlaylistEntry(entry);
    },
    setUnlisted: async (videoId, status) => {
      if (!allowed.has(videoId))
        throw new Error(
          `${videoId} is not a replaced video; it stays as it is`,
        );
      if (status.privacyStatus !== "public")
        throw new Error(
          `${videoId} is ${status.privacyStatus}; only a public video is set to unlisted`,
        );
      await tidier.setUnlisted(videoId, status);
    },
  };
}

export interface YouTubeApiOptions {
  token: string;
  apiUrl?: string;
  uploadUrl?: string;
  fetch?: typeof fetch;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The reason code of a Google API error, which says what to do (quotaExceeded, forbidden); never the rest of the body. */
async function reasonOf(res: Response): Promise<string> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return "";
  }
  const error = isObject(body) ? body.error : undefined;
  const first =
    isObject(error) && Array.isArray(error.errors) ? error.errors[0] : error;
  const reason = isObject(first)
    ? (first.reason ?? first.status)
    : typeof error === "string"
      ? error
      : undefined;
  return typeof reason === "string" && REASON.test(reason)
    ? ` (${reason})`
    : "";
}

async function failure(what: string, res: Response): Promise<Error> {
  return new Error(`${what} returned ${res.status}${await reasonOf(res)}`);
}

/**
 * The YouTube Data API with one run's access token. Every request body is
 * built here from fixed fields; uploads use the resumable protocol, and
 * a broken upload resumes from what YouTube says it has.
 */
export class YouTubeApi implements YouTubeUploader, YouTubeTidier {
  private token: string;
  private readonly api: string;
  private readonly upload: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: YouTubeApiOptions) {
    this.token = options.token;
    this.api = options.apiUrl ?? YOUTUBE_API;
    this.upload = options.uploadUrl ?? YOUTUBE_UPLOAD_API;
    this.fetchFn = options.fetch ?? fetch;
  }

  private auth(): Record<string, string> {
    if (this.token === "") throw new Error("the YouTube token was forgotten");
    return { authorization: `Bearer ${this.token}` };
  }

  /** Drops the access token; every later call is refused. */
  forget(): void {
    this.token = "";
  }

  async findPlaylist(title: string): Promise<string> {
    const found: string[] = [];
    let page = "";
    for (let i = 0; i < MAX_PLAYLIST_PAGES; i++) {
      const res = await this.fetchFn(
        `${this.api}/playlists?part=snippet&mine=true&maxResults=50${page === "" ? "" : `&pageToken=${encodeURIComponent(page)}`}`,
        { headers: this.auth(), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
      );
      if (!res.ok) throw await failure("playlists.list", res);
      const body: unknown = await res.json();
      const items =
        isObject(body) && Array.isArray(body.items) ? body.items : [];
      for (const item of items) {
        const snippet = isObject(item) ? item.snippet : undefined;
        if (
          isObject(item) &&
          typeof item.id === "string" &&
          PLAYLIST_ID.test(item.id) &&
          isObject(snippet) &&
          snippet.title === title
        )
          found.push(item.id);
      }
      const next = isObject(body) ? body.nextPageToken : undefined;
      if (typeof next !== "string" || next === "") break;
      page = next;
    }
    if (found.length === 0)
      throw new Error(
        `the channel has no playlist titled "${title}"; create it in YouTube Studio, or set playlist: null`,
      );
    if (found.length > 1)
      throw new Error(
        `the channel has ${found.length} playlists titled "${title}"; rename all but one in YouTube Studio`,
      );
    return found[0]!;
  }

  async uploadVideo(
    bytes: Buffer,
    resource: VideoResource,
  ): Promise<{ id: string; privacyStatus: string }> {
    if (resource.status.privacyStatus !== "private")
      throw new Error("videos are only ever uploaded private");
    const size = bytes.length;
    const session = await this.fetchFn(
      `${this.upload}/videos?uploadType=resumable&part=snippet,status`,
      {
        method: "POST",
        headers: {
          ...this.auth(),
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": "video/mp4",
          "x-upload-content-length": String(size),
        },
        body: JSON.stringify(resource),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      },
    );
    if (!session.ok) throw await failure("videos.insert", session);
    await session.body?.cancel();
    const location = session.headers.get("location") ?? "";
    let target: URL;
    try {
      target = new URL(location);
    } catch {
      throw new Error("videos.insert returned no upload address");
    }
    if (target.origin !== new URL(this.upload).origin)
      throw new Error(
        `videos.insert returned an upload address on ${target.host}, not YouTube's upload host`,
      );

    let from = 0;
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await this.fetchFn(target, {
          method: "PUT",
          headers: {
            "content-type": "video/mp4",
            ...(from === 0
              ? {}
              : { "content-range": `bytes ${from}-${size - 1}/${size}` }),
          },
          body: new Uint8Array(bytes.subarray(from)),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS)
          throw new Error(
            `the video upload failed ${attempt} times: ${(err as Error).message}`,
          );
      }
      if (res !== undefined && (res.status === 200 || res.status === 201))
        return this.uploaded(res);
      if (res !== undefined && res.status !== 308 && res.status < 500)
        throw await failure("the video upload", res);
      await res?.body?.cancel();
      if (attempt >= MAX_ATTEMPTS)
        throw new Error(
          `the video upload did not finish after ${attempt} tries${res === undefined ? "" : ` (last ${res.status})`}`,
        );
      // Ask how much YouTube has, then send the rest.
      const status = await this.fetchFn(target, {
        method: "PUT",
        headers: { "content-range": `bytes */${size}` },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (status.status === 200 || status.status === 201)
        return this.uploaded(status);
      if (status.status !== 308)
        throw await failure("the upload status query", status);
      await status.body?.cancel();
      const range = /^bytes=0-(\d+)$/.exec(status.headers.get("range") ?? "");
      from = range === null ? 0 : Number(range[1]) + 1;
      if (from > size)
        throw new Error("YouTube says it has more bytes than the video has");
    }
  }

  private async uploaded(
    res: Response,
  ): Promise<{ id: string; privacyStatus: string }> {
    const body: unknown = await res.json();
    const id = isObject(body) ? body.id : undefined;
    if (typeof id !== "string" || !VIDEO_ID.test(id))
      throw new Error("the video upload answered without a video id");
    const status = isObject(body) ? body.status : undefined;
    const privacy = isObject(status) ? status.privacyStatus : undefined;
    return {
      id,
      privacyStatus: typeof privacy === "string" ? privacy : "unknown",
    };
  }

  async insertCaptions(videoId: string, vtt: Buffer): Promise<string> {
    if (!VIDEO_ID.test(videoId))
      throw new Error(`${videoId} is not a video id`);
    const boundary = `agents-${Date.now().toString(36)}`;
    const meta = JSON.stringify({
      snippet: {
        videoId,
        language: VIDEO_LANGUAGE,
        name: "English",
        isDraft: false,
      },
    });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
      ),
      vtt,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await this.fetchFn(
      `${this.upload}/captions?uploadType=multipart&part=snippet`,
      {
        method: "POST",
        headers: {
          ...this.auth(),
          "content-type": `multipart/related; boundary=${boundary}`,
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw await failure("captions.insert", res);
    const got: unknown = await res.json();
    const id = isObject(got) ? got.id : undefined;
    if (typeof id !== "string" || id === "")
      throw new Error("captions.insert answered without a caption id");
    return id;
  }

  async setThumbnail(
    videoId: string,
    image: Buffer,
    type: string,
  ): Promise<void> {
    if (!VIDEO_ID.test(videoId))
      throw new Error(`${videoId} is not a video id`);
    const res = await this.fetchFn(
      `${this.upload}/thumbnails/set?videoId=${videoId}&uploadType=media`,
      {
        method: "POST",
        headers: { ...this.auth(), "content-type": type },
        body: new Uint8Array(image),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw await failure("thumbnails.set", res);
    await res.body?.cancel();
  }

  async addToPlaylist(playlistId: string, videoId: string): Promise<void> {
    if (!VIDEO_ID.test(videoId))
      throw new Error(`${videoId} is not a video id`);
    const res = await this.fetchFn(`${this.api}/playlistItems?part=snippet`, {
      method: "POST",
      headers: {
        ...this.auth(),
        "content-type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        snippet: {
          playlistId,
          resourceId: { kind: "youtube#video", videoId },
        },
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) throw await failure("playlistItems.insert", res);
    await res.body?.cancel();
  }

  async videoStatuses(
    ids: readonly string[],
  ): Promise<Map<string, VideoStatus>> {
    const found = new Map<string, VideoStatus>();
    for (const id of ids)
      if (!VIDEO_ID.test(id)) throw new Error(`${id} is not a video id`);
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const res = await this.fetchFn(
        `${this.api}/videos?part=status&maxResults=50&id=${batch.join(",")}`,
        { headers: this.auth(), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
      );
      if (!res.ok) throw await failure("videos.list", res);
      const body: unknown = await res.json();
      const items =
        isObject(body) && Array.isArray(body.items) ? body.items : [];
      for (const item of items) {
        const status = isObject(item) ? item.status : undefined;
        if (
          !isObject(item) ||
          typeof item.id !== "string" ||
          !batch.includes(item.id) ||
          !isObject(status) ||
          typeof status.privacyStatus !== "string"
        )
          continue;
        const kept: VideoStatus = { privacyStatus: status.privacyStatus };
        for (const field of WRITABLE_STATUS) {
          const value = status[field];
          if (typeof value === "boolean" || typeof value === "string")
            (kept as unknown as Record<string, unknown>)[field] = value;
        }
        found.set(item.id, kept);
      }
    }
    return found;
  }

  async playlistEntries(playlistId: string): Promise<PlaylistEntry[]> {
    if (!PLAYLIST_ID.test(playlistId))
      throw new Error(`${playlistId} is not a playlist id`);
    const entries: PlaylistEntry[] = [];
    let page = "";
    for (let i = 0; i < MAX_PLAYLIST_PAGES; i++) {
      const res = await this.fetchFn(
        `${this.api}/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}${page === "" ? "" : `&pageToken=${encodeURIComponent(page)}`}`,
        { headers: this.auth(), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
      );
      if (!res.ok) throw await failure("playlistItems.list", res);
      const body: unknown = await res.json();
      const items =
        isObject(body) && Array.isArray(body.items) ? body.items : [];
      for (const item of items) {
        const snippet = isObject(item) ? item.snippet : undefined;
        const resource = isObject(snippet) ? snippet.resourceId : undefined;
        const videoId = isObject(resource) ? resource.videoId : undefined;
        if (
          isObject(item) &&
          typeof item.id === "string" &&
          item.id !== "" &&
          typeof videoId === "string" &&
          VIDEO_ID.test(videoId)
        )
          entries.push({ itemId: item.id, videoId });
      }
      const next = isObject(body) ? body.nextPageToken : undefined;
      if (typeof next !== "string" || next === "") break;
      page = next;
    }
    return entries;
  }

  async removePlaylistEntry(entry: PlaylistEntry): Promise<void> {
    const res = await this.fetchFn(
      `${this.api}/playlistItems?id=${encodeURIComponent(entry.itemId)}`,
      {
        method: "DELETE",
        headers: this.auth(),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw await failure("playlistItems.delete", res);
    await res.body?.cancel();
  }

  async setUnlisted(videoId: string, status: VideoStatus): Promise<void> {
    if (!VIDEO_ID.test(videoId))
      throw new Error(`${videoId} is not a video id`);
    const written: Record<string, unknown> = { privacyStatus: "unlisted" };
    for (const field of WRITABLE_STATUS)
      if (status[field] !== undefined) written[field] = status[field];
    const res = await this.fetchFn(`${this.api}/videos?part=status`, {
      method: "PUT",
      headers: {
        ...this.auth(),
        "content-type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ id: videoId, status: written }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) throw await failure("videos.update", res);
    await res.body?.cancel();
  }
}

export interface OpenedYouTube {
  youtube: YouTubeUploader;
  /** The same grant for a tidy run: reads, playlist removal and unlisting, which tidyGuard limits. */
  tidier?: YouTubeTidier;
  channel: { id: string; title: string };
  /** Values to scrub from every report file: the access token. */
  secrets: string[];
  /** Forgets the access token. Google's revoke call would end the whole grant, refresh token included, so the token is left to expire within the hour. */
  close(): void;
}

export interface OpenYouTubeOptions {
  tokenUrl?: string;
  apiUrl?: string;
  uploadUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Exchanges the refresh token for an access token, refuses one whose
 * scopes are not exactly YOUTUBE_SCOPES, and refuses the grant unless
 * channels.list?mine=true names exactly the channel in YOUTUBE_CHANNEL_ID.
 */
export async function openYouTube(
  env: NodeJS.ProcessEnv,
  options: OpenYouTubeOptions = {},
): Promise<OpenedYouTube> {
  const missing = YOUTUBE_SECRET_ENV.filter((n) => (env[n] ?? "") === "");
  if (missing.length > 0)
    throw new Error(`${missing.join(", ")} must be set to upload to YouTube`);
  const channelId = env[YOUTUBE_CHANNEL_ID_ENV]!.trim();
  if (!CHANNEL_ID.test(channelId))
    throw new Error(`${YOUTUBE_CHANNEL_ID_ENV} is not a channel id`);
  const fetchFn = options.fetch ?? fetch;
  const res = await fetchFn(options.tokenUrl ?? GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env[YOUTUBE_REFRESH_TOKEN_ENV]!.trim(),
      client_id: env[YOUTUBE_CLIENT_ID_ENV]!.trim(),
      client_secret: env[YOUTUBE_CLIENT_SECRET_ENV]!.trim(),
    }).toString(),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new Error(
      `the YouTube token refresh returned ${res.status}${await reasonOf(res)}; an invalid_grant means the grant was revoked: grant it again and set ${YOUTUBE_REFRESH_TOKEN_ENV}`,
    );
  const body: unknown = await res.json();
  const token = isObject(body) ? body.access_token : undefined;
  if (typeof token !== "string" || token.length < 10)
    throw new Error("the YouTube token refresh returned no access token");
  const scope = isObject(body) ? body.scope : undefined;
  const scopes = (typeof scope === "string" ? scope : "")
    .split(" ")
    .filter((s) => s !== "")
    .sort();
  if (scopes.length === 0)
    throw new Error(
      "the YouTube token refresh did not say which scopes the grant has, so it is not used",
    );
  const extra = scopes.filter(
    (s) => !(YOUTUBE_SCOPES as readonly string[]).includes(s),
  );
  if (extra.length > 0)
    throw new Error(
      `the YouTube grant has more than upload and manage (${extra.join(", ")}), so it is not used; grant only ${YOUTUBE_SCOPES.join(" and ")}`,
    );
  const lacking = YOUTUBE_SCOPES.filter((s) => !scopes.includes(s));
  if (lacking.length > 0)
    throw new Error(`the YouTube grant lacks ${lacking.join(", ")}`);

  const api = options.apiUrl ?? YOUTUBE_API;
  const mine = await fetchFn(`${api}/channels?part=snippet&mine=true`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!mine.ok) throw await failure("channels.list", mine);
  const list: unknown = await mine.json();
  const items = isObject(list) && Array.isArray(list.items) ? list.items : [];
  const ids = items.map((i) =>
    isObject(i) && typeof i.id === "string" ? i.id : "?",
  );
  if (ids.length !== 1 || ids[0] !== channelId)
    throw new Error(
      `the YouTube grant answers for ${ids.length === 0 ? "no channel" : `channel ${ids.join(", ")}`}, not ${channelId} (${YOUTUBE_CHANNEL_ID_ENV}); nothing was uploaded`,
    );
  const snippet = isObject(items[0]) ? items[0].snippet : undefined;
  const title =
    isObject(snippet) && typeof snippet.title === "string" ? snippet.title : "";
  const youtube = new YouTubeApi({
    token,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.uploadUrl === undefined
      ? {}
      : { uploadUrl: options.uploadUrl }),
    fetch: fetchFn,
  });
  return {
    youtube,
    tidier: youtube,
    channel: { id: channelId, title },
    secrets: [token],
    close: () => youtube.forget(),
  };
}
