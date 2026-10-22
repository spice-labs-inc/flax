import { existsSync, readdirSync, readFileSync } from "node:fs";
import { orgGithubUrlPattern } from "./workspace.ts";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { describeErrors } from "./ajv.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "./job.ts";
import { TOOLS_DIR } from "./paths.ts";
import { byCodePoint } from "./sort.ts";
import { firstLine, problem, warning, type Problem } from "./problem.ts";

export interface Model {
  id: string;
  provider: string;
  usd_per_million_input: number;
  usd_per_million_output: number;
  /** false marks a placeholder whose id or prices are not confirmed; no run may use it. */
  confirmed?: boolean;
  /** The thinking levels the model honors; any level Pi takes when not set. */
  thinking?: ThinkingLevel[];
}

/** Why a run of this model may not use this thinking level, or undefined when it may. */
export function thinkingRefusal(
  model: Model,
  level: ThinkingLevel,
): string | undefined {
  if (model.thinking === undefined || model.thinking.includes(level))
    return undefined;
  return `"${level}" is not a thinking level ${model.id} takes; models.yml lists ${model.thinking.join(", ")}`;
}

/**
 * A model id's family: the model line it belongs to, whatever its size or
 * provider prefix. anthropic/claude-sonnet-5-5 is claude, acme/acme-glm-5.3
 * and acme/acme-glm-5.3-flash are glm, acme/acme-deepseek-v4.1-flash is
 * deepseek. A second check by another family does not share the writer's
 * blind spots.
 */
export function modelFamily(id: string): string {
  const slash = id.indexOf("/");
  const provider = slash === -1 ? "" : id.slice(0, slash).toLowerCase();
  let name = id.slice(slash + 1).toLowerCase();
  // A provider that prefixes every model with its own name (acme/acme-glm-5.3) adds nothing to the family.
  if (provider !== "" && name.startsWith(`${provider}-`))
    name = name.slice(provider.length + 1);
  return name.split(/[-.\d]/, 1)[0]!;
}

/** The thinking levels any of these models takes, lowest first: the choice a run started by hand offers. */
export function offeredThinkingLevels(
  models: readonly Model[],
): ThinkingLevel[] {
  const taken = new Set(models.flatMap((m) => m.thinking ?? THINKING_LEVELS));
  return THINKING_LEVELS.filter((level) => taken.has(level));
}

/** A Slack channel tools may read, by the id the Slack API takes. */
export interface ReadChannel {
  id: string;
  name: string;
}

/** A Slack channel a job may post to. Posting needs its id; a channel without one takes shadow jobs only. */
export interface PostChannel {
  name: string;
  id?: string;
}

/** The channel shadow runs of slack jobs post to. */
export interface ShadowChannel {
  name: string;
  id: string;
}

export interface Allowlists {
  models: Model[];
  /** Slack channels a job's output may post to, by name. */
  channels: string[];
  postChannels: PostChannel[];
  /** Set when channels.yml names a shadow channel with an id; without one, shadow runs post nothing. */
  shadowChannel?: ShadowChannel;
  readChannels: ReadChannel[];
  /** URL prefixes a posted Slack message may link to. */
  links: string[];
  repos: string[];
  /** How to preview a change locally, by repository; a repository without one is not here. */
  repoPreviews: Readonly<Record<string, RepoPreview>>;
  /** Where a code-fixing job (output.code_fix) may change code and add tests, by repository; a repository without one takes no code fixes. */
  repoCode: Readonly<Record<string, RepoCode>>;
  tools: string[];
}

/**
 * Where a job that fixes code (output.code_fix) may work in a repository
 * (repos.yml code): the source files a fix may change, the test files it
 * may add or change, and the command a person runs to test it.
 */
export interface RepoCode {
  /** Globs of the files a fix may change, tests included. */
  paths: string[];
  /** Globs of the test files, the only place a fix may create a file. */
  tests: string[];
  /** How a person runs the tests in a checkout, for the pull request body. */
  test_command: string;
}

/** How a person runs a repository's site locally to look at a pull request's pages (repos.yml preview). */
export interface RepoPreview {
  /** Commands run in a checkout of the pull request's branch, in order. */
  commands: string[];
  /** Where the running site is, such as http://localhost:4321. */
  url: string;
  /** Docs pages under dir are served at prefix plus their path without the extension and a trailing /index. */
  pages?: { dir: string; prefix: string };
  /** The repository's own instructions, such as its README section. */
  docs?: string;
}

