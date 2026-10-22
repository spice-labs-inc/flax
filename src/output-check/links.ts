import {
  allowedPaths,
  hostAllowed,
  hostRestrictedToPaths,
  loadLinkHosts,
  type LinkHosts,
} from "../lib/link-hosts.ts";
import { workspaceRoot } from "../lib/workspace.ts";
import { formatProblem } from "../lib/problem.ts";

/** A line a patch adds, with its 1-based line number in the patched page. */
export interface AddedLine {
  line: number;
  text: string;
}

let shipped: LinkHosts | undefined;

/** The committed link-hosts.yml; throws when it is missing or invalid, so a patch is never checked without it. */
export function shippedLinkHosts(): LinkHosts {
  if (shipped !== undefined) return shipped;
  const { hosts, problems } = loadLinkHosts(workspaceRoot());
  if (hosts === undefined)
    throw new Error(
      `the PR checker has no link allowlist: ${problems.map(formatProblem).join("; ")}`,
    );
  shipped = hosts;
  return hosts;
}

const URL_ATTRS =
  "src|srcset|href|xlink:href|poster|background|action|formaction|data";
const MD_IMAGE =
  /!\[(?:[^[\]\n]|\[[^[\]\n]*\])*\](?:\s*\([^)\n]*\)?|\s*\[[^\]\n]*\]?)?/y;
const IMG_TAG = /<img\b[^>\n]*>?/gi;
const URL_TAG = new RegExp(
  `<[a-z][\\w:.-]*\\b[^>\\n]*?\\s(?:${URL_ATTRS})\\s*=[^>\\n]*>?`,
  "gi",
);
const ATTR_VALUE = `("[^"\\n]*"?|'[^'\\n]*'?|\\{[^}\\n]*\\}?|[^\\s>]*)`;
const URL_ATTR = new RegExp(`(?<=^|\\s)(${URL_ATTRS})=${ATTR_VALUE}`, "gi");
const TAG_ATTR = new RegExp(
  `(?<=\\s)(${URL_ATTRS})\\s*=\\s*${ATTR_VALUE}`,
  "gi",
);

