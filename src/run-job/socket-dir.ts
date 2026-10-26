import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import {
  MODEL_SOCKET,
  TOOLS_SOCKET,
} from "../../images/agent/pi-mcp-mailbox/src/sockets.ts";
import type { Identity } from "./data-dir.ts";

/** The socket directory's name is this plus six random characters. */
export const SOCKET_DIR_PREFIX = "agents-";
/** Linux's limit on a socket's path (sun_path, 108 bytes with the closing zero). */
export const MAX_SOCKET_PATH_BYTES = 107;
/** lbx makes the vm artifact directory here, under the directory it runs in. */
const LBX_ARTIFACT_DIR = "vms_and_docker_from_llm_box";

/** What lbx compares a socket directory against (lbx ADR 013). */
export interface SocketDirContext {
  who: Identity;
  dataDir: string;
  stateDir: string;
  /** The run's lbx directory, which holds the configuration file. */
  lbxDir: string;
  /** The directory lbx runs in; it keeps its vm artifacts below it. */
  cwd: string;
  /** XDG_RUNTIME_DIR and /run/user/<uid>, where set or present. */
  runtimeDirs: readonly string[];
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The user's runtime directories lbx keeps a socket directory from containing. */
export function runtimeDirs(env: NodeJS.ProcessEnv, uid: number): string[] {
  const dirs: string[] = [];
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg !== undefined && isAbsolute(xdg)) dirs.push(xdg);
  const run = `/run/user/${uid}`;
  if (existsSync(run)) dirs.push(run);
  return dirs;
}

/**
 * Where the socket directory may go, best first: the user's runtime
 * directory and /dev/shm, both memory-backed and outside the home
 * directory, then the run directory. The agents pool's runner has no
 * login session, so no runtime directory, and uses /dev/shm.
 */
export function socketDirBases(
  env: NodeJS.ProcessEnv,
  runRoot: string,
): string[] {
  const xdg = env.XDG_RUNTIME_DIR;
  return [
    ...(xdg !== undefined && isAbsolute(xdg) ? [xdg] : []),
    "/dev/shm",
    runRoot,
  ];
}

/**
 * Why lbx would refuse this socket directory, or undefined when it is
 * fine: the rules of lbx --socket-dir other than those on its entries,
 * checked here too so a run fails with a clear message before lbx starts.
 */
export function socketDirProblem(
  dir: string,
  ctx: SocketDirContext,
): string | undefined {
  if (!isAbsolute(dir)) return `${dir} is not an absolute path`;
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return `${dir} does not exist`;
  }
  if (stat.isSymbolicLink()) return `${dir} is a symbolic link`;
  if (!stat.isDirectory()) return `${dir} is not a directory`;
  if (stat.uid !== ctx.who.uid) return `${dir} is not owned by the runner user`;
  if ((stat.mode & 0o022) !== 0) return `${dir} is writable by group or others`;
  const real = resolved(dir);
  if (/[,"\n]/.test(real))
    return `${dir} holds a comma, a double quote or a newline, which lbx cannot mount`;
  const longest = join(
    real,
    MODEL_SOCKET.length > TOOLS_SOCKET.length ? MODEL_SOCKET : TOOLS_SOCKET,
  );
  if (Buffer.byteLength(longest) > MAX_SOCKET_PATH_BYTES)
    return `${longest} is longer than the ${MAX_SOCKET_PATH_BYTES} bytes a socket path may have`;
  const home = resolved(ctx.who.home);
  if (real === home) return `${dir} is the home directory`;
  if (within(home, real)) return `${dir} is an ancestor of the home directory`;
  if (within(real, home)) return `${dir} is inside the home directory`;
  const others: [string, string][] = [
    ["the data directory", ctx.dataDir],
    ["lbx's state directory", ctx.stateDir],
    ["lbx's configuration directory", ctx.lbxDir],
    ["lbx's vm artifact directory", join(ctx.cwd, LBX_ARTIFACT_DIR)],
  ];
  for (const [what, path] of others)
    if (overlaps(real, resolved(path))) return `${dir} overlaps ${what}`;
  for (const runtime of ctx.runtimeDirs)
    if (within(resolved(runtime), real))
      return `${dir} is or contains the user runtime directory ${runtime}`;
  return undefined;
}

/**
 * Why the directory does not hold exactly the named sockets, each owned by
 * the runner user, or undefined when it does. lbx refuses any other entry.
 */
export function socketEntriesProblem(
  dir: string,
  uid: number,
  names: readonly string[],
): string | undefined {
  const entries = readdirSync(dir).sort();
  const want = [...names].sort();
  if (entries.join("\n") !== want.join("\n"))
    return `${dir} holds ${JSON.stringify(entries)}, not ${JSON.stringify(want)}`;
  for (const name of entries) {
    const stat = lstatSync(join(dir, name));
    if (!stat.isSocket()) return `${join(dir, name)} is not a socket`;
    if (stat.uid !== uid)
      return `${join(dir, name)} is not owned by the runner user`;
  }
  return undefined;
}

/**
 * Creates a new socket directory, mode 0700, in the first base where lbx
 * would take it. Throws with every base's reason when none will do.
 */
export function createSocketDir(
  bases: readonly string[],
  ctx: SocketDirContext,
): string {
  const reasons: string[] = [];
  for (const base of bases) {
    let dir: string;
    try {
      dir = mkdtempSync(join(base, SOCKET_DIR_PREFIX));
    } catch (err) {
      reasons.push(
        `${base}: ${(err as NodeJS.ErrnoException).code ?? "cannot create a directory"}`,
      );
      continue;
    }
    chmodSync(dir, 0o700);
    const problem = socketDirProblem(dir, ctx);
    if (problem === undefined) return dir;
    rmSync(dir, { recursive: true, force: true });
    reasons.push(problem);
  }
  throw new Error(
    `no place for the run's socket directory that lbx accepts: ${reasons.join("; ")}`,
  );
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Removes the socket directory when the process ends without the run's own
 * cleanup: on exit, and on a signal nothing else handles (the launcher
 * handles them while lbx runs, and the run then cleans up itself), after
 * which the signal is raised again. Returns the function that removes the
 * directory and these handlers.
 */
export function removeOnExit(dir: string): () => void {
  const remove = () => rmSync(dir, { recursive: true, force: true });
  const handlers = SIGNALS.map((signal) => {
    const handler = () => {
      if (process.listenerCount(signal) > 1) return;
      release();
      process.kill(process.pid, signal);
    };
    return [signal, handler] as const;
  });
  let released = false;
  function release(): void {
    if (released) return;
    released = true;
    remove();
    process.off("exit", remove);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  process.on("exit", remove);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  return release;
}
