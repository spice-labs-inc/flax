import { execFileSync } from "node:child_process";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { mcpServersCheck } from "../src/check/mcp-servers.ts";
import { assetUrl, loadServerPins } from "../src/lib/mcp-servers.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import {
  extractFromTar,
  fetchServers,
} from "../src/tools-server/fetch-servers.ts";
import { makeRepo, run } from "./helpers.ts";

const FILE = "mcp-servers.yml";
const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

function asset(name: string, sha256: string, binary?: string) {
  return { asset: name, sha256, ...(binary === undefined ? {} : { binary }) };
}

function pins(overrides: Record<string, unknown> = {}) {
  return {
    "kubernetes-mcp-server": {
      repository: "containers/kubernetes-mcp-server",
      version: "0.0.67",
      platforms: {
        "linux-amd64": asset(
          "kubernetes-mcp-server-linux-amd64",
          "a".repeat(64),
        ),
        "linux-arm64": asset(
          "kubernetes-mcp-server-linux-arm64",
          "b".repeat(64),
        ),
      },
    },
    "github-mcp-server": {
      repository: "github/github-mcp-server",
      version: "1.12.2",
      platforms: {
        "linux-amd64": asset(
          "github-mcp-server_Linux_x86_64.tar.gz",
          "c".repeat(64),
          "github-mcp-server",
        ),
        "linux-arm64": asset(
          "github-mcp-server_Linux_arm64.tar.gz",
          "d".repeat(64),
          "github-mcp-server",
        ),
      },
    },
    ...overrides,
  };
}

describe("mcp-servers.yml", () => {
  it("accepts this repository's pins", async () => {
    expect(await run(mcpServersCheck, makeRepo())).toEqual([]);
    const { pins: loaded } = loadServerPins(FIXTURE_WORKSPACE);
    expect(loaded?.["kubernetes-mcp-server"].version).toBe("0.0.67");
    expect(loaded?.["github-mcp-server"].version).toBe("1.12.2");
  });

  it("is required", async () => {
    expect(await run(mcpServersCheck, makeRepo({ mcpServers: null }))).toEqual([
      `${FILE}: is missing`,
    ]);
  });

  it.each([
    ["latest", "must match ^\\d+\\.\\d+\\.\\d+$"],
    ["v0.0.67", "must match ^\\d+\\.\\d+\\.\\d+$"],
    ["^0.0.67", "must match ^\\d+\\.\\d+\\.\\d+$"],
  ])("refuses the version %s", async (version, message) => {
    const p = pins();
    p["kubernetes-mcp-server"].version = version;
    expect(
      await run(mcpServersCheck, makeRepo({ mcpServers: stringify(p) })),
    ).toEqual([
      `${FILE}: kubernetes-mcp-server.version: "${version}" ${message}`,
    ]);
  });

  it("refuses a checksum that is not a sha256, or is the placeholder", async () => {
    const p = pins();
    p["github-mcp-server"].platforms["linux-arm64"].sha256 = "abc";
    expect(
      await run(mcpServersCheck, makeRepo({ mcpServers: stringify(p) })),
    ).toEqual([
      `${FILE}: github-mcp-server.platforms.linux-arm64.sha256: "abc" must match ^[0-9a-f]{64}$`,
    ]);
    const zeros = pins();
    zeros["github-mcp-server"].platforms["linux-arm64"].sha256 = "0".repeat(64);
    expect(
      await run(mcpServersCheck, makeRepo({ mcpServers: stringify(zeros) })),
    ).toEqual([
      `${FILE}: github-mcp-server.platforms.linux-arm64.sha256: is the all-zeros placeholder`,
    ]);
  });

  it("needs the binary's path for an archive, and only for an archive", async () => {
    const p = pins();
    delete (
      p["github-mcp-server"].platforms["linux-amd64"] as { binary?: string }
    ).binary;
    (
      p["kubernetes-mcp-server"].platforms["linux-arm64"] as { binary?: string }
    ).binary = "x";
    expect(
      await run(mcpServersCheck, makeRepo({ mcpServers: stringify(p) })),
    ).toEqual([
      `${FILE}: kubernetes-mcp-server.platforms.linux-arm64.binary: applies only to a .tar.gz asset`,
      `${FILE}: github-mcp-server.platforms.linux-amd64.binary: is required for a .tar.gz asset: the binary's path inside it`,
    ]);
  });

  it("refuses a missing platform, an unknown server and unknown keys", async () => {
    const p = pins({ "slack-mcp-server": {} });
    delete (p["kubernetes-mcp-server"].platforms as Record<string, unknown>)[
      "linux-arm64"
    ];
    (p["github-mcp-server"] as Record<string, unknown>).url =
      "https://example.com/x";
    expect(
      await run(mcpServersCheck, makeRepo({ mcpServers: stringify(p) })),
    ).toEqual([
      `${FILE}: slack-mcp-server: is not an allowed key`,
      `${FILE}: kubernetes-mcp-server.platforms.linux-arm64: is required`,
      `${FILE}: github-mcp-server.url: is not an allowed key`,
    ]);
  });

  it("names the GitHub release download for each asset", () => {
    const p = pins();
    expect(
      assetUrl(
        p["github-mcp-server"],
        p["github-mcp-server"].platforms["linux-amd64"],
      ),
    ).toBe(
      "https://github.com/github/github-mcp-server/releases/download/v1.12.2/github-mcp-server_Linux_x86_64.tar.gz",
    );
  });
});

