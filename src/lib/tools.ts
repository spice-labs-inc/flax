import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { workspace } from "./workspace.ts";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { createAjv, describeErrors } from "./ajv.ts";
import { TOOL_SCHEMA_PATH, toolFile, TOOLS_DIR } from "./paths.ts";
import { firstLine, problem, type Problem } from "./problem.ts";
import { byCodePoint } from "./sort.ts";

/** A tool.yml that has passed schema/tool.schema.json and the checks below. */
export interface ToolSpec {
  name: string;
  description: string;
  arguments: Record<string, unknown>;
  upstream: { server: string; operations: string[] };
  /** untrusted: results can carry text anyone can write, such as pull request bodies, Slack messages or log lines. */
  source: ToolSource;
  result_max_bytes: number;
}

export type ToolSource = "trusted" | "untrusted";

export interface ToolEntry {
  /** The folder name under tools/. */
  name: string;
  /** Set only when the folder and tool.yml passed every check here. */
  spec?: ToolSpec;
  problems: Problem[];
}

/** The operations each upstream offers. A tool.yml may list only these. */
export const UPSTREAM_OPERATIONS: Readonly<Record<string, readonly string[]>> =
  {
    builtin: ["echo"],
    kubernetes: [
      "pods_list",
      "pods_get",
      "events_list",
      "pods_log",
      "resources_list",
      "resources_get",
      "namespaces_list",
    ],
    github: [
      "actions_list",
      "get_job_logs",
      "list_pull_requests",
      "pull_request_read",
      "search_pull_requests",
      "list_releases",
      "get_latest_release",
      "list_commits",
      "get_file_contents",
      "projects_list",
      "list_issues",
      "issue_read",
      "maintainer_notes_list",
      "compare_commits",
      "run_report_read",
      "commit_grep",
      "path_history",
      "commit_blame",
      "commit_tree",
    ],
    openobserve: [
      "StreamList",
      "StreamSchema",
      "SearchSQL",
      "SearchTracesSQL",
      "PrometheusRangeQuery",
      "GetLatestTraces",
    ],
    slack: ["conversations.history", "conversations.replies"],
  };

/**
 * The secrets each upstream needs, by environment variable. They reach
 * only the runner process: never the box, lbx or collect.ts.
 */
export function upstreamSecretsByServer(): Readonly<Record<string, readonly string[]>> {
  const ws = workspace();
  const kube = Object.values(ws.clusters);
  const o2 = ws.openobserve === undefined ? [] : [ws.clusters[ws.openobserve.cluster] ?? "KUBECONFIG_OPENOBSERVE"];
  return {
    builtin: [],
    kubernetes: kube,
    github: ["AGENTS_READER_APP_ID", "AGENTS_READER_PRIVATE_KEY"],
    openobserve: [...o2, "OPENOBSERVE_CI_AUTH"],
    slack: ["SLACK_AGENTS_BOT_TOKEN"],
  };
}

/** Every tool secret, each once, in a fixed order. */
/**
 * Variables kept out of the box with the secrets but not secret themselves:
 * a GitHub App's id is a public number that docs and commits name, a
 * mailbox user is an address, and a YouTube channel id is in every link to
 * the channel, so scrubbing them would fail runs that read or show them.
 */
export const NOT_SECRET_ENV: ReadonlySet<string> = new Set([
  "AGENTS_READER_APP_ID",
  "AGENTS_WRITER_APP_ID",
  "LIVETESTS_MAILBOX_USER",
  "YOUTUBE_CHANNEL_ID",
]);

export function toolSecretEnv(): readonly string[] {
  return [...new Set(Object.values(upstreamSecretsByServer()).flat())];
}

/** The environment without any tool credential, for every process but the runner itself. */
export function withoutToolSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of toolSecretEnv()) delete out[name];
  return out;
}

/** The upstreams the named tools read from, each once, in the order the tools name them. */
export function toolUpstreams(
  tools: readonly Pick<ToolEntry, "name" | "spec">[],
  names: readonly string[],
): string[] {
  const servers = new Set<string>();
  for (const name of names) {
    const server = tools.find((t) => t.name === name)?.spec?.upstream.server;
    if (server !== undefined) servers.add(server);
  }
  return [...servers];
}

/** The operations the named tools call on one upstream, each once, in the order the tools name them. */
export function toolOperations(
  tools: readonly Pick<ToolEntry, "name" | "spec">[],
  names: readonly string[],
  server: string,
): string[] {
  const ops = new Set<string>();
  for (const name of names) {
    const spec = tools.find((t) => t.name === name)?.spec;
    if (spec?.upstream.server === server)
      for (const op of spec.upstream.operations) ops.add(op);
  }
  return [...ops];
}

/** The secrets those upstreams need, each once, in the order of TOOL_SECRET_ENV. */
export function upstreamSecrets(servers: readonly string[]): string[] {
  const wanted = new Set(servers.flatMap((s) => upstreamSecretsByServer()[s] ?? []));
  return toolSecretEnv().filter((name) => wanted.has(name));
}

export const TOOL_ENTRIES = ["tool.yml", "map.ts"] as const;

/** The longest string and the most array items an argument may allow. */
export const MAX_ARGUMENT_STRING = 16384;
export const MAX_ARGUMENT_ITEMS = 100;

