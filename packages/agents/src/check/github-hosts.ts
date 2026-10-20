import type { Check } from "./types.ts";

/** github-log-hosts.yml lists exact host names only. */
export const githubHostsCheck: Check = {
  id: "github-log-hosts",
  title: "github-log-hosts.yml lists exact GitHub log hosts",
  run: (repo) => repo.githubHostProblems,
};
