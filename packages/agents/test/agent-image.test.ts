import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  agentImageCheck,
  agentImageProblems,
  AGENT_IMAGE_LABEL_PREFIX,
  AGENT_IMAGE_PINS,
  BOX_UID,
  BOX_USER,
  LBX_RUNTIME_TYPE_LINE,
  parseArgs,
  PI_PROVIDER_PACKAGE_ARG,
  PI_PROVIDER_VERSION_ARG,
  providerPlugin,
  runnerPiFlags,
} from "../src/check/agent-image.ts";
import { CLIENT_VERSION } from "../images/agent/pi-mcp-mailbox/src/extension.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import {
  PI_EXTENSIONS_PREFIX,
  PI_MAILBOX_EXTENSION,
} from "../src/run-job/argv.ts";
import { formatted, AGENT_DOCKERFILE_TEXT, makeRepo, run } from "./helpers.ts";

const FILE = "images/agent/Dockerfile";
const PROVIDER_DIR = `${PI_EXTENSIONS_PREFIX}/node_modules/`;

/** The shipped Dockerfile with one exact piece of text replaced. */
function edited(from: string, to: string, text = AGENT_DOCKERFILE_TEXT): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

function withArg(name: string, value: string, text = AGENT_DOCKERFILE_TEXT): string {
  const line = text.split("\n").find((l) => l.startsWith(`ARG ${name}=`));
  if (line === undefined) throw new Error(`no ARG ${name} line`);
  return edited(line, `ARG ${name}=${value}`, text);
}

/** The shipped Dockerfile with a provider plugin named by default. */
function withProvider(pkg: string, version: string): string {
  return withArg(
    PI_PROVIDER_VERSION_ARG,
    version,
    withArg(PI_PROVIDER_PACKAGE_ARG, pkg),
  );
}

function problemsOf(text: string): string[] {
  return formatted(agentImageProblems(text));
}

