import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { KIT_ROOT } from "../src/lib/paths.ts";
import {
  createSocketDir,
  MAX_SOCKET_PATH_BYTES,
  runtimeDirs,
  SOCKET_DIR_PREFIX,
  socketDirBases,
  socketDirProblem,
  socketEntriesProblem,
  type SocketDirContext,
} from "../src/run-job/socket-dir.ts";

const UID = process.getuid!();

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-sd-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function context(root: string, extra: Partial<SocketDirContext> = {}) {
  const ctx: SocketDirContext = {
    who: { uid: UID, home: join(root, "home") },
    dataDir: join(root, "run", "data"),
    stateDir: join(root, "run", "state"),
    lbxDir: join(root, "run", "lbx"),
    cwd: join(root, "work"),
    runtimeDirs: [],
    ...extra,
  };
  for (const dir of [ctx.who.home, ctx.dataDir, ctx.stateDir, ctx.lbxDir])
    privateDir(dir);
  return ctx;
}

function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function listen(path: string): Promise<Server> {
  const server = createServer();
  onTestFinished(() => new Promise<void>((r) => server.close(() => r())));
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

describe("the socket directory rules (lbx --socket-dir)", () => {
  it("accept a private directory of the runner user outside every lbx directory", () => {
    const root = scratch();
    expect(socketDirProblem(privateDir(join(root, "s")), context(root))).toBe(
      undefined,
    );
  });

  it.each<[string, (root: string, ctx: SocketDirContext) => string, string]>([
    ["a relative path", () => "sock", "is not an absolute path"],
    ["a missing path", (r) => join(r, "missing"), "does not exist"],
    [
      "a symbolic link",
      (r) => {
        const target = privateDir(join(r, "t"));
        symlinkSync(target, join(r, "link"));
        return join(r, "link");
      },
      "is a symbolic link",
    ],
    [
      "a file",
      (r) => {
        writeFileSync(join(r, "f"), "");
        return join(r, "f");
      },
      "is not a directory",
    ],
    [
      "group-writable",
      (r) => {
        const d = privateDir(join(r, "g"));
        chmodSync(d, 0o770);
        return d;
      },
      "is writable by group or others",
    ],
    [
      "other-writable",
      (r) => {
        const d = privateDir(join(r, "o"));
        chmodSync(d, 0o703);
        return d;
      },
      "is writable by group or others",
    ],
    [
      "a comma in the path",
      (r) => privateDir(join(r, "a,b")),
      "which lbx cannot mount",
    ],
    [
      "a double quote in the path",
      (r) => privateDir(join(r, 'a"b')),
      "which lbx cannot mount",
    ],
    [
      "a path too long for a socket",
      (r) => privateDir(join(r, "x".repeat(MAX_SOCKET_PATH_BYTES))),
      "bytes a socket path may have",
    ],
    ["the home directory", (_, c) => c.who.home, "is the home directory"],
    [
      "inside the home directory",
      (_, c) => privateDir(join(c.who.home, "s")),
      "is inside the home directory",
    ],
    [
      "an ancestor of the home directory",
      (r) => r,
      "is an ancestor of the home directory",
    ],
    [
      "inside the data directory",
      (_, c) => privateDir(join(c.dataDir, "s")),
      "overlaps the data directory",
    ],
    [
      "the state directory",
      (_, c) => c.stateDir,
      "overlaps lbx's state directory",
    ],
    [
      "above the lbx directory",
      (r) => privateDir(join(r, "run")),
      "overlaps the data directory",
    ],
    [
      "inside the lbx directory",
      (_, c) => privateDir(join(c.lbxDir, "s")),
      "overlaps lbx's configuration directory",
    ],
    [
      "inside lbx's vm artifact directory",
      (_, c) => privateDir(join(c.cwd, "vms_and_docker_from_llm_box", "s")),
      "overlaps lbx's vm artifact directory",
    ],
  ])("refuse %s", (_, make, message) => {
    const root = scratch();
    const ctx = context(root);
    expect(socketDirProblem(make(root, ctx), ctx)).toContain(message);
  });

  it("refuse a directory that is or contains the user runtime directory, and accept one inside it", () => {
    const root = scratch();
    const runtime = privateDir(join(root, "rt", "user"));
    const ctx = context(root, { runtimeDirs: [runtime] });
    expect(socketDirProblem(runtime, ctx)).toContain(
      "is or contains the user runtime directory",
    );
    chmodSync(join(root, "rt"), 0o700);
    expect(socketDirProblem(join(root, "rt"), ctx)).toContain(
      "is or contains the user runtime directory",
    );
    expect(
      socketDirProblem(privateDir(join(runtime, "agents-x")), ctx),
    ).toBe(undefined);
  });

  it("refuse a directory owned by someone else", () => {
    const root = scratch();
    const ctx = context(root, {
      who: { uid: UID + 1, home: join(root, "home") },
    });
    expect(socketDirProblem(privateDir(join(root, "s")), ctx)).toContain(
      "is not owned by the runner user",
    );
  });

  it("know the runtime directories lbx looks at", () => {
    expect(runtimeDirs({ XDG_RUNTIME_DIR: "/run/user/77" }, 424242)).toEqual([
      "/run/user/77",
    ]);
    expect(runtimeDirs({ XDG_RUNTIME_DIR: "relative" }, 424242)).toEqual([]);
  });
});

describe("the socket directory's entries", () => {
  it("must be exactly the named sockets, owned by the runner user", async () => {
    const dir = privateDir(join(scratch(), "s"));
    expect(socketEntriesProblem(dir, UID, [])).toBe(undefined);
    await listen(join(dir, "model.sock"));
    expect(socketEntriesProblem(dir, UID, ["model.sock"])).toBe(undefined);
    expect(socketEntriesProblem(dir, UID + 1, ["model.sock"])).toContain(
      "is not owned by the runner user",
    );
    expect(
      socketEntriesProblem(dir, UID, ["model.sock", "tools.sock"]),
    ).toContain('not ["model.sock","tools.sock"]');
    writeFileSync(join(dir, "tools.sock"), "");
    expect(
      socketEntriesProblem(dir, UID, ["model.sock", "tools.sock"]),
    ).toContain("tools.sock is not a socket");
  });
});

describe("creating the socket directory", () => {
  it("prefers the runtime directory, then /dev/shm, then the run directory", () => {
    expect(socketDirBases({ XDG_RUNTIME_DIR: "/run/user/9" }, "/r")).toEqual([
      "/run/user/9",
      "/dev/shm",
      "/r",
    ]);
    expect(socketDirBases({}, "/r")).toEqual(["/dev/shm", "/r"]);
  });

  it("takes the first base lbx accepts, mode 0700, and names every reason when none does", () => {
    const root = scratch();
    const ctx = context(root);
    const good = privateDir(join(root, "good"));
    const dir = createSocketDir(
      ["/nonexistent-base", join(ctx.who.home), good],
      ctx,
    );
    expect(dir.startsWith(join(good, SOCKET_DIR_PREFIX))).toBe(true);
    expect(readdirSync(ctx.who.home)).toEqual([]);
    expect(() =>
      createSocketDir(["/nonexistent-base", ctx.who.home], ctx),
    ).toThrow(
      /^no place for the run's socket directory that lbx accepts: \/nonexistent-base: ENOENT; .* is inside the home directory$/,
    );
  });

  it("is removed on exit and on a signal nothing else handles, which is then raised again", () => {
    for (const how of ["exit", "SIGTERM", "SIGINT", "SIGHUP"]) {
      const base = scratch();
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          `
import { createServer } from "node:net";
import { join } from "node:path";
import { createSocketDir, removeOnExit } from "./src/run-job/socket-dir.ts";
const dir = createSocketDir([${JSON.stringify(base)}], {
  who: { uid: process.getuid(), home: "/nonexistent-home" },
  dataDir: "/nonexistent-data", stateDir: "/nonexistent-state", lbxDir: "/nonexistent-lbx",
  cwd: "/nonexistent-cwd", runtimeDirs: [],
});
removeOnExit(dir);
const server = createServer().listen(join(dir, "model.sock"), () => {
  console.log(dir);
  if (${JSON.stringify(how)} === "exit") process.exit(3);
  process.kill(process.pid, ${JSON.stringify(how)});
});
`,
        ],
        { cwd: KIT_ROOT, encoding: "utf8", timeout: 30_000 },
      );
      const dir = child.stdout.trim();
      expect(dir.startsWith(base), `${how}: ${child.stderr}`).toBe(true);
      expect(existsSync(dir), how).toBe(false);
      if (how === "exit") expect(child.status).toBe(3);
      else expect(child.signal, how).toBe(how);
    }
  });
});