const price = { type: "number", minimum: 0 };
const REPO_NAME = "^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$";
const channelName = { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,79}$" };
const channelId = { type: "string", pattern: "^C[A-Z0-9]{8,12}$" };
/** Globs of source files: a plain relative path ending in a file name or extension pattern, never a folder alone. */
const codeGlobs = {
  type: "array",
  minItems: 1,
  maxItems: 20,
  uniqueItems: true,
  items: {
    type: "string",
    pattern: "^(?!/)(?!.*(^|/)\\.\\.(/|$))[A-Za-z0-9._*/-]+\\.[A-Za-z0-9]+$",
  },
};

// Built when first used, not at import: the repos.yml docs pattern names the workspace's GitHub owner.
function makeSchemas() {
  return {
    "models.yml": {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "provider",
          "usd_per_million_input",
          "usd_per_million_output",
        ],
        properties: {
          id: { type: "string", minLength: 1 },
          provider: { type: "string", minLength: 1 },
          usd_per_million_input: price,
          usd_per_million_output: price,
          confirmed: { type: "boolean" },
          thinking: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { enum: [...THINKING_LEVELS] },
          },
        },
      },
    },
    "channels.yml": {
      type: "object",
      additionalProperties: false,
      required: ["post", "read"],
      properties: {
        post: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: { id: channelId, name: channelName },
          },
        },
        shadow: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { id: channelId, name: channelName },
        },
        read: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name"],
            properties: { id: channelId, name: channelName },
          },
        },
        links: {
          type: "array",
          uniqueItems: true,
          items: {
            type: "string",
            pattern:
              "^https://[a-z0-9-]+(\\.[a-z0-9-]+)+/([A-Za-z0-9._~%-]+/)*$",
          },
        },
      },
    },
    "repos.yml": {
      type: "array",
      uniqueItems: true,
      items: {
        oneOf: [
          { type: "string", pattern: REPO_NAME },
          {
            type: "object",
            additionalProperties: false,
            required: ["repo"],
            properties: {
              repo: { type: "string", pattern: REPO_NAME },
              code: {
                type: "object",
                additionalProperties: false,
                required: ["paths", "tests", "test_command"],
                properties: {
                  paths: codeGlobs,
                  tests: codeGlobs,
                  test_command: {
                    type: "string",
                    pattern: "^[A-Za-z0-9 ._:/=@-]{1,120}$",
                  },
                },
              },
              preview: {
                type: "object",
                additionalProperties: false,
                required: ["commands", "url"],
                properties: {
                  commands: {
                    type: "array",
                    minItems: 1,
                    maxItems: 5,
                    items: {
                      type: "string",
                      pattern: "^[A-Za-z0-9 ._:/=@-]{1,100}$",
                    },
                  },
                  url: {
                    type: "string",
                    pattern: "^http://localhost:[0-9]{2,5}$",
                  },
                  pages: {
                    type: "object",
                    additionalProperties: false,
                    required: ["dir", "prefix"],
                    properties: {
                      dir: {
                        type: "string",
                        pattern: "^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$",
                      },
                      prefix: {
                        type: "string",
                        pattern: "^/([A-Za-z0-9._-]+/)*$",
                      },
                    },
                  },
                  docs: {
                    type: "string",
                    pattern: orgGithubUrlPattern(),
                  },
                },
              },
            },
          },
        ],
      },
    },
  } as const;
}
type ListFile = keyof ReturnType<typeof makeSchemas>;

let compiled:
  | { pattern: string; validators: Record<ListFile, ValidateFunction> }
  | undefined;

function validators(): Record<ListFile, ValidateFunction> {
  const pattern = orgGithubUrlPattern();
  if (compiled?.pattern !== pattern) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, verbose: true });
    compiled = {
      pattern,
      validators: Object.fromEntries(
        Object.entries(makeSchemas()).map(([file, schema]) => [
          file,
          ajv.compile(schema),
        ]),
      ) as Record<ListFile, ValidateFunction>,
    };
  }
  return compiled.validators;
}

