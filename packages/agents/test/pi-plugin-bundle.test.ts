import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import type * as Extension from "../images/agent/pi-mcp-mailbox/src/extension.ts";
import type { JobConfig } from "../src/lib/job.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { bundlePiPlugin } from "../src/pi-plugin/bundle.ts";
import { startToolsServer } from "../src/tools-server/start.ts";
import { builtinUpstream } from "../src/tools-server/upstreams.ts";
import { jobConfig } from "./helpers.ts";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-bundle-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("the bundled Pi plugin", () => {
  it("is one file that imports only Node's own modules, the same bytes every time", async () => {
    const dir = scratch();
    const first = await bundlePiPlugin(KIT_ROOT, join(dir, "a.mjs"));
    const second = await bundlePiPlugin(KIT_ROOT, join(dir, "b.mjs"));
    expect(first.sha256).toBe(second.sha256);
    expect(first.version).toBe(
      JSON.parse(
        readFileSync(
          join(KIT_ROOT, "images/agent/pi-mcp-mailbox/package.json"),
          "utf8",
        ),
      ).version,
    );
    const text = readFileSync(first.path, "utf8");
    const imports = [
      ...text.matchAll(/^import\s.*?from\s+"([^"]+)";?$/gm),
      ...text.matchAll(/\bimport\("([^"]+)"\)/g),
    ].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier).toMatch(/^node:/);
  });

  it("loads with no node_modules around it and talks to the tools server over the tools socket", async () => {
    const dir = scratch();
    const bundle = await bundlePiPlugin(KIT_ROOT, join(dir, "plugin.mjs"));
    const plugin = (await import(
      pathToFileURL(bundle.path).href
    )) as typeof Extension;
    expect(typeof plugin.default).toBe("function");
    expect(plugin.CLIENT_VERSION).toBe(bundle.version);
    const socketPath = join(scratch(), "tools.sock");
    const tools = await startToolsServer({
      root: FIXTURE_WORKSPACE,
      dataDir: dir,
      socketPath,
      job: jobConfig("demo", { tools: ["echo"] }) as unknown as JobConfig,
      upstreams: { builtin: builtinUpstream },
    });
    onTestFinished(() => tools.stop());
    const registered: Extension.PiTool[] = [];
    const shutdown: (() => unknown)[] = [];
    const names = await plugin.connectTools(
      {
        registerTool: (tool) => registered.push(tool),
        on: (_event, handler) => shutdown.push(handler),
      },
      { socket: socketPath },
    );
    onTestFinished(async () => {
      for (const handler of shutdown) await handler();
    });
    expect(names).toEqual(["echo"]);
    const result = await registered[0]!.execute(
      "1",
      { text: "from the bundle, by socket" },
      undefined,
    );
    expect(result.content[0]!.text).toContain("\nfrom the bundle, by socket\n");
  });
});
