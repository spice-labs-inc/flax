/**
 * Gathers the scenario watch input deterministically, through the run's
 * tools server (the job's collect_tools), never with credentials of its
 * own.
 *
 * It pins the scenario repository at its main commit and gives the model
 * every demo video scenario file (<scenarios dir>/<id>/scenario.ts), the
 * ones naming something the week's merged code changes removed (a test id,
 * a route, a label: the leads of docs.ts) first, with the merged commits
 * to cite and the UI's navigation source and routes. Releases come along
 * as context, never as evidence. While the job's own pull request is open
 * on the scenario repository, the input has no pages, so the run changes
 * nothing and that pull request stays as it is.
 */
import {
  connectCollectTools,
  type CollectTools,
  runMain,
} from "@flax/agents/collect/tools";
import {
  Calls,
  citableLeads,
  collectChanges,
  collectCommits,
  collectMergedPrs,
  collectUiSource,
  collection,
  fileLines,
  isScrubbed,
  leadNames,
  leadSources,
  matchLeads,
  openAgentPull,
  ORG,
  pool,
  readPage,
  selectPages,
  UI_REPO,
  WINDOW_DAYS,
  windowAt,
} from "./docs.ts";
import {
  collectReleases,
  productSources,
  rankProductChanges,
} from "./releases.ts";

export const JOB = "{{name}}";
/** The repository holding the scenario files, as owner/name, and its name under the organization. */
export const SCENARIO_REPO_FULL = "{{repo}}";
export const SCENARIO_REPO = SCENARIO_REPO_FULL.slice(
  SCENARIO_REPO_FULL.indexOf("/") + 1,
);
export const SCENARIOS_DIR = "{{scenariosDir}}";
/** What the model may change; the pr output of job.yml says the same. */
export const RULES = {
  repos: [SCENARIO_REPO_FULL],
  paths: [`${SCENARIOS_DIR}/*/scenario.ts`],
  max_changed_lines: 120,
};

/** Scenario files given to the model, the lead files first. */
export const MAX_PAGES = 12;
/** Scenario text given to the model, all files together. */
export const MAX_PAGE_BYTES = 200_000;
/** Source JSON given to the model, all sources together; the sources of the given files' leads always go in. */
export const MAX_SOURCE_BYTES = 60_000;
/** Merged changes of the product repositories given as sources. */
export const MAX_PRODUCT_SOURCES = 12;
const PRODUCT_EXCERPT = { files: 3, lines: 12 };
const POOL = 4;

/** Repositories whose releases customers can get, and whose merged changes the videos show; names under the organization. */
export const RELEASE_REPOS: readonly string[] = {{releaseRepos}};

/** Every scenario file under the scenarios directory: one scenario.ts per directory. */
export async function listScenarios(calls: Calls): Promise<string[]> {
  const answer = await calls.json("gh-file", {
    repo: SCENARIO_REPO,
    path: SCENARIOS_DIR,
  });
  if (!Array.isArray(answer)) return [];
  return answer
    .filter(
      (e): e is { type: string; path: string } =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: unknown }).type === "dir" &&
        typeof (e as { path?: unknown }).path === "string",
    )
    .map((e) => `${e.path}/scenario.ts`)
    .sort();
}

