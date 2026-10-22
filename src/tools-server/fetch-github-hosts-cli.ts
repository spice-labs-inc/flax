import { workspaceRoot } from "../lib/workspace.ts";
import { GITHUB_HOSTS_FILE } from "../lib/paths.ts";
import { firstLine } from "../lib/problem.ts";
import { fetchGithubHosts } from "./fetch-github-hosts.ts";

try {
  const { fetched, hosts } = await fetchGithubHosts({ root: workspaceRoot() });
  console.log(
    `${GITHUB_HOSTS_FILE}: ${hosts.length} hosts, fetched ${fetched}`,
  );
} catch (err) {
  console.error(`fetch-github-hosts: ${firstLine(err)}`);
  process.exit(1);
}
