import type {
  CheckContext,
  PinnedPage,
  Source,
  UiSource,
} from "./pr.ts";


/** What the PR checker needs from a run's input: the pages as the model saw them, and the sources it could cite when there is a list. */
export interface PinnedInput {
  pages: PinnedPage[];
  sources?: Source[];
  /** The dashboard's navigation source, when the run had it (the docs watch jobs). */
  uiSource?: UiSource;
}

/** A self-describing input: pinned pages, the sources to cite, and the rules the PR checker applies. */
export interface ReplayInput extends PinnedInput {
  /** Every repository the input reads, as owner/name, with the commit it reads it at. */
  repos: Record<string, string>;
  rules: {
    repos: string[];
    paths: string[];
    max_changed_lines: number;
    /** Frontmatter keys the job may change; none when not given. */
    frontmatter_keys?: string[];
  };
  sources: Source[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asPinnedInput(value: unknown): PinnedInput | { error: string } {
  if (!isObject(value)) return { error: "the input is not a JSON object" };
  if (
    !Array.isArray(value.pages) ||
    !value.pages.every(
      (p) =>
        isObject(p) &&
        typeof p.repo === "string" &&
        typeof p.path === "string" &&
        typeof p.commit === "string" &&
        Array.isArray(p.lines) &&
        p.lines.every((l) => typeof l === "string"),
    )
  )
    return { error: "the input's pages are not a list of pinned pages" };
  if (value.sources !== undefined && !Array.isArray(value.sources))
    return { error: "the input's sources are not a list" };
  const ui = value.uiSource;
  if (
    ui !== undefined &&
    !(
      isObject(ui) &&
      typeof ui.repo === "string" &&
      Array.isArray(ui.routes) &&
      ui.routes.every((r) => typeof r === "string") &&
      Array.isArray(ui.files) &&
      ui.files.every(
        (f) =>
          isObject(f) &&
          Array.isArray(f.lines) &&
          f.lines.every((l) => typeof l === "string"),
      )
    )
  )
    return { error: "the input's uiSource is not files and routes" };
  return value as unknown as PinnedInput;
}

export function asReplayInput(value: unknown): ReplayInput | { error: string } {
  const pinned = asPinnedInput(value);
  if ("error" in pinned) return pinned;
  const { rules, sources } = value as Record<string, unknown>;
  if (
    !isObject(rules) ||
    !Array.isArray(rules.repos) ||
    !Array.isArray(rules.paths) ||
    typeof rules.max_changed_lines !== "number" ||
    !(
      rules.frontmatter_keys === undefined ||
      (Array.isArray(rules.frontmatter_keys) &&
        rules.frontmatter_keys.every((k) => typeof k === "string"))
    )
  )
    return {
      error: "the input has no rules (repos, paths, max_changed_lines)",
    };
  if (sources === undefined) return { error: "the input has no sources" };
  return value as ReplayInput;
}

/** What the PR checker checks a replay answer against: the rules, the pinned pages and the sources the model was given. */
export function replayContext(input: ReplayInput): CheckContext {
  return {
    policy: {
      repos: input.rules.repos,
      paths: input.rules.paths,
      maxChangedLines: input.rules.max_changed_lines,
      ...(input.rules.frontmatter_keys === undefined
        ? {}
        : { frontmatterKeys: input.rules.frontmatter_keys }),
    },
    pinned: input.pages,
    sources: input.sources,
    ...(input.uiSource === undefined ? {} : { ui: input.uiSource }),
  };
}
