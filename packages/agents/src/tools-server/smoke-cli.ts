import { takeWorkspaceFlag, workspaceRoot } from "../lib/workspace.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllowlists } from "../lib/allowlists.ts";
import { loadServerPins } from "../lib/mcp-servers.ts";
import { fetchServers } from "./fetch-servers.ts";
import { formatSmoke, runSmoke } from "./smoke.ts";

takeWorkspaceFlag(process.argv.slice(2));
const root = workspaceRoot();
const scratch = process.env.RUNNER_TEMP ?? tmpdir();
const binDir = join(scratch, "mcp-servers");
const results = await runSmoke({
  env: process.env,
  binDir,
  workRoot: join(scratch, "tools-smoke"),
  readChannels: loadAllowlists(root).allowlists.readChannels,
  fetchBinaries: async () => {
    await fetchServers({ root, dir: binDir });
    const pins = loadServerPins(root).pins!;
    return `fetched with checksums checked: ${Object.entries(pins)
      .map(([name, pin]) => `${name} ${pin.version}`)
      .join(", ")}`;
  },
});
console.log(formatSmoke(results));
if (results.some((r) => !r.ok)) process.exit(1);
