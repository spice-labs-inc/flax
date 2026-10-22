import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { describeErrors } from "./ajv.ts";
import { LINK_HOSTS_FILE, LINK_HOSTS_SCHEMA_PATH } from "./paths.ts";
import { firstLine, problem, type Problem } from "./problem.ts";

/** A link-hosts.yml that has passed its schema. */
export interface LinkHosts {
  max_query_length: number;
  long_query_hosts: string[];
  hosts: string[];
}

let validator: ValidateFunction | undefined;

/** The problems with parsed link-hosts.yml contents; none when the shape is right. */
export function linkHostsProblems(data: unknown): Problem[] {
  validator ??= new Ajv2020({
    allErrors: true,
    strict: true,
    verbose: true,
  }).compile(JSON.parse(readFileSync(LINK_HOSTS_SCHEMA_PATH, "utf8")));
  if (validator(data)) return [];
  return describeErrors(validator.errors).map((e) =>
    problem(LINK_HOSTS_FILE, e.message, e.field),
  );
}

export function loadLinkHosts(root: string): {
  hosts?: LinkHosts;
  problems: Problem[];
} {
  const file = LINK_HOSTS_FILE;
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
  const problems = linkHostsProblems(data);
  return problems.length > 0
    ? { problems }
    : { hosts: data as LinkHosts, problems };
}

interface Entry {
  host: string;
  wildcard: boolean;
  /** Lower case, without a trailing slash; undefined for the whole host. */
  path?: string;
}

function entries(hosts: LinkHosts): Entry[] {
  return hosts.hosts.map((h) => {
    const slash = h.indexOf("/");
    const name = slash < 0 ? h : h.slice(0, slash);
    const wildcard = name.startsWith("*.");
    return {
      host: wildcard ? name.slice(2) : name,
      wildcard,
      ...(slash < 0 ? {} : { path: h.slice(slash).toLowerCase() }),
    };
  });
}

function hostFits(host: string, e: Entry): boolean {
  return e.wildcard ? host.endsWith(`.${e.host}`) : host === e.host;
}

/** Whether a link to host and path is on the allowlist. host is lower case, as URL gives it. */
export function hostAllowed(
  hosts: LinkHosts,
  host: string,
  path: string,
): boolean {
  const p = path.toLowerCase();
  return entries(hosts).some(
    (e) =>
      hostFits(host, e) &&
      (e.path === undefined || p === e.path || p.startsWith(`${e.path}/`)),
  );
}

/** Whether the allowlist opens host only under some paths, as it does github.com. */
export function hostRestrictedToPaths(hosts: LinkHosts, host: string): boolean {
  return entries(hosts).some((e) => e.path !== undefined && hostFits(host, e));
}

/** The paths the allowlist opens on host, for messages. */
export function allowedPaths(hosts: LinkHosts, host: string): string[] {
  return entries(hosts)
    .filter((e) => e.path !== undefined && hostFits(host, e))
    .map((e) => e.path!);
}
