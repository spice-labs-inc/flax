import { createInstallationToken, GITHUB_API } from "../tools-server/github.ts";
import {
  MAP_READ_PERMISSIONS,
  parseVideoMap,
  repoPath,
  type MapReaderOptions,
} from "./video-map.ts";
import { jobBranchPrefix } from "./writer.ts";

/** A video one of the job's map pull requests added to the map: the id was in the pull request's map and not in its base's. */
export interface MappedVideo {
  scenario: string;
  youtubeId: string;
  pull: number;
}

/** The videos the job's own map pull requests added, and the map as it is now. */
export interface VideoHistory {
  repo: string;
  path: string;
  branch: string;
  /** The default branch's head, where the current map was read. */
  base: string;
  /** Scenario to video id, as the map records them now. */
  current: Map<string, string>;
  /** Added by a merged pull request of the job. */
  merged: MappedVideo[];
  /** Added only by pull requests of the job that were closed without merging: uploaded, never in the docs. */
  neverMapped: MappedVideo[];
  /** Pull requests whose map could not be read, so their videos are not known. */
  unread: number[];
}

const SHA = /^[0-9a-f]{40}$/;
const MAX_PULL_PAGES = 5;
const MAX_MAP_BYTES = 1024 * 1024;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Video ids the map at `head` records that the map at `base` does not, by scenario. */
export function addedVideos(
  head: Map<string, string>,
  base: Map<string, string>,
): { scenario: string; youtubeId: string }[] {
  const before = new Set(base.values());
  return [...head]
    .filter(([, id]) => !before.has(id))
    .map(([scenario, youtubeId]) => ({ scenario, youtubeId }));
}

/**
 * The replaced videos: added by a merged pull request of the job and not
 * recorded by the map now. Nothing else can be in it: a video uploaded by
 * hand, or one the docs point to now, never is.
 */
export function replacedVideos(history: VideoHistory): MappedVideo[] {
  const now = new Set(history.current.values());
  const seen = new Set<string>();
  return history.merged.filter((v) => {
    if (now.has(v.youtubeId) || seen.has(v.youtubeId)) return false;
    seen.add(v.youtubeId);
    return true;
  });
}

function ids(text: string | undefined): Map<string, string> | undefined {
  const parsed = parseVideoMap(text);
  if ("error" in parsed) return undefined;
  return new Map([...parsed.entries].map(([s, e]) => [s, e.youtubeId]));
}

/**
 * Reads the map file at the head of the docs repository's default branch
 * and, for each of the job's closed pull requests there (its branch prefix,
 * opened by a bot, into the default branch), the map at the pull request's
 * head and base, with an installation token of the reader app for that
 * repository only, revoked when the read ends.
 */
export async function readVideoHistory(
  repo: string,
  path: string,
  job: string,
  options: MapReaderOptions,
): Promise<{ history: VideoHistory; secrets: string[] }> {
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
  const get = async (url: string, allow404 = false): Promise<unknown> => {
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
  const mapAt = async (sha: string): Promise<string | undefined> => {
    const file = await get(
      `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`,
      true,
    );
    if (file === undefined) return undefined;
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
    return bytes.toString("utf8");
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
    const current = ids(await mapAt(head));
    if (current === undefined)
      throw new Error(
        `${repo}/${path} is not a JSON object, so no video can be called replaced`,
      );

    const merged: MappedVideo[] = [];
    const closedOnly: MappedVideo[] = [];
    const unread: number[] = [];
    for (let page = 1; page <= MAX_PULL_PAGES; page++) {
      const pulls = await get(
        `${base}/pulls?state=closed&per_page=100&page=${page}`,
      );
      const list = Array.isArray(pulls) ? pulls : [];
      for (const p of list) {
        if (!isObject(p) || typeof p.number !== "number") continue;
        const headRef = isObject(p.head) ? p.head : {};
        const baseRef = isObject(p.base) ? p.base : {};
        const headRepo = isObject(headRef.repo) ? headRef.repo : {};
        const user = isObject(p.user) ? p.user : {};
        if (
          typeof headRef.ref !== "string" ||
          !headRef.ref.startsWith(jobBranchPrefix(job)) ||
          headRepo.full_name !== repo ||
          user.type !== "Bot" ||
          baseRef.ref !== branch ||
          typeof headRef.sha !== "string" ||
          !SHA.test(headRef.sha) ||
          typeof baseRef.sha !== "string" ||
          !SHA.test(baseRef.sha)
        )
          continue;
        const after = ids(await mapAt(headRef.sha));
        const before = ids(await mapAt(baseRef.sha));
        if (after === undefined || before === undefined) {
          unread.push(p.number);
          continue;
        }
        const into = typeof p.merged_at === "string" ? merged : closedOnly;
        for (const v of addedVideos(after, before))
          into.push({ ...v, pull: p.number });
      }
      if (list.length < 100) break;
    }
    const known = new Set([
      ...merged.map((v) => v.youtubeId),
      ...current.values(),
    ]);
    return {
      history: {
        repo,
        path,
        branch,
        base: head,
        current,
        merged,
        neverMapped: closedOnly.filter((v) => !known.has(v.youtubeId)),
        unread,
      },
      secrets: [token.token],
    };
  } finally {
    await token.revoke().catch(() => undefined);
  }
}