/** Whether a path names a page on the same site: no scheme, no host, nothing escaped or encoded. */
function plainRelative(v: string): boolean {
  return (
    !/^[a-z][a-z0-9+.-]*:/i.test(v) &&
    !v.startsWith("//") &&
    !/[\\%\s\x00-\x1f]|&[#a-z0-9]+;/i.test(v)
  );
}

/** Whether an attribute is href with a literal, plainly relative value, which cannot send data off the site. */
function relativeHref(name: string, raw: string): boolean {
  if (name.toLowerCase() !== "href") return false;
  const jsx = /^\{\s*(["'`])(.*)\1\s*\}$/.exec(raw);
  if (jsx !== null)
    return (
      !(jsx[1] === "`" && jsx[2]!.includes("${")) && plainRelative(jsx[2]!)
    );
  if (/^["']/.test(raw))
    return (
      raw.length >= 2 &&
      raw.at(-1) === raw[0] &&
      plainRelative(raw.slice(1, -1))
    );
  return !/^[{`]/.test(raw) && plainRelative(raw);
}

interface Embed {
  kind: "image" | "img" | "tag";
  text: string;
  start: number;
  end: number;
}

/** Markdown images, <img> tags, and HTML tags or attributes that load or link a URL; a plainly relative href is neither. */
export function embedsIn(line: string): Embed[] {
  const out: Embed[] = [];
  const within = (i: number) => out.some((e) => i >= e.start && i < e.end);
  for (let i = line.indexOf("!["); i >= 0; i = line.indexOf("![", i + 2)) {
    if (within(i)) continue;
    MD_IMAGE.lastIndex = i;
    const m = MD_IMAGE.exec(line);
    const text = m === null ? line.slice(i) : m[0];
    out.push({ kind: "image", text, start: i, end: i + text.length });
  }
  const harmless = (m: RegExpExecArray): boolean =>
    m[0].startsWith("<")
      ? [...m[0].matchAll(TAG_ATTR)].every((a) => relativeHref(a[1]!, a[2]!))
      : relativeHref(m[1]!, m[2]!);
  for (const [kind, re] of [
    ["img", IMG_TAG],
    ["tag", URL_TAG],
    ["tag", URL_ATTR],
  ] as const)
    for (const m of line.matchAll(re))
      if (!within(m.index) && (kind === "img" || !harmless(m)))
        out.push({
          kind,
          text: m[0],
          start: m.index,
          end: m.index + m[0].length,
        });
  return out.sort((a, b) => a.start - b.start);
}

// A URL starts at a scheme and ://, at // before a dotted host (a
// protocol-relative link), or at www. (which GitHub links). Every start is
// read on its own, so a URL inside another URL's query is checked too.
const URL_START =
  /\b[a-z][a-z0-9+.-]*:\/\/|(?<![\w/:.-])\/\/(?=[a-z0-9-]+(?:\.[a-z0-9-]+)+)|(?<![\w.@/-])www\./gi;
const DESTINATION = /\]\(\s*(?:<([^>\n]*)>|([^\s)]*))/g;
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:\s*<?([^\s>]*)/;
const AUTOLINK = /<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/gi;

function trimUrl(raw: string): string {
  let s = raw;
  for (;;) {
    const t = s.replace(/[.,:;!?*_~'"`]+$/, "");
    const open = t.split("(").length;
    const close = t.split(")").length;
    const u = t.endsWith(")") && close > open ? t.slice(0, -1) : t;
    if (u === s) return s;
    s = u;
  }
}

interface Target {
  raw: string;
  /** A Markdown link destination, where character references and backslash escapes are decoded. */
  destination: boolean;
}

/** The link targets in a line: bare URLs, Markdown destinations and definitions, and autolinks. */
export function targetsIn(line: string): Target[] {
  const out = new Map<string, Target>();
  const add = (raw: string, destination: boolean) => {
    if (raw === "") return;
    const prior = out.get(raw);
    out.set(raw, { raw, destination: destination || !!prior?.destination });
  };
  // GitHub turns only bare http(s) and www. text into links, so bare text
  // such as `docker://nginx` is not a target; in a destination or an
  // autolink any scheme is.
  for (const m of line.matchAll(URL_START)) {
    const raw = trimUrl(/^[^\s<>]*/.exec(line.slice(m.index))![0]);
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
    if (scheme === undefined || scheme === "http" || scheme === "https")
      add(raw, false);
  }
  for (const m of line.matchAll(DESTINATION)) add(m[1] ?? m[2]!, true);
  const def = DEFINITION.exec(line);
  if (def !== null) add(def[1]!, true);
  for (const m of line.matchAll(AUTOLINK)) add(m[1]!, false);
  return [...out.values()];
}

type Parsed =
  | { kind: "relative" }
  | { kind: "scheme"; scheme: string }
  | { kind: "unreadable" }
  | { kind: "web"; url: URL; host: string };

function parseTarget(raw: string): Parsed {
  let text = raw;
  if (/^www\./i.test(text)) text = `http://${text}`;
  else if (text.startsWith("//")) text = `https:${text}`;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme === undefined) return { kind: "relative" };
  if (scheme !== "http" && scheme !== "https")
    return { kind: "scheme", scheme };
  try {
    const url = new URL(text);
    return { kind: "web", url, host: url.hostname.replace(/\.$/, "") };
  } catch {
    return { kind: "unreadable" };
  }
}

function quote(text: string): string {
  return JSON.stringify(text.length > 100 ? `${text.slice(0, 97)}...` : text);
}

const NO_EMBEDS =
  "a proposed change may add none, whatever the host, since GitHub fetches what they point to as soon as the page or its diff is shown";

function targetProblem(
  t: Target,
  hosts: LinkHosts,
  pageHosts: ReadonlySet<string>,
): string | undefined {
  if (t.destination && /&[#a-z0-9]+;|\\/i.test(t.raw))
    return "adds a link target with character references or backslash escapes, which the PR checker does not decode; write the URL plainly";
  const p = parseTarget(t.raw);
  switch (p.kind) {
    case "relative":
      return undefined;
    case "scheme":
      return `adds a ${p.scheme}: link; only http and https links may be added`;
    case "unreadable":
      return "adds a link the PR checker cannot read as a URL";
  }
  const restricted = hostRestrictedToPaths(hosts, p.host);
  if (
    !hostAllowed(hosts, p.host, p.url.pathname) &&
    (restricted || !pageHosts.has(p.host))
  )
    return restricted
      ? `links to ${p.host} outside ${allowedPaths(hosts, p.host).join(", ")}, the only paths link-hosts.yml allows there`
      : `links to ${p.host}, which is not in link-hosts.yml and not already linked from the page`;
  const query = Math.max(0, p.url.search.length - 1);
  if (
    query > hosts.max_query_length &&
    !hosts.long_query_hosts.includes(p.host)
  )
    return `adds a link with a ${query}-character query string, over the limit of ${hosts.max_query_length} for a new link (link-hosts.yml), since a query can carry data out`;
  return undefined;
}

/**
 * The output channel rules for the lines a patch adds. A reader, a
 * renderer or a link unfurler can carry data to whatever host a link
 * names, and GitHub fetches images without anyone clicking. So an added
 * line may bring in no image or URL-loading HTML at all, and a link only
 * to a host in link-hosts.yml or one the page already links to (never
 * github.com outside its allowed paths), with a short query string. A
 * construct or URL the page already has may be kept or moved. With
 * markdown false (a source file a code fix changes, which nothing renders)
 * ![...] is code, not an image; every other rule holds.
 */
export function linkProblems(
  page: readonly string[],
  added: readonly AddedLine[],
  hosts: LinkHosts,
  options: { markdown?: boolean } = {},
): string[] {
  const pageText = page.join("\n");
  const pageTargets = new Set<string>();
  const pageHosts = new Set<string>();
  for (const line of page)
    for (const t of targetsIn(line)) {
      pageTargets.add(t.raw);
      const p = parseTarget(t.raw);
      if (p.kind === "web") pageHosts.add(p.host);
    }
  const out: string[] = [];
  for (const { line, text } of added) {
    const found = new Set<string>();
    for (const e of embedsIn(text)) {
      if (pageText.includes(e.text)) continue;
      // In source code ![...] is code (a Rust macro, a negated index), never an image.
      if (e.kind === "image" && options.markdown === false) continue;
      const what =
        e.kind === "image"
          ? "a Markdown image"
          : e.kind === "img"
            ? "an HTML <img> tag"
            : "an HTML tag or attribute that loads or links a URL (src, href and the like)";
      found.add(`line ${line} adds ${what}; ${NO_EMBEDS}: ${quote(e.text)}`);
    }
    for (const t of targetsIn(text)) {
      if (pageTargets.has(t.raw)) continue;
      const why = targetProblem(t, hosts, pageHosts);
      if (why !== undefined) found.add(`line ${line} ${why}: ${quote(t.raw)}`);
    }
    out.push(...found);
  }
  return out;
}
