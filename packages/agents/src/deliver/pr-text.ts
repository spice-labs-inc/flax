import type { RepoPreview } from "../lib/allowlists.ts";
import { workspace } from "../lib/workspace.ts";
import { COMMAND, MAX_ROUNDS } from "../revise/requests.ts";

const GITHUB = "https://github.com";

/** Links model text may keep: the organization's repositories and its own sites. */
function keptUrl(): RegExp {
  const ws = workspace();
  const hosts = ws.trustedLinkHosts.map((h) => h.replaceAll(".", "\\."));
  const own = hosts.length === 0 ? "" : `|([a-z0-9-]+\\.)*(${hosts.join("|")})(\/|$)`;
  return new RegExp(`^https:\/\/(github\\.com\/${ws.github}\/${own})`, "i");
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
const WORD_JOINER = "\u2060";

function escapeProse(text: string): string {
  return text
    .replace(/[\\`*_{}[\]()!|~+]/g, (c) => `\\${c}`)
    .replace(/#(?=\d)/g, `#${WORD_JOINER}`)
    .replace(/#/g, (c, i: number, all: string) =>
      all[i + 1] === WORD_JOINER ? c : "\\#",
    )
    .replace(/@/g, `@${WORD_JOINER}`)
    .replace(/:\/\//g, `:${WORD_JOINER}//`);
}

/**
 * Text the kit did not write (a model's reason or reply, a title from a
 * scenario file) as one wrapped paragraph of plain prose: HTML, markdown
 * links, images and layout markers do not render, nobody is mentioned, no
 * issue or pull request is referenced, and only links to the
 * organization's own places stay links.
 */
export function plainText(
  text: string,
  keepUrl: (url: string) => boolean = (u) => keptUrl().test(u),
): string {
  const one = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  let out = "";
  let at = 0;
  for (const m of one.matchAll(URL_IN_TEXT)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, "");
    out += escapeProse(one.slice(at, m.index));
    out += keepUrl(url) ? url : escapeProse(url);
    at = m.index + url.length;
  }
  out += escapeProse(one.slice(at));
  // A line that starts like a list item or an ordered list would change the layout.
  return out.replace(/^-(?=\s)/, "\\-").replace(/^(\d+)\.(?=\s)/, "$1\\.");
}

/** Several pieces of model text as a list of plain paragraphs. */
export function plainList(items: readonly string[]): string[] {
  return items.map((t) => `- ${plainText(t)}`);
}

/** A value the kit already checked, as a code span. */
export function code(text: string): string {
  return `\`${text.replaceAll("`", "'").replaceAll("\n", " ")}\``;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** A link to a file as it is on a branch of an organization repository. */
export function fileLink(repo: string, branch: string, path: string): string {
  return `[${code(path)}](${GITHUB}/${repo}/blob/${encodePath(branch)}/${encodePath(path)})`;
}

/** A short link to a commit: repo#123 when its title names its pull request, else repo@sha. */
export function commitLink(
  repo: string,
  commit: string,
  title?: string,
): string {
  const name = repo.split("/").pop() ?? repo;
  const pr = /\(#(\d+)\)\s*$/.exec(title ?? "")?.[1];
  return pr === undefined
    ? `[${name}@${commit.slice(0, 7)}](${GITHUB}/${repo}/commit/${commit})`
    : `[${name}#${pr}](${GITHUB}/${repo}/pull/${pr})`;
}

/** Where the running site serves a changed page, when the preview says how pages map to paths. */
export function pageUrl(
  preview: RepoPreview,
  path: string,
): string | undefined {
  const pages = preview.pages;
  if (pages === undefined) return undefined;
  const dir = `${pages.dir.replace(/\/$/, "")}/`;
  if (!path.startsWith(dir) || !/\.mdx?$/.test(path)) return undefined;
  const slug = path
    .slice(dir.length)
    .replace(/\.mdx?$/, "")
    .replace(/(^|\/)index$/, "");
  return `${preview.url}${pages.prefix}${slug === "" ? "" : `${slug}/`}`;
}

/** The Preview section: the commands, then where to look; empty when the repository has no preview. */
export function previewSection(
  preview: RepoPreview | undefined,
  paths: readonly string[],
  branch: string,
): string[] {
  if (preview === undefined) return [];
  const urls = paths
    .map((p) => pageUrl(preview, p))
    .filter((u): u is string => u !== undefined);
  return [
    "**Preview**",
    "",
    "```sh",
    `git switch ${branch}`,
    ...preview.commands,
    "```",
    "",
    ...(urls.length > 0
      ? urls.map((u) => `- ${u}`)
      : [`Then open ${preview.url}.`]),
    ...(preview.docs === undefined
      ? []
      : ["", `More in the repository's [instructions](${preview.docs}).`]),
    "",
  ];
}

/** How to ask the Notes Agent for changes. */
export function reviewingSection(builtByCode: boolean): string[] {
  return [
    "**Reviewing**",
    "",
    builtByCode
      ? `No model wrote this change, so no ${workspace().displayName} answers comments here. Push a commit to this branch or close the pull request; the next run starts from the product as it is then.`
      : `Submit a review with **Request changes**, or comment ${code(COMMAND)} with what to change. The ${workspace().displayName} replies in each comment's thread within about 15 minutes, with a new commit or an answer, for up to ${MAX_ROUNDS} rounds.`,
    "",
  ];
}

/** An image's bytes as a ref of an organization repository has them, for showing it in a pull request body. */
export function imageUrl(repo: string, ref: string, path: string): string {
  return `${GITHUB}/${repo}/blob/${encodePath(ref)}/${encodePath(path)}?raw=true`;
}