const COMPOSITION = [
  "$ref",
  "$dynamicRef",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentSchemas",
  "unevaluatedProperties",
  "unevaluatedItems",
  "prefixItems",
  "contains",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFixedValues(node: Record<string, unknown>): boolean {
  return Array.isArray(node.enum) || "const" in node;
}

/**
 * Where an argument schema leaves a value unbounded. Every value needs a
 * limit the tools server can enforce before anything reaches an upstream:
 * strings a maxLength, numbers a minimum and maximum, arrays maxItems, and
 * objects no properties beyond the ones they name.
 */
export function argumentProblems(
  node: unknown,
  field = "arguments",
): { field: string; message: string }[] {
  const at = (message: string) => [{ field, message }];
  if (!isObject(node)) return at("must be a JSON Schema object");
  const used = COMPOSITION.filter((k) => k in node);
  if (used.length > 0)
    return at(
      `uses ${used.join(", ")}; argument schemas use plain types so their limits can be checked`,
    );
  const out: { field: string; message: string }[] = [];
  switch (node.type) {
    case "string":
      if (
        !hasFixedValues(node) &&
        !(
          Number.isInteger(node.maxLength) &&
          (node.maxLength as number) <= MAX_ARGUMENT_STRING
        )
      )
        out.push(
          ...at(`a string needs maxLength of at most ${MAX_ARGUMENT_STRING}`),
        );
      break;
    case "integer":
    case "number":
      if (
        !hasFixedValues(node) &&
        (typeof node.minimum !== "number" || typeof node.maximum !== "number")
      )
        out.push(
          ...at(
            `${node.type === "integer" ? "an integer" : "a number"} needs minimum and maximum`,
          ),
        );
      break;
    case "boolean":
      break;
    case "array":
      if (!(
        Number.isInteger(node.maxItems) &&
        (node.maxItems as number) <= MAX_ARGUMENT_ITEMS
      ))
        out.push(
          ...at(`an array needs maxItems of at most ${MAX_ARGUMENT_ITEMS}`),
        );
      out.push(...argumentProblems(node.items, `${field}.items`));
      break;
    case "object": {
      if (node.additionalProperties !== false)
        out.push(...at("an object needs additionalProperties: false"));
      const properties = node.properties ?? {};
      if (!isObject(properties)) {
        out.push(...at("properties must be an object"));
        break;
      }
      for (const [key, value] of Object.entries(properties))
        out.push(...argumentProblems(value, `${field}.properties.${key}`));
      break;
    }
    default:
      out.push(
        ...at(
          "needs a type of string, integer, number, boolean, array or object",
        ),
      );
  }
  return out;
}

let validator: ValidateFunction | undefined;

function toolValidator(): ValidateFunction {
  validator ??= new Ajv2020({
    allErrors: true,
    strict: true,
    verbose: true,
  }).compile(JSON.parse(readFileSync(TOOL_SCHEMA_PATH, "utf8")));
  return validator;
}

function folderProblems(root: string, name: string): Problem[] {
  const problems: Problem[] = [];
  for (const entry of readdirSync(join(root, TOOLS_DIR, name)).sort(
    byCodePoint,
  )) {
    if (!(TOOL_ENTRIES as readonly string[]).includes(entry))
      problems.push(
        problem(
          toolFile(name, entry),
          `is not allowed in a tool folder (allowed: ${TOOL_ENTRIES.join(", ")})`,
        ),
      );
  }
  for (const entry of TOOL_ENTRIES) {
    const file = toolFile(name, entry);
    let stat;
    try {
      stat = lstatSync(join(root, file));
    } catch {
      problems.push(problem(file, "is missing"));
      continue;
    }
    if (stat.isSymbolicLink())
      problems.push(problem(file, "must not be a symlink"));
    else if (!stat.isFile()) problems.push(problem(file, "must be a file"));
  }
  return problems;
}

export function loadTool(root: string, name: string): ToolEntry {
  const problems = folderProblems(root, name);
  if (problems.length > 0) return { name, problems };
  const file = toolFile(name, "tool.yml");
  let data: unknown;
  try {
    data = parse(readFileSync(join(root, file), "utf8"));
  } catch (err) {
    return {
      name,
      problems: [problem(file, `is not valid YAML: ${firstLine(err)}`)],
    };
  }
  const validate = toolValidator();
  if (!validate(data)) {
    return {
      name,
      problems: describeErrors(validate.errors).map((e) =>
        problem(file, e.message, e.field),
      ),
    };
  }
  const spec = data as ToolSpec;
  if (spec.name !== name)
    problems.push(
      problem(
        file,
        `"${spec.name}" must equal the folder name "${name}"`,
        "name",
      ),
    );
  const known = UPSTREAM_OPERATIONS[spec.upstream.server] ?? [];
  for (const [i, op] of spec.upstream.operations.entries()) {
    if (!known.includes(op))
      problems.push(
        problem(
          file,
          `"${op}" is not an operation of ${spec.upstream.server} (known: ${known.join(", ")})`,
          `upstream.operations[${i}]`,
        ),
      );
  }
  if (spec.arguments.type !== "object")
    problems.push(problem(file, "must have type: object", "arguments"));
  else
    for (const p of argumentProblems(spec.arguments))
      problems.push(problem(file, p.message, p.field));
  try {
    createAjv().compile(spec.arguments);
  } catch (err) {
    problems.push(
      problem(
        file,
        `is not a valid JSON Schema: ${firstLine(err)}`,
        "arguments",
      ),
    );
  }
  return problems.length > 0 ? { name, problems } : { name, spec, problems };
}

/** Every folder under tools/, loaded and checked. Other entries, such as README.md, are left alone. */
export function loadTools(root: string): ToolEntry[] {
  const dir = join(root, TOOLS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(byCodePoint)
    .map((name) => loadTool(root, name));
}