describe("the agent image Dockerfile", () => {
  it("passes as shipped", async () => {
    expect(await run(agentImageCheck, makeRepo())).toEqual([]);
  });

  it("declares every pin once, with a value", () => {
    const args = parseArgs(AGENT_DOCKERFILE_TEXT);
    for (const pin of AGENT_IMAGE_PINS) {
      const declared = args.filter((a) => a.name === pin.arg);
      expect(declared).toHaveLength(1);
      expect(declared[0]?.value).toBeTruthy();
    }
  });

  it("reads the kit's Dockerfile, not the workspace's", async () => {
    expect(await run(agentImageCheck, makeRepo({ dockerfile: null }))).toEqual(
      [],
    );
    expect(
      await run(agentImageCheck, makeRepo({ dockerfile: "FROM scratch\n" })),
    ).toEqual([]);
  });

  it.each([
    "latest",
    "^0.87.1",
    "~1.5.1",
    ">=24.0.0",
    "0.87",
    "24",
    "v24.21.0",
    "1.x",
    "*",
    "0.87.1 || 0.88.0",
  ])("rejects the version %s", (value) => {
    expect(problemsOf(withArg("PI_VERSION", value))).toEqual([
      `${FILE}: PI_VERSION: "${value}" is not an exact version like 1.2.3`,
    ]);
  });

  it("accepts any exact version, quoted or not", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.constantFrom("", "-rc.1", "-beta"),
        fc.boolean(),
        (major, minor, patch, pre, quoted) => {
          const v = `${major}.${minor}.${patch}${pre}`;
          const text = withArg("NODE_VERSION", quoted ? `"${v}"` : v);
          return problemsOf(text).length === 0;
        },
      ),
    );
  });

  it("rejects a version with a range or tag around it", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.constantFrom("^", "~", ">=", "<", "=", "v", ""),
        fc.constantFrom("", ".x", " - 9.9.9", " || 9.9.9", "-", "+build"),
        (major, minor, patch, before, after) => {
          fc.pre(before !== "" || after !== "");
          const v = `${before}${major}.${minor}.${patch}${after}`;
          return problemsOf(withArg("PI_VERSION", v)).length === 1;
        },
      ),
    );
  });

  it("rejects a checksum that is not sha256 hex", () => {
    expect(problemsOf(withArg("NODE_SHA256_AMD64", "ABC123"))).toEqual([
      `${FILE}: NODE_SHA256_AMD64: "ABC123" is not a sha256 checksum (64 lowercase hex digits)`,
    ]);
  });

  it("rejects a pin without a value or declaration", () => {
    expect(problemsOf(withArg("NODE_VERSION", ""))).toEqual([
      `${FILE}: NODE_VERSION: has no value; pin an exact version like 1.2.3`,
    ]);
    expect(
      problemsOf(edited("ARG PI_VERSION=", "ARG PI_VERSION_OLD=")),
    ).toEqual([
      `${FILE}: PI_VERSION: is not declared; pin an exact version like 1.2.3`,
    ]);
  });

  it("rejects a pin declared twice", () => {
    const text = edited(
      "ARG BOX_COMMIT\n",
      "ARG BOX_COMMIT\nARG PI_VERSION=0.87.1\n",
    );
    expect(problemsOf(text)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${FILE}: PI_VERSION: is declared on lines \\d+, \\d+; declare it once$`,
        ),
      ),
    ]);
  });

  it("rejects a pin the build never uses", () => {
    const text = edited('node_sha="$NODE_SHA256_ARM64"', "node_sha=0000");
    expect(problemsOf(text)).toEqual([
      `${FILE}: NODE_SHA256_ARM64: is never used, so the build does not install from it`,
    ]);
  });

  it("rejects a package installed without its pin", () => {
    const pi = edited(
      '"@earendil-works/pi-coding-agent@${PI_VERSION}"',
      '"@earendil-works/pi-coding-agent@latest" "${PI_VERSION}"',
    );
    expect(problemsOf(pi)).toEqual([
      expect.stringMatching(
        /: PI_VERSION: line \d+ names @earendil-works\/pi-coding-agent without the pinned version @\$\{PI_VERSION\}$/,
      ),
    ]);
  });

  it("ignores packages named in comments", () => {
    const text = `# pi install npm:@earendil-works/pi-coding-agent@latest\n${AGENT_DOCKERFILE_TEXT}`;
    expect(problemsOf(text)).toEqual([]);
  });

  describe("the provider plugin", () => {
    it("ships without one: both arguments empty", () => {
      expect(providerPlugin(AGENT_DOCKERFILE_TEXT)).toBeUndefined();
      const args = parseArgs(AGENT_DOCKERFILE_TEXT);
      for (const name of [PI_PROVIDER_PACKAGE_ARG, PI_PROVIDER_VERSION_ARG]) {
        const declared = args.filter((a) => a.name === name);
        expect(declared).toHaveLength(1);
        expect(declared[0]?.value).toBe("");
      }
    });

    it("accepts a package with an exact version", () => {
      const text = withProvider("pi-provider-example", "1.5.1");
      expect(providerPlugin(text)).toEqual({
        package: "pi-provider-example",
        version: "1.5.1",
      });
      expect(problemsOf(text)).toEqual([]);
      expect(problemsOf(withProvider("@scope/pi-provider", "2.0.0"))).toEqual(
        [],
      );
    });

    it("rejects a package without a version, and a version without a package", () => {
      expect(problemsOf(withArg(PI_PROVIDER_PACKAGE_ARG, "pi-provider-example"))).toEqual([
        `${FILE}: ${PI_PROVIDER_VERSION_ARG}: has no value; pin an exact version like 1.2.3`,
      ]);
      expect(problemsOf(withArg(PI_PROVIDER_VERSION_ARG, "1.5.1"))).toEqual([
        `${FILE}: ${PI_PROVIDER_VERSION_ARG}: is "1.5.1", but ${PI_PROVIDER_PACKAGE_ARG} is empty; name the package or clear both`,
      ]);
    });

    it("rejects a package name that is not an npm name, and a version that is not exact", () => {
      expect(problemsOf(withProvider("Not A Package", "1.5.1"))).toEqual([
        `${FILE}: ${PI_PROVIDER_PACKAGE_ARG}: "Not A Package" is not an npm package name`,
      ]);
      expect(problemsOf(withProvider("pi-provider-example", "^1.5.1"))).toEqual([
        `${FILE}: ${PI_PROVIDER_VERSION_ARG}: "^1.5.1" is not an exact version like 1.2.3`,
      ]);
      fc.assert(
        fc.property(
          fc.nat(),
          fc.nat(),
          fc.nat(),
          fc.constantFrom("^", "~", ">=", "<", "=", "v", ""),
          fc.constantFrom("", ".x", " - 9.9.9", " || 9.9.9", "-", "+build"),
          (major, minor, patch, before, after) => {
            fc.pre(before !== "" || after !== "");
            const v = `${before}${major}.${minor}.${patch}${after}`;
            return problemsOf(withProvider("pi-provider-example", v)).length === 1;
          },
        ),
      );
    });

    it("rejects either argument undeclared", () => {
      expect(
        problemsOf(
          edited(`ARG ${PI_PROVIDER_PACKAGE_ARG}=`, "ARG PI_PROVIDER_PACKAGE_OLD="),
        ),
      ).toEqual([
        `${FILE}: ${PI_PROVIDER_PACKAGE_ARG}: is not declared; name the Pi provider plugin's npm package, or declare it empty for none`,
      ]);
      expect(
        problemsOf(
          edited(`ARG ${PI_PROVIDER_VERSION_ARG}=`, "ARG PI_PROVIDER_VERSION_OLD="),
        ),
      ).toEqual([
        `${FILE}: ${PI_PROVIDER_VERSION_ARG}: is not declared; declare it empty while ${PI_PROVIDER_PACKAGE_ARG} is empty`,
      ]);
    });

    it("rejects a named package mentioned without its pin", () => {
      const text = `${withProvider("pi-provider-example", "1.5.1")}RUN pi install npm:pi-provider-example\n`;
      expect(problemsOf(text)).toEqual([
        expect.stringMatching(
          /: PI_PROVIDER_VERSION: line \d+ names pi-provider-example without the pinned version @\$\{PI_PROVIDER_VERSION\}$/,
        ),
      ]);
    });

    it("rejects the package argument installed without the version argument", () => {
      const text = edited(
        '"${PI_PROVIDER_PACKAGE}@${PI_PROVIDER_VERSION}"',
        '"${PI_PROVIDER_PACKAGE}@latest"',
      );
      expect(problemsOf(text)).toEqual([
        expect.stringMatching(
          /: PI_PROVIDER_VERSION: line \d+ installs \$\{PI_PROVIDER_PACKAGE\} without the pinned version @\$\{PI_PROVIDER_VERSION\}$/,
        ),
        `${FILE}: does not install \${PI_PROVIDER_PACKAGE}@\${PI_PROVIDER_VERSION} with --prefix ${PI_EXTENSIONS_PREFIX} on one line, where the job runner loads a provider plugin from`,
      ]);
    });

    it("installs it where the job runner loads it from", () => {
      const missing = `${FILE}: does not install \${PI_PROVIDER_PACKAGE}@\${PI_PROVIDER_VERSION} with --prefix ${PI_EXTENSIONS_PREFIX} on one line, where the job runner loads a provider plugin from`;
      expect(
        problemsOf(
          edited(`--prefix ${PI_EXTENSIONS_PREFIX} `, "--prefix /opt/other "),
        ),
      ).toEqual([missing]);
      expect(
        problemsOf(
          edited(`--prefix ${PI_EXTENSIONS_PREFIX} `, `--prefix ${PI_EXTENSIONS_PREFIX}2 `),
        ),
      ).toEqual([missing]);
      const commented = edited(
        "        NPM_CONFIG_CACHE=/root/.npm npm install --no-fund",
        "#        NPM_CONFIG_CACHE=/root/.npm npm install --no-fund",
      );
      expect(problemsOf(commented)).toEqual([missing]);
    });

    it("checks the installed plugin is owned by root", () => {
      const missing = `${FILE}: does not check that ${PROVIDER_DIR}\${PI_PROVIDER_PACKAGE} is owned by root, so the box user could change the provider plugin`;
      const check = `&& [ "$(stat -c %U "${PROVIDER_DIR}\${PI_PROVIDER_PACKAGE}")" = root ]; \\`;
      expect(problemsOf(edited(check, "; \\"))).toEqual([missing]);
      expect(problemsOf(edited(check, check.replace("root", "agent")))).toEqual([
        missing,
      ]);
    });
  });

  it("checks every flag the job runner passes to Pi", () => {
    expect(runnerPiFlags()).toEqual([
      "--print",
      "--mode",
      "--offline",
      "--no-extensions",
      "--extension",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--session-dir",
      "--model",
      "--thinking",
      "--tools",
      "--session",
    ]);
    expect(problemsOf(edited(" --tools --session;", " --tools;"))).toEqual([
      `${FILE}: the pi --help check does not cover --session, which the job runner passes to Pi`,
    ]);
    expect(problemsOf(edited(" --thinking --tools ", " --thinking "))).toEqual([
      `${FILE}: the pi --help check does not cover --tools, which the job runner passes to Pi`,
    ]);
    expect(problemsOf(edited(" --model --thinking ", " --model "))).toEqual([
      `${FILE}: the pi --help check does not cover --thinking, which the job runner passes to Pi`,
    ]);
    expect(problemsOf(edited("for flag in", "for option in"))).toEqual([
      `${FILE}: has no \`for flag in ...; do\` check of \`pi --help\`; the build must check every flag the job runner passes to Pi`,
    ]);
  });

  it("copies the Pi plugin bundle where the job runner loads it from", () => {
    expect(PI_MAILBOX_EXTENSION).toBe("/opt/pi-extensions/pi-mcp-mailbox.mjs");
    const missing = `${FILE}: does not COPY pi-mcp-mailbox.mjs to ${PI_MAILBOX_EXTENSION}, where the job runner loads the Pi plugin from`;
    const copy =
      "COPY pi-mcp-mailbox.mjs /opt/pi-extensions/pi-mcp-mailbox.mjs";
    expect(
      problemsOf(
        edited(copy, "COPY pi-mcp-mailbox.mjs /opt/pi-extensions/other.mjs"),
      ),
    ).toEqual([missing]);
    expect(
      problemsOf(edited(copy, "COPY pi-mcp-mailbox.mjs /home/agent/p.mjs")),
    ).toEqual([missing]);
    expect(problemsOf(edited(copy, `# ${copy}`))).toEqual([missing]);
    expect(
      problemsOf(edited(copy, `COPY --chown=root:root ${copy.slice(5)}`)),
    ).toEqual([]);
  });

  it("pins the Pi plugin to the version its package and bundle report", () => {
    const pin = parseArgs(AGENT_DOCKERFILE_TEXT).find(
      (a) => a.name === "PI_MCP_MAILBOX_VERSION",
    );
    const pkg = JSON.parse(
      readFileSync(
        join(KIT_ROOT, "images/agent/pi-mcp-mailbox/package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(pin?.value).toBe(pkg.version);
    expect(CLIENT_VERSION).toBe(pkg.version);
    expect(problemsOf(withArg("PI_MCP_MAILBOX_VERSION", "latest"))).toEqual([
      `${FILE}: PI_MCP_MAILBOX_VERSION: "latest" is not an exact version like 1.2.3`,
    ]);
  });

  describe("the sandbox's run box contract", () => {
    it("creates the box user the entrypoint remaps", () => {
      expect(BOX_USER).toBe("agent");
      expect(BOX_UID).toBe(1000);
      const useradd = "useradd -m -u 1000 -g agent -s /bin/bash agent";
      const missing = `${FILE}: does not create the box user agent at uid 1000 with useradd, which the sandbox's entrypoint remaps to the host user`;
      expect(
        problemsOf(edited(useradd, "useradd -m -u 1001 -g agent -s /bin/bash agent")),
      ).toEqual([missing]);
      expect(
        problemsOf(edited(useradd, "useradd -m -u 1000 -g agent -s /bin/bash other")),
      ).toEqual([missing]);
      expect(AGENT_DOCKERFILE_TEXT).toContain("ENV HOME=/home/agent");
      expect(AGENT_DOCKERFILE_TEXT).toContain("chown agent:agent /data");
    });

    it("sets the runtime type with the sandbox's LBX_ variable", () => {
      expect(LBX_RUNTIME_TYPE_LINE).toBe("ENV LBX_RUNTIME_TYPE=docker");
      const missing = `${FILE}: has no \`${LBX_RUNTIME_TYPE_LINE}\` line, which the sandbox's entrypoint reads`;
      expect(
        problemsOf(edited(LBX_RUNTIME_TYPE_LINE, "ENV BOX_RUNTIME_TYPE=docker")),
      ).toEqual([missing]);
      expect(
        problemsOf(edited(LBX_RUNTIME_TYPE_LINE, "ENV LBX_RUNTIME_TYPE=sysbox")),
      ).toEqual([missing]);
      expect(
        problemsOf(edited(LBX_RUNTIME_TYPE_LINE, `# ${LBX_RUNTIME_TYPE_LINE}`)),
      ).toEqual([missing]);
    });

    it("runs the release's entrypoint", () => {
      const missing = `${FILE}: does not COPY entrypoint.sh to /entrypoint.sh and run it as ENTRYPOINT ["/entrypoint.sh"]; the sandbox release's entrypoint is the run box contract`;
      expect(
        problemsOf(edited('ENTRYPOINT ["/entrypoint.sh"]', 'ENTRYPOINT ["/bin/bash"]')),
      ).toEqual([missing]);
      expect(
        problemsOf(edited("COPY entrypoint.sh /entrypoint.sh", "COPY entrypoint.sh /usr/local/bin/entrypoint.sh")),
      ).toEqual([missing]);
    });

    it("labels the image under the kit's prefix with the release commit", () => {
      expect(AGENT_IMAGE_LABEL_PREFIX).toBe("io.flax.agent-image.");
      expect(AGENT_DOCKERFILE_TEXT).toContain(
        'org.opencontainers.image.source="https://github.com/spice-labs-inc/flax"',
      );
      expect(AGENT_DOCKERFILE_TEXT).toContain(
        'org.opencontainers.image.title="flax-agent"',
      );
      for (const label of [
        "box-commit",
        "node",
        "pi",
        "provider-plugin",
        "provider-plugin-version",
        "mcp-mailbox-plugin",
        "mcp-mailbox-plugin-sha256",
      ]) {
        expect(AGENT_DOCKERFILE_TEXT).toContain(`${AGENT_IMAGE_LABEL_PREFIX}${label}=`);
      }
      const label = 'io.flax.agent-image.box-commit="${BOX_COMMIT}"';
      expect(
        problemsOf(edited(label, 'io.flax.agent-image.box-commit="unknown"')),
      ).toEqual([
        `${FILE}: does not label the image io.flax.agent-image.box-commit="\${BOX_COMMIT}", which the Publish image workflow reads`,
      ]);
    });
  });
});
