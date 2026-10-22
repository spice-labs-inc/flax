import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { describeErrors } from "./ajv.ts";
import { GITHUB_HOSTS_FILE } from "./paths.ts";
import { GITHUB_HOSTS_SCHEMA } from "./schemas.ts";
import { firstLine, problem, type Problem } from "./problem.ts";

export const GITHUB_META_URL = "https://api.github.com/meta";

/** A github-log-hosts.yml that has passed its schema. */
export interface GithubHosts {
  fetched: string;
  source: typeof GITHUB_META_URL;
  hosts: string[];
}

let validator: ValidateFunction | undefined;

function hostsValidator(): ValidateFunction {
  validator ??= new Ajv2020({
    allErrors: true,
    strict: true,
    verbose: true,
  }).compile(GITHUB_HOSTS_SCHEMA);
  return validator;
}

/** The problems with parsed github-log-hosts.yml contents; none when the shape is right. */
export function githubHostsProblems(data: unknown): Problem[] {
  const validate = hostsValidator();
  if (validate(data)) return [];
  return describeErrors(validate.errors).map((e) =>
    problem(GITHUB_HOSTS_FILE, e.message, e.field),
  );
}

export function loadGithubHosts(root: string): {
  hosts?: GithubHosts;
  problems: Problem[];
} {
  const file = GITHUB_HOSTS_FILE;
  const path = join(root, file);
  if (!existsSync(path)) return { problems: [problem(file, "is missing")] };
  let data: unknown;
  try {
    data = parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      problems: [problem(file, `is not valid YAML: ${firstLine(err)}`)],
    };
  }
  const problems = githubHostsProblems(data);
  return problems.length > 0
    ? { problems }
    : { hosts: data as GithubHosts, problems };
}
