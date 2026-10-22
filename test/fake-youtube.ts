import {
  openYouTube,
  YOUTUBE_SCOPES,
  type OpenedYouTube,
} from "../src/deliver/youtube.ts";

export const TOKEN_URL = "https://oauth2.test/token";
export const API = "https://yt.test/youtube/v3";
export const UPLOAD = "https://yt.test/upload/youtube/v3";
export const CHANNEL = "UCwXVcG-xmbKmm5EZ3ATLDgA";
// Built at runtime so no token-shaped literal sits in the source.
export const ACCESS_TOKEN = ["ya29", "accesstokenforthetests"].join(".");
export const YOUTUBE_ENV = {
  YOUTUBE_CLIENT_ID: "client-id-for-the-tests.apps.example",
  YOUTUBE_CLIENT_SECRET: ["client", "secret", "for", "tests"].join("-"),
  YOUTUBE_REFRESH_TOKEN: ["1", "refreshtokenforthetests"].join("//"),
  YOUTUBE_CHANNEL_ID: CHANNEL,
};

export interface YouTubeCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Text bodies as text, byte bodies by their length. */
  body?: string | number;
}

export interface FakeYouTubeOptions {
  /** The channels channels.list?mine=true names. */
  channels?: string[];
  /** The scopes the token refresh reports. */
  scope?: string;
  /** Playlist titles on the channel, by id. */
  playlists?: Record<string, string>;
  /** The first video PUTs answer 503 and keep only this many bytes. */
  breakUploads?: { times: number; keep: number };
  /** Answers this call with 403 quotaExceeded. */
  quotaExceededOn?: "videos.insert" | "captions.insert" | "thumbnails.set";
  /** Where the resumable session says to upload. */
  location?: string;
}

/** A stand-in for Google's token endpoint and the YouTube Data API behind fetch. It records every request and uploads nothing anywhere. */
export function fakeYouTube(options: FakeYouTubeOptions = {}) {
  const calls: YouTubeCall[] = [];
  const videos: string[] = [];
  let broken = 0;
  let received = 0;
  const json = (value: unknown, status = 200, headers = {}) =>
    Promise.resolve(
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
  const quota = () =>
    json({ error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }, 403);
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = init?.body;
    const body =
      typeof raw === "string"
        ? raw
        : raw instanceof Uint8Array
          ? raw.length
          : undefined;
    calls.push({
      method,
      url,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    if (url === TOKEN_URL && method === "POST")
      return json({
        access_token: ACCESS_TOKEN,
        expires_in: 3599,
        scope: options.scope ?? YOUTUBE_SCOPES.join(" "),
        token_type: "Bearer",
      });
    if (url === `${API}/channels?part=snippet&mine=true`)
      return json({
        items: (options.channels ?? [CHANNEL]).map((id) => ({
          id,
          snippet: { title: "Notes Co" },
        })),
      });
    if (url.startsWith(`${API}/playlists?`))
      return json({
        items: Object.entries(options.playlists ?? {}).map(([id, title]) => ({
          id,
          snippet: { title },
        })),
      });
    if (
      url.startsWith(`${UPLOAD}/videos?uploadType=resumable`) &&
      method === "POST"
    ) {
      if (options.quotaExceededOn === "videos.insert") return quota();
      return Promise.resolve(
        new Response(null, {
          status: 200,
          headers: {
            location:
              options.location ??
              `${UPLOAD}/videos?uploadType=resumable&upload_id=up${videos.length}`,
          },
        }),
      );
    }
    if (url.includes("upload_id=") && method === "PUT") {
      const range = headers["content-range"] ?? "";
      if (range.startsWith("bytes */")) {
        return Promise.resolve(
          new Response(null, {
            status: 308,
            headers: received === 0 ? {} : { range: `bytes=0-${received - 1}` },
          }),
        );
      }
      const brk = options.breakUploads;
      if (brk !== undefined && broken < brk.times) {
        broken++;
        received = brk.keep;
        return json({ error: { code: 503 } }, 503);
      }
      const id = `vid${videos.length + 1}`.padEnd(11, "x");
      videos.push(id);
      received = 0;
      return json({ id, status: { privacyStatus: "private" } });
    }
    if (url === `${UPLOAD}/captions?uploadType=multipart&part=snippet`) {
      if (options.quotaExceededOn === "captions.insert") return quota();
      return json({ id: "caption1" });
    }
    if (url.startsWith(`${UPLOAD}/thumbnails/set?`)) {
      if (options.quotaExceededOn === "thumbnails.set") return quota();
      return json({ items: [] });
    }
    if (url === `${API}/playlistItems?part=snippet` && method === "POST")
      return json({ id: "item1" });
    return json({ error: { code: 404 } }, 404);
  };
  return { fetch: fn as typeof fetch, calls, videos };
}

/** Opens the uploader against a fake, as live delivery would against YouTube. */
export function openFake(
  yt: ReturnType<typeof fakeYouTube>,
  env: NodeJS.ProcessEnv = YOUTUBE_ENV,
): Promise<OpenedYouTube> {
  return openYouTube(env, {
    tokenUrl: TOKEN_URL,
    apiUrl: API,
    uploadUrl: UPLOAD,
    fetch: yt.fetch,
  });
}
