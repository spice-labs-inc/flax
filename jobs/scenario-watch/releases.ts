/**
 * What customers can get, for the scenario watch: the releases of the
 * window in the product repositories, and the merged product changes
 * ranked and cut into sources to cite.
 */
import {
  Calls,
  collectCommits,
  commitSource,
  isNoiseFile,
  ORG,
  pool,
  type ExcerptCaps,
  type PrChange,
  type RepoCommits,
  type Window,
} from "./docs.ts";

const POOL = 4;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** One release as the gh-releases list gives it. */
export interface Release {
  tag: string;
  name: string;
  prerelease: boolean;
  draft: boolean;
  publishedAt: string;
  url: string;
}

function releasesOf(answer: unknown): Release[] {
  return records(answer).map((r) => ({
    tag: str(r.tag_name),
    name: str(r.name),
    prerelease: r.prerelease === true,
    draft: r.draft === true,
    publishedAt: str(r.published_at),
    url: str(r.html_url),
  }));
}

async function listReleases(
  calls: Calls,
  repo: string,
): Promise<Release[] | undefined> {
  const answer = await calls.json("gh-releases", { repo, per_page: 5 });
  return answer === undefined ? undefined : releasesOf(answer);
}

/**
 * The releases of the window in the given product repositories, and every
 * listed release of each; a repository whose list failed has none.
 */
export async function collectReleases(
  calls: Calls,
  w: Window,
  releaseRepos: readonly string[],
) {
  const lists = new Map<string, Release[]>();
  const perRepo = await pool(releaseRepos, POOL, async (repo) => {
    const list = await listReleases(calls, repo);
    if (list === undefined) return [];
    lists.set(repo, list);
    return list
      .filter((r) => !r.draft && Date.parse(r.publishedAt) >= w.since.getTime())
      .map((r) => ({
        repo,
        tag: r.tag,
        name: r.name,
        ...(r.prerelease ? { prerelease: true } : {}),
        publishedAt: r.publishedAt,
        url: r.url,
      }));
  });
  return { releases: perRepo.flat(), lists };
}

/**
 * The product changes of the window in the order they are given as
 * sources: changes in a repository that published a release after they
 * merged, then the rest. Within each, repositories take turns, newest
 * first, so one busy repository does not fill the list. Changes of only
 * tests, lock files and build output are left out: they can make nothing
 * on a page true.
 */
export function rankProductChanges(
  changes: readonly PrChange[],
  releases: readonly {
    repo: string;
    publishedAt: string;
    prerelease?: boolean;
  }[],
  releaseRepos: readonly string[],
): PrChange[] {
  const rank = (c: PrChange) =>
    releases.some(
      (r) =>
        r.repo === c.repo &&
        r.prerelease !== true &&
        Date.parse(r.publishedAt) >= Date.parse(c.mergedAt),
    )
      ? 0
      : 1;
  const ranked = changes
    .filter(
      (c) =>
        releaseRepos.includes(c.repo) &&
        c.files.some((f) => !isNoiseFile(f.path)),
    )
    .map((c) => ({ c, rank: rank(c) }))
    .sort(
      (a, b) => a.rank - b.rank || b.c.mergedAt.localeCompare(a.c.mergedAt),
    );
  const turn = new Map<string, number>();
  return ranked
    .map((x) => {
      const key = `${x.rank} ${x.c.repo}`;
      const n = turn.get(key) ?? 0;
      turn.set(key, n + 1);
      return { ...x, turn: n };
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.turn - b.turn ||
        b.c.mergedAt.localeCompare(a.c.mergedAt),
    )
    .map((x) => x.c);
}

type Source = ReturnType<typeof commitSource>;

/** How many product changes are given as sources, and how much of each diff. */
export interface ProductSourceCaps {
  sources: number;
  excerpt: ExcerptCaps;
}

/**
 * The ranked product changes as sources, with a short excerpt each, while
 * they fit the caps and the byte budget. A change whose merged commit is
 * not among its repository's newest 50 on main cannot be cited, and one
 * already given as a lead's source is not repeated.
 */
export async function productSources(
  calls: Calls,
  ranked: readonly PrChange[],
  commits: Map<string, RepoCommits>,
  repos: Record<string, string>,
  given: readonly Source[],
  budget: number,
  caps: ProductSourceCaps,
) {
  const sources: Source[] = [];
  const seen = new Set(given.map((s) => `${s.repo}@${s.commit}`));
  let bytes = 0;
  let notCitable = 0;
  let leftOut = 0;
  for (const c of ranked) {
    if (sources.length >= caps.sources) {
      leftOut += 1;
      continue;
    }
    let repo = commits.get(c.repo);
    if (repo === undefined) {
      repo = await collectCommits(calls, c.repo);
      commits.set(c.repo, repo);
    }
    const sha = repo.byPr.get(c.number);
    if (sha === undefined) {
      notCitable += 1;
      continue;
    }
    const source = commitSource(c, sha, new Set(), caps.excerpt);
    if (seen.has(`${source.repo}@${sha}`)) continue;
    const size = Buffer.byteLength(JSON.stringify(source));
    if (bytes + size > budget) {
      leftOut += 1;
      continue;
    }
    sources.push(source);
    bytes += size;
    if (repo.head !== undefined) repos[`${ORG}/${c.repo}`] = repo.head;
  }
  return { sources, notCitable, leftOut };
}
