import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DOCKERFILE, KIT_ROOT } from "../lib/paths.ts";
import { problem, type Problem } from "../lib/problem.ts";
import {
  PI_EXTENSIONS_PREFIX,
  PI_MAILBOX_EXTENSION,
  piCommand,
} from "../run-job/argv.ts";
import type { Check } from "./types.ts";

export interface Pin {
  /** The build argument holding the pinned value. */
  arg: string;
  kind: "version" | "sha256";
  /** The npm package installed at this version; every mention of it must carry the pin. */
  pkg?: string;
  /** The line declaring the package name itself (the provider's ARG), which names it without a pin. */
  declaredOn?: number;
}

export const AGENT_IMAGE_PINS: readonly Pin[] = [
  { arg: "NODE_VERSION", kind: "version" },
  { arg: "NODE_SHA256_AMD64", kind: "sha256" },
  { arg: "NODE_SHA256_ARM64", kind: "sha256" },
  {
    arg: "PI_VERSION",
    kind: "version",
    pkg: "@earendil-works/pi-coding-agent",
  },
  { arg: "PI_MCP_MAILBOX_VERSION", kind: "version" },
];

/**
 * The Pi provider plugin, an npm package the build installs under
 * PI_EXTENSIONS_PREFIX when PI_PROVIDER_PACKAGE names one. Both arguments
 * empty means no plugin; set, the version is an exact pin like the others.
 */
export const PI_PROVIDER_PACKAGE_ARG = "PI_PROVIDER_PACKAGE";
export const PI_PROVIDER_VERSION_ARG = "PI_PROVIDER_VERSION";

/** The user the sandbox's entrypoint remaps to the host user; its uid in the image. */
export const BOX_USER = "agent";
export const BOX_UID = 1000;
/** The sandbox's variables are LBX_*; this one tells the entrypoint which runtime the box runs under. */
export const LBX_RUNTIME_TYPE_LINE = "ENV LBX_RUNTIME_TYPE=docker";
/** The prefix of the labels that record what the image holds (the Publish image workflow reads them). */
export const AGENT_IMAGE_LABEL_PREFIX = "io.flax.agent-image.";

/** One version and nothing else: no tag, range, wildcard or leading v. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** An npm package name, scoped or not. */
export const NPM_PACKAGE_NAME =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const KIND = {
  version: { pattern: EXACT_VERSION, shape: "an exact version like 1.2.3" },
  sha256: {
    pattern: SHA256,
    shape: "a sha256 checksum (64 lowercase hex digits)",
  },
} as const;

export interface DockerArg {
  name: string;
  /** The default value, without surrounding quotes; undefined when there is none. */
  value?: string;
  /** 1-based line number. */
  line: number;
}

interface Line {
  n: number;
  text: string;
}

/** The lines that are not comments or blank; a comment cannot change what the build does. */
function instructionLines(text: string): Line[] {
  return text
    .split("\n")
    .map((t, i) => ({ n: i + 1, text: t }))
    .filter(({ text: t }) => t.trim() !== "" && !t.trimStart().startsWith("#"));
}

const ARG_LINE = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/i;

function unquote(value: string): string {
  const v = value.trim();
  const q = v[0];
  return (q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)
    ? v.slice(1, -1)
    : v;
}