function loadFile<T>(
  root: string,
  file: ListFile,
  problems: Problem[],
  empty: T,
): T {
  const path = join(root, file);
  if (!existsSync(path)) {
    problems.push(problem(file, "is missing"));
    return empty;
  }
  let data: unknown;
  try {
    data = parse(readFileSync(path, "utf8")) ?? empty;
  } catch (err) {
    problems.push(problem(file, `is not valid YAML: ${firstLine(err)}`));
    return empty;
  }
  const validate = validators()[file];
  if (!validate(data)) {
    for (const e of describeErrors(validate.errors))
      problems.push(problem(file, e.message, e.field));
    return empty;
  }
  return data as T;
}

type RepoEntry =
  string | { repo: string; preview?: RepoPreview; code?: RepoCode };

function loadRepos(
  root: string,
  problems: Problem[],
): Pick<Allowlists, "repos" | "repoPreviews" | "repoCode"> {
  const entries = loadFile<RepoEntry[]>(root, "repos.yml", problems, []);
  const repos: string[] = [];
  const repoPreviews: Record<string, RepoPreview> = {};
  const repoCode: Record<string, RepoCode> = {};
  for (const [i, e] of entries.entries()) {
    const name = typeof e === "string" ? e : e.repo;
    if (repos.includes(name))
      problems.push(
        problem("repos.yml", `"${name}" is listed twice`, `[${i}]`),
      );
    repos.push(name);
    if (typeof e !== "string" && e.preview !== undefined)
      repoPreviews[name] = e.preview;
    if (typeof e !== "string" && e.code !== undefined) repoCode[name] = e.code;
  }
  return { repos, repoPreviews, repoCode };
}

interface ChannelsFile {
  post: PostChannel[];
  shadow?: PostChannel;
  read: ReadChannel[];
  links?: string[];
}

function loadChannels(root: string, problems: Problem[]): ChannelsFile {
  const channels = loadFile<ChannelsFile>(root, "channels.yml", problems, {
    post: [],
    read: [],
  });
  for (const list of ["post", "read"] as const)
    for (const key of ["id", "name"] as const) {
      const seen = new Set<string>();
      for (const [i, c] of channels[list].entries()) {
        const value = c[key];
        if (value === undefined) continue;
        if (seen.has(value))
          problems.push(
            problem(
              "channels.yml",
              `duplicate channel ${key} "${value}"`,
              `${list}[${i}].${key}`,
            ),
          );
        seen.add(value);
      }
    }
  const shadow = channels.shadow;
  if (shadow !== undefined && shadow.id === undefined)
    problems.push(
      warning(
        "channels.yml",
        "not set, so shadow posting is off: shadow runs of slack jobs post nothing",
        "shadow.id",
      ),
    );
  if (shadow !== undefined)
    for (const [i, c] of channels.post.entries())
      for (const key of ["id", "name"] as const)
        if (shadow[key] !== undefined && c[key] === shadow[key])
          problems.push(
            problem(
              "channels.yml",
              `${key} "${shadow[key]}" belongs to the shadow channel, which no job names as its own`,
              `post[${i}].${key}`,
            ),
          );
  return channels;
}

function listTools(root: string): string[] {
  const dir = join(root, TOOLS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(byCodePoint);
}

export function loadAllowlists(root: string): {
  allowlists: Allowlists;
  problems: Problem[];
} {
  const problems: Problem[] = [];
  const models = loadFile<Model[]>(root, "models.yml", problems, []);
  const seen = new Set<string>();
  for (const [i, m] of models.entries()) {
    if (seen.has(m.id))
      problems.push(
        problem("models.yml", `duplicate model id "${m.id}"`, `[${i}].id`),
      );
    seen.add(m.id);
  }
  const channels = loadChannels(root, problems);
  return {
    allowlists: {
      models,
      channels: channels.post.map((c) => c.name),
      postChannels: channels.post,
      ...(channels.shadow?.id === undefined
        ? {}
        : {
            shadowChannel: {
              name: channels.shadow.name,
              id: channels.shadow.id,
            },
          }),
      readChannels: channels.read,
      links: channels.links ?? [],
      ...loadRepos(root, problems),
      tools: listTools(root),
    },
    problems,
  };
}
