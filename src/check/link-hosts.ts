import type { Check } from "./types.ts";

/** link-hosts.yml names the hosts a proposed change may link to. */
export const linkHostsCheck: Check = {
  id: "link-hosts",
  title: "link-hosts.yml lists the hosts a proposed change may link to",
  run: (repo) => repo.linkHostProblems,
};