export function parseArgs(text: string): DockerArg[] {
  const args: DockerArg[] = [];
  for (const { n, text: t } of instructionLines(text)) {
    const m = ARG_LINE.exec(t);
    if (m === null) continue;
    const [, name, value] = m;
    if (name === undefined) continue;
    args.push(
      value === undefined
        ? { name, line: n }
        : { name, value: unquote(value), line: n },
    );
  }
  return args;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** `${ARG}` or `$ARG`, as a regular expression source. */
function argRef(arg: string): string {
  return `(?:\\$\\{${arg}\\}|\\$${arg}(?![A-Za-z0-9_]))`;
}

function usesArg(line: string, arg: string): boolean {
  return new RegExp(argRef(arg)).test(line);
}

/** The flags the job runner passes to Pi, with tools and without, which the build must find in `pi --help`. */
export function runnerPiFlags(): string[] {
  return [
    ...new Set(
      [
        ...piCommand("model", "high"),
        ...piCommand("model", "high", ["tool"]),
        ...piCommand("model", "high", [], { session: "s.jsonl" }),
      ].filter((a) => a.startsWith("--")),
    ),
  ];
}

const FLAG_LOOP = /\bfor flag in ([^;]*);\s*do\b/;

/**
 * The one declaration of a build argument, or the problem with it: none,
 * or more than one.
 */
function declaration(
  args: readonly DockerArg[],
  arg: string,
  shape: string,
): { arg: DockerArg } | { problem: Problem } {
  const declared = args.filter((a) => a.name === arg);
  const first = declared[0];
  if (first === undefined)
    return {
      problem: problem(AGENT_DOCKERFILE, `is not declared; ${shape}`, arg),
    };
  if (declared.length > 1)
    return {
      problem: problem(
        AGENT_DOCKERFILE,
        `is declared on lines ${declared.map((a) => a.line).join(", ")}; declare it once`,
        arg,
      ),
    };
  return { arg: first };
}

function unusedProblem(
  lines: readonly Line[],
  declared: DockerArg,
): Problem | undefined {
  const uses = lines.filter(
    (l) => l.n !== declared.line && usesArg(l.text, declared.name),
  );
  return uses.length === 0
    ? problem(
        AGENT_DOCKERFILE,
        "is never used, so the build does not install from it",
        declared.name,
      )
    : undefined;
}

/** Every mention of an npm package must carry `@${arg}`, the pinned version. */
function unpinnedMentions(
  lines: readonly Line[],
  pkg: string,
  arg: string,
  except?: number,
): Problem[] {
  const mention = new RegExp(`(?<![\\w.@/-])${escape(pkg)}(?![\\w./-])`, "g");
  const pinned = new RegExp(`^@${argRef(arg)}`);
  const problems: Problem[] = [];
  for (const { n, text: t } of lines) {
    if (n === except) continue;
    for (const m of t.matchAll(mention)) {
      if (!pinned.test(t.slice(m.index + m[0].length))) {
        problems.push(
          problem(
            AGENT_DOCKERFILE,
            `line ${n} names ${pkg} without the pinned version @\${${arg}}`,
            arg,
          ),
        );
      }
    }
  }
  return problems;
}

/**
 * The Pi provider plugin the Dockerfile's defaults name: both arguments
 * empty is no plugin. Only the declarations are read here; the install
 * lines are checked by agentImageProblems.
 */
export function providerPlugin(
  text: string,
): { package: string; version: string } | undefined {
  const args = parseArgs(text);
  const pkg = args.find((a) => a.name === PI_PROVIDER_PACKAGE_ARG)?.value;
  const version = args.find((a) => a.name === PI_PROVIDER_VERSION_ARG)?.value;
  return pkg === undefined || pkg === "" || version === undefined
    ? undefined
    : { package: pkg, version };
}

export function agentImageProblems(text: string): Problem[] {
  const file = AGENT_DOCKERFILE;
  const problems: Problem[] = [];
  const args = parseArgs(text);
  const lines = instructionLines(text);

  // The provider plugin: the package argument may be empty (no plugin);
  // named, its version becomes one more exact pin below.
  const pins: Pin[] = [...AGENT_IMAGE_PINS];
  const packageArg = declaration(
    args,
    PI_PROVIDER_PACKAGE_ARG,
    "name the Pi provider plugin's npm package, or declare it empty for none",
  );
  let providerPackage = "";
  if ("problem" in packageArg) {
    problems.push(packageArg.problem);
  } else {
    providerPackage = packageArg.arg.value ?? "";
    if (providerPackage !== "" && !NPM_PACKAGE_NAME.test(providerPackage)) {
      problems.push(
        problem(
          file,
          `"${providerPackage}" is not an npm package name`,
          PI_PROVIDER_PACKAGE_ARG,
        ),
      );
    }
    const unused = unusedProblem(lines, packageArg.arg);
    if (unused !== undefined) problems.push(unused);
  }
  if (providerPackage !== "" && "arg" in packageArg) {
    pins.push({
      arg: PI_PROVIDER_VERSION_ARG,
      kind: "version",
      pkg: providerPackage,
      declaredOn: packageArg.arg.line,
    });
  } else {
    const versionArg = declaration(
      args,
      PI_PROVIDER_VERSION_ARG,
      "declare it empty while PI_PROVIDER_PACKAGE is empty",
    );
    if ("problem" in versionArg) {
      problems.push(versionArg.problem);
    } else {
      const version = versionArg.arg.value ?? "";
      if (version !== "") {
        problems.push(
          problem(
            file,
            `is "${version}", but ${PI_PROVIDER_PACKAGE_ARG} is empty; name the package or clear both`,
            PI_PROVIDER_VERSION_ARG,
          ),
        );
      }
      const unused = unusedProblem(lines, versionArg.arg);
      if (unused !== undefined) problems.push(unused);
    }
  }

  for (const pin of pins) {
    const kind = KIND[pin.kind];
    const declared = declaration(args, pin.arg, `pin ${kind.shape}`);
    if ("problem" in declared) {
      problems.push(declared.problem);
      continue;
    }
    const first = declared.arg;
    if (first.value === undefined || first.value === "") {
      problems.push(problem(file, `has no value; pin ${kind.shape}`, pin.arg));
    } else if (!kind.pattern.test(first.value)) {
      problems.push(
        problem(file, `"${first.value}" is not ${kind.shape}`, pin.arg),
      );
    }
    const unused = unusedProblem(lines, first);
    if (unused !== undefined) problems.push(unused);
    if (pin.pkg !== undefined)
      problems.push(
        ...unpinnedMentions(lines, pin.pkg, pin.arg, pin.declaredOn),
      );
  }

  // The provider package is installed by reference to its argument, so a
  // `$PI_PROVIDER_PACKAGE@...` must carry `@${PI_PROVIDER_VERSION}` too.
  const packageAt = new RegExp(`${argRef(PI_PROVIDER_PACKAGE_ARG)}@`, "g");
  const versionAfterAt = new RegExp(`^@${argRef(PI_PROVIDER_VERSION_ARG)}`);
  for (const { n, text: t } of lines) {
    for (const m of t.matchAll(packageAt)) {
      if (!versionAfterAt.test(t.slice(m.index + m[0].length - 1))) {
        problems.push(
          problem(
            file,
            `line ${n} installs \${${PI_PROVIDER_PACKAGE_ARG}} without the pinned version @\${${PI_PROVIDER_VERSION_ARG}}`,
            PI_PROVIDER_VERSION_ARG,
          ),
        );
      }
    }
  }

  const loop = lines.map((l) => FLAG_LOOP.exec(l.text)).find((m) => m !== null);
  if (loop?.[1] === undefined) {
    problems.push(
      problem(
        file,
        "has no `for flag in ...; do` check of `pi --help`; the build must check every flag the job runner passes to Pi",
      ),
    );
  } else {
    const checked = new Set(loop[1].trim().split(/\s+/));
    for (const flag of runnerPiFlags()) {
      if (!checked.has(flag)) {
        problems.push(
          problem(
            file,
            `the pi --help check does not cover ${flag}, which the job runner passes to Pi`,
          ),
        );
      }
    }
  }

  const providerDir = `${PI_EXTENSIONS_PREFIX}/node_modules/`;
  const intoPrefix = new RegExp(
    `--prefix ${escape(PI_EXTENSIONS_PREFIX)}(?![\\w./-]).*${argRef(PI_PROVIDER_PACKAGE_ARG)}@${argRef(PI_PROVIDER_VERSION_ARG)}`,
  );
  if (!lines.some((l) => intoPrefix.test(l.text))) {
    problems.push(
      problem(
        file,
        `does not install \${${PI_PROVIDER_PACKAGE_ARG}}@\${${PI_PROVIDER_VERSION_ARG}} with --prefix ${PI_EXTENSIONS_PREFIX} on one line, where the job runner loads a provider plugin from`,
      ),
    );
  }
  const ownedByRoot = new RegExp(
    `stat -c %U "?${escape(providerDir)}${argRef(PI_PROVIDER_PACKAGE_ARG)}"?.*\\broot\\b`,
  );
  if (!lines.some((l) => ownedByRoot.test(l.text))) {
    problems.push(
      problem(
        file,
        `does not check that ${providerDir}\${${PI_PROVIDER_PACKAGE_ARG}} is owned by root, so the box user could change the provider plugin`,
      ),
    );
  }
  const copyToMailbox = new RegExp(
    `^\\s*COPY\\s+(?:--\\S+\\s+)*pi-mcp-mailbox\\.mjs\\s+${escape(PI_MAILBOX_EXTENSION)}\\s*$`,
    "i",
  );
  if (!lines.some((l) => copyToMailbox.test(l.text))) {
    problems.push(
      problem(
        file,
        `does not COPY pi-mcp-mailbox.mjs to ${PI_MAILBOX_EXTENSION}, where the job runner loads the Pi plugin from`,
      ),
    );
  }

  // The sandbox's run box contract: its entrypoint remaps the agent user,
  // reads LBX_* variables and is the image's entrypoint.
  const boxUser = new RegExp(
    `\\buseradd\\b.*\\s-u\\s+${BOX_UID}\\b.*\\s${BOX_USER}\\s*\\\\?$`,
  );
  if (!lines.some((l) => boxUser.test(l.text))) {
    problems.push(
      problem(
        file,
        `does not create the box user ${BOX_USER} at uid ${BOX_UID} with useradd, which the sandbox's entrypoint remaps to the host user`,
      ),
    );
  }
  if (!lines.some((l) => l.text.trim() === LBX_RUNTIME_TYPE_LINE)) {
    problems.push(
      problem(
        file,
        `has no \`${LBX_RUNTIME_TYPE_LINE}\` line, which the sandbox's entrypoint reads`,
      ),
    );
  }
  const copyEntrypoint = /^\s*COPY\s+(?:--\S+\s+)*entrypoint\.sh\s+\/entrypoint\.sh\s*$/i;
  const entrypoint = /^\s*ENTRYPOINT\s+\["\/entrypoint\.sh"\]\s*$/i;
  if (
    !lines.some((l) => copyEntrypoint.test(l.text)) ||
    !lines.some((l) => entrypoint.test(l.text))
  ) {
    problems.push(
      problem(
        file,
        'does not COPY entrypoint.sh to /entrypoint.sh and run it as ENTRYPOINT ["/entrypoint.sh"]; the sandbox release\'s entrypoint is the run box contract',
      ),
    );
  }
  const commitLabel = new RegExp(
    `${escape(AGENT_IMAGE_LABEL_PREFIX)}box-commit="?${argRef("BOX_COMMIT")}"?(?![\\w])`,
  );
  if (!lines.some((l) => commitLabel.test(l.text))) {
    problems.push(
      problem(
        file,
        `does not label the image ${AGENT_IMAGE_LABEL_PREFIX}box-commit="\${BOX_COMMIT}", which the Publish image workflow reads`,
      ),
    );
  }
  return problems;
}

/** The agent image installs exact, checked versions of Node, Pi and the plugins, on the sandbox's run box contract. */
export const agentImageCheck: Check = {
  id: "agent-image",
  title: `${AGENT_DOCKERFILE} pins exact versions`,
  run(repo) {
    // The Dockerfile is the kit's, not the workspace's: the image is built from the package.
    const path = join(KIT_ROOT, AGENT_DOCKERFILE);
    if (!existsSync(path)) return [problem(AGENT_DOCKERFILE, "is missing")];
    return agentImageProblems(readFileSync(path, "utf8"));
  },
};
