import { describe, expect, it } from "vitest";
import { videoResource } from "../src/deliver/youtube.ts";
import {
  ACCESS_TOKEN,
  API,
  CHANNEL,
  fakeYouTube,
  openFake,
  TOKEN_URL,
  UPLOAD,
  YOUTUBE_ENV,
} from "./fake-youtube.ts";

const VIDEO = Buffer.from("x".repeat(1000));
const RESOURCE = videoResource({
  title: "Notes Co in two minutes",
  description: "A tour.\n\n0:00 Intro",
  tags: ["sbom"],
});

describe("the YouTube grant", () => {
  it("exchanges the refresh token, checks the scopes and the channel, then holds only the access token", async () => {
    const yt = fakeYouTube();
    const opened = await openFake(yt);
    expect(opened.channel).toEqual({ id: CHANNEL, title: "Notes Co" });
    expect(opened.secrets).toEqual([ACCESS_TOKEN]);
    expect(yt.calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", TOKEN_URL],
      ["GET", `${API}/channels?part=snippet&mine=true`],
    ]);
    expect(yt.calls[0]!.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(
      Object.fromEntries(new URLSearchParams(String(yt.calls[0]!.body))),
    ).toEqual({
      grant_type: "refresh_token",
      refresh_token: YOUTUBE_ENV.YOUTUBE_REFRESH_TOKEN,
      client_id: YOUTUBE_ENV.YOUTUBE_CLIENT_ID,
      client_secret: YOUTUBE_ENV.YOUTUBE_CLIENT_SECRET,
    });
    expect(yt.calls[1]!.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    opened.close();
    await expect(
      opened.youtube.setThumbnail("abcdefghijk", VIDEO, "image/png"),
    ).rejects.toThrow("the YouTube token was forgotten");
    // Revoking at Google would end the refresh token too, so nothing is revoked.
    expect(yt.calls.some((c) => c.url.includes("revoke"))).toBe(false);
  });

  it("refuses a grant for another channel, or for none, before anything is uploaded", async () => {
    const other = fakeYouTube({ channels: ["UCxxxxxxxxxxxxxxxxxxxxxx"] });
    await expect(openFake(other)).rejects.toThrow(
      `the YouTube grant answers for channel UCxxxxxxxxxxxxxxxxxxxxxx, not ${CHANNEL} (YOUTUBE_CHANNEL_ID); nothing was uploaded`,
    );
    const none = fakeYouTube({ channels: [] });
    await expect(openFake(none)).rejects.toThrow(
      `the YouTube grant answers for no channel, not ${CHANNEL} (YOUTUBE_CHANNEL_ID); nothing was uploaded`,
    );
    for (const yt of [other, none])
      expect(yt.calls.some((c) => c.url.startsWith(UPLOAD))).toBe(false);
  });

  it("refuses a grant with more or fewer scopes than upload and manage, and missing settings", async () => {
    await expect(
      openFake(
        fakeYouTube({
          scope:
            "https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.upload",
        }),
      ),
    ).rejects.toThrow(
      "the YouTube grant has more than upload and manage (https://www.googleapis.com/auth/youtube), so it is not used",
    );
    await expect(
      openFake(
        fakeYouTube({
          scope: "https://www.googleapis.com/auth/youtube.upload",
        }),
      ),
    ).rejects.toThrow(
      "the YouTube grant lacks https://www.googleapis.com/auth/youtube.force-ssl",
    );
    await expect(openFake(fakeYouTube({ scope: "" }))).rejects.toThrow(
      "the YouTube token refresh did not say which scopes the grant has, so it is not used",
    );
    await expect(
      openFake(fakeYouTube(), { ...YOUTUBE_ENV, YOUTUBE_REFRESH_TOKEN: "" }),
    ).rejects.toThrow("YOUTUBE_REFRESH_TOKEN must be set to upload to YouTube");
    await expect(
      openFake(fakeYouTube(), { ...YOUTUBE_ENV, YOUTUBE_CHANNEL_ID: "me" }),
    ).rejects.toThrow("YOUTUBE_CHANNEL_ID is not a channel id");
  });

  it("names Google's error code when the refresh is refused, and nothing of the body", async () => {
    const refused = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          }),
          { status: 400 },
        ),
      )) as unknown as typeof fetch;
    await expect(
      openFake({ fetch: refused, calls: [], videos: [] }),
    ).rejects.toThrow(
      "the YouTube token refresh returned 400 (invalid_grant); an invalid_grant means the grant was revoked: grant it again and set YOUTUBE_REFRESH_TOKEN",
    );
  });
});