export async function collect(tools: CollectTools, now: Date) {
  const w = windowAt(now);
  const calls = new Calls(tools);
  const waiting = await openAgentPull(calls, JOB, SCENARIO_REPO);
  if (waiting !== undefined)
    return {
      generatedAt: now.toISOString(),
      rules: RULES,
      repos: {},
      pages: [],
      sources: [],
      waiting,
      collection: collection(calls),
    };

  const head = (await collectCommits(calls, SCENARIO_REPO)).head;
  if (head === undefined)
    throw new Error(`cannot read the newest commit of ${SCENARIO_REPO_FULL}`);
  const repos: Record<string, string> = { [SCENARIO_REPO_FULL]: head };

  const merged = await collectMergedPrs(calls, w);
  // The scenarios' own repository: its changes are the kit's, not the product's.
  const changes = await collectChanges(
    calls,
    merged.filter((p) => p.repo !== SCENARIO_REPO),
  );
  const withTerms = changes.filter((c) => c.removedTerms.length > 0);

  const paths = await listScenarios(calls);
  if (paths.length === 0)
    throw new Error(
      `could not list the scenarios of ${SCENARIO_REPO_FULL}: ${calls.failures.at(-1) ?? "it has none"}`,
    );
  const read = (
    await pool(paths, POOL, (path) => readPage(calls, SCENARIO_REPO, path))
  ).filter((p) => p !== undefined);
  const unreadable = paths.filter((p) => !read.some((r) => r.path === p));
  const scrubbed = read.filter((p) => isScrubbed(p.text)).map((p) => p.path);
  const usable = read.filter((p) => !scrubbed.includes(p.path));

  const candidates = matchLeads(usable, withTerms);
  const { citable, led, commits } = await citableLeads(
    calls,
    candidates,
    withTerms,
  );
  const leadsOf = new Map(citable.map((p) => [p.path, p.leads]));
  const ranked = selectPages(
    usable.map((p) => ({ ...p, leads: leadsOf.get(p.path) ?? [] })),
    { pages: MAX_PAGES, bytes: MAX_PAGE_BYTES },
  );
  const overCaps = usable
    .map((p) => p.path)
    .filter((p) => !ranked.some((c) => c.path === p))
    .sort();
  const sources = leadSources(ranked, led, commits, repos);
  const leadSourceCount = sources.length;

  const releases = await collectReleases(calls, w, RELEASE_REPOS);
  const fromProduct = await productSources(
    calls,
    rankProductChanges(changes, releases.releases, RELEASE_REPOS),
    commits,
    repos,
    sources,
    MAX_SOURCE_BYTES - Buffer.byteLength(JSON.stringify(sources)),
    { sources: MAX_PRODUCT_SOURCES, excerpt: PRODUCT_EXCERPT },
  );
  sources.push(...fromProduct.sources);

  let uiSource: Awaited<ReturnType<typeof collectUiSource>> | undefined;
  const uiHead =
    commits.get(UI_REPO)?.head ?? (await collectCommits(calls, UI_REPO)).head;
  if (uiHead === undefined) calls.record(UI_REPO, "no commit on main");
  else {
    repos[`${ORG}/${UI_REPO}`] = uiHead;
    uiSource = await collectUiSource(calls, uiHead);
  }

  // Files pinned at a commit must be that commit's text. The scenario
  // repository's main may move often, so a move fails the run only when it
  // touched the scenarios.
  const after = (await collectCommits(calls, SCENARIO_REPO)).head;
  if (after !== head) {
    const touched =
      after === undefined
        ? undefined
        : await scenariosTouched(calls, head, after);
    if (touched !== false)
      throw new Error(
        `${SCENARIO_REPO_FULL} main moved from ${head.slice(0, 12)} to ${after?.slice(0, 12) ?? "an unreadable commit"} while the scenarios were read${touched === true ? ", changing a scenario" : ""}; run the job again`,
      );
  }

  return {
    generatedAt: now.toISOString(),
    sinceIso: w.since.toISOString(),
    windowDays: WINDOW_DAYS,
    rules: RULES,
    repos,
    pages: ranked.map((p) => ({
      repo: SCENARIO_REPO_FULL,
      path: p.path,
      commit: head,
      lines: fileLines(p.text),
    })),
    sources,
    ...(uiSource === undefined ? {} : { uiSource }),
    leads: ranked
      .filter((p) => p.leads.length > 0)
      .map((p) => ({
        repo: SCENARIO_REPO_FULL,
        path: p.path,
        names: leadNames(p),
      })),
    pagesLeftOut: { overCaps, scrubbed: scrubbed.sort(), unreadable },
    signals: { releases: releases.releases },
    coverage: {
      mergedPullRequests: merged.length,
      codePullRequestsRead: changes.length,
      diffsCut: changes
        .filter((c) => c.diffCut)
        .map((c) => `${c.repo}#${c.number}`),
      pullRequestsWithRemovedNames: withTerms.length,
      scenarios: paths.length,
      scenariosRead: read.length,
      scenariosWithLeads: candidates.length,
      scenariosGiven: ranked.length,
      leadSources: leadSourceCount,
      productSources: fromProduct.sources.length,
      productChangesNotCitable: fromProduct.notCitable,
      productChangesLeftOut: fromProduct.leftOut,
    },
    collection: collection(calls),
  };
}

async function main(): Promise<void> {
  const tools = await connectCollectTools();
  try {
    process.stdout.write(
      `${JSON.stringify(await collect(tools, new Date()))}\n`,
    );
  } finally {
    await tools.close();
  }
}

await runMain(import.meta.url, JOB, main);

/** Whether head..after changed a file under the scenarios directory; undefined when the comparison cannot tell. */
async function scenariosTouched(
  calls: Calls,
  head: string,
  after: string,
): Promise<boolean | undefined> {
  const cmp = await calls.json("gh-compare", {
    repo: SCENARIO_REPO,
    base: head,
    head: after,
  });
  if (
    typeof cmp !== "object" ||
    cmp === null ||
    !Array.isArray((cmp as { files?: unknown }).files) ||
    (cmp as { files_may_be_more?: unknown }).files_may_be_more === true
  )
    return undefined;
  return (
    (cmp as { files: unknown[] }).files as {
      path?: unknown;
      previous_path?: unknown;
    }[]
  ).some((f) =>
    [f.path, f.previous_path].some(
      (p) => typeof p === "string" && p.startsWith(`${SCENARIOS_DIR}/`),
    ),
  );
}