describe("fetchServers", () => {
  function setup() {
    const root = makeRepo({ mcpServers: null });
    const k8s = Buffer.from("#!/bin/sh\necho kubernetes\n");
    const src = join(root, "src-archive");
    mkdirSync(src);
    writeFileSync(join(src, "github-mcp-server"), "#!/bin/sh\necho github\n");
    writeFileSync(join(src, "README.md"), "readme");
    const tar = execFileSync("tar", [
      "-cf",
      "-",
      "-C",
      src,
      "README.md",
      "github-mcp-server",
    ]);
    const gz = gzipSync(tar);
    const p = pins();
    p["kubernetes-mcp-server"].platforms["linux-amd64"].sha256 = sha(k8s);
    p["github-mcp-server"].platforms["linux-amd64"].sha256 = sha(gz);
    writeFileSync(join(root, FILE), stringify(p));
    const served = new Map<string, Buffer>([
      ["kubernetes-mcp-server-linux-amd64", k8s],
      ["github-mcp-server_Linux_x86_64.tar.gz", gz],
    ]);
    const requested: string[] = [];
    const fetchFn = ((url: string) => {
      requested.push(url);
      const name = url.split("/").pop()!;
      const data = served.get(name);
      return Promise.resolve(
        data === undefined
          ? new Response("no", { status: 404 })
          : new Response(data),
      );
    }) as typeof fetch;
    return { root, served, requested, fetchFn };
  }

  it("downloads each pinned binary, checks its sha256, unpacks archives and leaves them executable", async () => {
    const { root, requested, fetchFn } = setup();
    const dir = join(root, "bin");
    const paths = await fetchServers({
      root,
      dir,
      platform: "linux-amd64",
      fetch: fetchFn,
    });
    expect(requested).toEqual([
      "https://github.com/containers/kubernetes-mcp-server/releases/download/v0.0.67/kubernetes-mcp-server-linux-amd64",
      "https://github.com/github/github-mcp-server/releases/download/v1.12.2/github-mcp-server_Linux_x86_64.tar.gz",
    ]);
    expect(readFileSync(paths["kubernetes-mcp-server"], "utf8")).toBe(
      "#!/bin/sh\necho kubernetes\n",
    );
    expect(readFileSync(paths["github-mcp-server"], "utf8")).toBe(
      "#!/bin/sh\necho github\n",
    );
    for (const path of Object.values(paths))
      expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  it("writes nothing for a download whose sha256 differs from the pin", async () => {
    const { root, served, fetchFn } = setup();
    served.set("kubernetes-mcp-server-linux-amd64", Buffer.from("tampered"));
    const dir = join(root, "bin");
    await expect(
      fetchServers({ root, dir, platform: "linux-amd64", fetch: fetchFn }),
    ).rejects.toThrow(
      `kubernetes-mcp-server-linux-amd64 has sha256 ${sha("tampered")}, but mcp-servers.yml pins`,
    );
    expect(existsSync(join(dir, "kubernetes-mcp-server"))).toBe(false);
    expect(existsSync(join(dir, "kubernetes-mcp-server.partial"))).toBe(false);
  });

  it("refuses to fetch from pins that do not pass their check", async () => {
    const root = makeRepo({ mcpServers: "kubernetes-mcp-server: {}\n" });
    await expect(
      fetchServers({ root, dir: join(root, "bin"), platform: "linux-amd64" }),
    ).rejects.toThrow(
      "mcp-servers.yml: kubernetes-mcp-server.repository: is required",
    );
  });

  it("extracts one regular file from a tar archive and refuses a missing one", () => {
    const { root } = setup();
    const tar = execFileSync("tar", [
      "-cf",
      "-",
      "-C",
      join(root, "src-archive"),
      ".",
    ]);
    expect(extractFromTar(tar, "github-mcp-server").toString()).toBe(
      "#!/bin/sh\necho github\n",
    );
    expect(() => extractFromTar(tar, "nope")).toThrow(
      "the archive holds no file nope",
    );
  });
});