describe("the uploader", () => {
  it("uploads private through a resumable session: the metadata first, then the bytes to the session address", async () => {
    const yt = fakeYouTube();
    const { youtube } = await openFake(yt);
    const done = await youtube.uploadVideo(VIDEO, RESOURCE);
    expect(done).toEqual({ id: "vid1xxxxxxx", privacyStatus: "private" });
    const [session, put] = yt.calls.slice(2);
    expect(session).toEqual({
      method: "POST",
      url: `${UPLOAD}/videos?uploadType=resumable&part=snippet,status`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": "video/mp4",
        "x-upload-content-length": "1000",
      },
      body: JSON.stringify({
        snippet: {
          title: "Notes Co in two minutes",
          description: "A tour.\n\n0:00 Intro",
          tags: ["sbom"],
          categoryId: "28",
          defaultLanguage: "en",
          defaultAudioLanguage: "en",
        },
        status: {
          privacyStatus: "private",
          selfDeclaredMadeForKids: false,
          embeddable: true,
        },
      }),
    });
    expect(put).toEqual({
      method: "PUT",
      url: `${UPLOAD}/videos?uploadType=resumable&upload_id=up0`,
      headers: { "content-type": "video/mp4" },
      body: 1000,
    });
    await expect(
      youtube.uploadVideo(VIDEO, {
        ...RESOURCE,
        status: { ...RESOURCE.status, privacyStatus: "public" as "private" },
      }),
    ).rejects.toThrow("videos are only ever uploaded private");
  });

  it("resumes a broken upload from what YouTube says it has, and gives up after three tries", async () => {
    const yt = fakeYouTube({ breakUploads: { times: 1, keep: 400 } });
    const { youtube } = await openFake(yt);
    expect((await youtube.uploadVideo(VIDEO, RESOURCE)).id).toBe("vid1xxxxxxx");
    expect(
      yt.calls
        .slice(3)
        .map((c) => [c.method, c.headers["content-range"], c.body]),
    ).toEqual([
      ["PUT", undefined, 1000],
      ["PUT", "bytes */1000", undefined],
      ["PUT", "bytes 400-999/1000", 600],
    ]);
    const broken = fakeYouTube({ breakUploads: { times: 5, keep: 0 } });
    const opened = await openFake(broken);
    await expect(opened.youtube.uploadVideo(VIDEO, RESOURCE)).rejects.toThrow(
      "the video upload did not finish after 3 tries (last 503)",
    );
  });

  it("sends the bytes only to YouTube's upload host", async () => {
    const yt = fakeYouTube({
      location: "https://collect.evil.example/upload?upload_id=1",
    });
    const { youtube } = await openFake(yt);
    await expect(youtube.uploadVideo(VIDEO, RESOURCE)).rejects.toThrow(
      "videos.insert returned an upload address on collect.evil.example, not YouTube's upload host",
    );
    expect(yt.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("adds captions from the VTT, the poster as thumbnail and the video to a playlist, with the exact requests", async () => {
    const yt = fakeYouTube({ playlists: { PLdemosdemos1: "Demos" } });
    const { youtube } = await openFake(yt);
    const vtt = Buffer.from("WEBVTT\n");
    expect(await youtube.insertCaptions("vid1xxxxxxx", vtt)).toBe("caption1");
    await youtube.setThumbnail("vid1xxxxxxx", Buffer.from("png"), "image/png");
    expect(await youtube.findPlaylist("Demos")).toBe("PLdemosdemos1");
    await youtube.addToPlaylist("PLdemosdemos1", "vid1xxxxxxx");
    const [captions, thumb, list, item] = yt.calls.slice(2);
    expect(captions!.url).toBe(
      `${UPLOAD}/captions?uploadType=multipart&part=snippet`,
    );
    const boundary = /boundary=(.+)$/.exec(
      captions!.headers["content-type"]!,
    )![1]!;
    expect(captions!.body).toBe(
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n{"snippet":{"videoId":"vid1xxxxxxx","language":"en","name":"English","isDraft":false}}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\nWEBVTT\n\r\n--${boundary}--\r\n`,
      ).length,
    );
    expect([thumb!.method, thumb!.url, thumb!.headers["content-type"]]).toEqual(
      [
        "POST",
        `${UPLOAD}/thumbnails/set?videoId=vid1xxxxxxx&uploadType=media`,
        "image/png",
      ],
    );
    expect(list!.url).toBe(
      `${API}/playlists?part=snippet&mine=true&maxResults=50`,
    );
    expect([item!.url, JSON.parse(String(item!.body))]).toEqual([
      `${API}/playlistItems?part=snippet`,
      {
        snippet: {
          playlistId: "PLdemosdemos1",
          resourceId: { kind: "youtube#video", videoId: "vid1xxxxxxx" },
        },
      },
    ]);
  });

  it("refuses a playlist the channel does not have, or has twice, rather than creating one", async () => {
    const yt = fakeYouTube({
      playlists: { PLdemosdemos1: "Demos", PLdemosdemos2: "Demos" },
    });
    const { youtube } = await openFake(yt);
    await expect(youtube.findPlaylist("Tutorials")).rejects.toThrow(
      'the channel has no playlist titled "Tutorials"; create it in YouTube Studio, or set playlist: null',
    );
    await expect(youtube.findPlaylist("Demos")).rejects.toThrow(
      'the channel has 2 playlists titled "Demos"; rename all but one in YouTube Studio',
    );
    expect(yt.calls.filter((c) => c.method === "POST").length).toBe(1);
  });

  it("names YouTube's reason, such as quotaExceeded, when a call is refused", async () => {
    const yt = fakeYouTube({ quotaExceededOn: "videos.insert" });
    const { youtube } = await openFake(yt);
    await expect(youtube.uploadVideo(VIDEO, RESOURCE)).rejects.toThrow(
      "videos.insert returned 403 (quotaExceeded)",
    );
  });
});
