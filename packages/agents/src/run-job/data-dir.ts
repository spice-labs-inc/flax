import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { DATA_FILES } from "./argv.ts";

/** One run's directories; data is mounted into the box, the others never are. */
export interface RunDirs {
  root: string;
  /** Mounted at /data: the prompt, input and schema going in, the answer coming out. */
  data: string;
  /** The lbx configuration. lbx refuses a data directory that overlaps it. */
  lbx: string;
  /** LLMBOX_STATE_DIR: where lbx writes the status file. */
  state: string;
}

export interface Identity {
  uid: number;
  home: string;
}

export function currentIdentity(): Identity {
  return { uid: process.getuid?.() ?? -1, home: homedir() };
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Why lbx would refuse this data directory, or undefined when it is fine.
 * Checked here as well so the run fails with a clear message before lbx
 * starts, and so the rules are tested without docker.
 */
export function dataDirProblem(dir: string, who: Identity): string | undefined {
  if (!isAbsolute(dir)) return `${dir} is not an absolute path`;
  if (!existsSync(dir)) return `${dir} does not exist`;
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) return `${dir} is a symbolic link`;
  if (!stat.isDirectory()) return `${dir} is not a directory`;
  if (stat.uid !== who.uid) return `${dir} is not owned by the runner user`;
  const mode = stat.mode & 0o777;
  if (mode !== 0o700)
    return `${dir} has mode ${mode.toString(8).padStart(4, "0")}; it must be 0700`;
  const real = resolved(dir);
  const home = resolved(who.home);
  if (real === home) return `${dir} is the home directory`;
  if (within(home, real)) return `${dir} is an ancestor of the home directory`;
  if (within(real, home)) return `${dir} is inside the home directory`;
  return undefined;
}

function privateDir(path: string): string {
  mkdirSync(path, { mode: 0o700 });
  // mkdir applies the umask; the mode is checked later, so set it exactly.
  chmodSync(path, 0o700);
  return path;
}

/** Creates a fresh run directory under base. base comes from RUNNER_TEMP or --scratch. */
export function createRunDirs(
  base: string,
  job: string,
  who: Identity = currentIdentity(),
): RunDirs {
  if (!isAbsolute(base))
    throw new Error(`scratch directory ${base} must be an absolute path`);
  if (!existsSync(base) || !lstatSync(base).isDirectory())
    throw new Error(`scratch directory ${base} does not exist`);
  const root = mkdtempSync(join(base, `job-${job}-`));
  chmodSync(root, 0o700);
  const dirs: RunDirs = {
    root,
    data: privateDir(join(root, "data")),
    lbx: privateDir(join(root, "lbx")),
    state: privateDir(join(root, "state")),
  };
  const reason = dataDirProblem(dirs.data, who);
  if (reason !== undefined)
    throw new Error(`cannot use this data directory: ${reason}`);
  return dirs;
}

export interface DataFiles {
  prompt: string;
  input: unknown;
  schema: unknown;
}

/** Writes the run's inputs. Nothing else goes into the data directory before the run. */
export function writeDataFiles(dir: string, files: DataFiles): void {
  const write = (name: string, text: string) =>
    writeFileSync(join(dir, name), text, { mode: 0o600, flag: "wx" });
  write(DATA_FILES.prompt, files.prompt);
  write(DATA_FILES.input, `${JSON.stringify(files.input, null, 2)}\n`);
  write(DATA_FILES.schema, `${JSON.stringify(files.schema, null, 2)}\n`);
  privateDir(join(dir, DATA_FILES.sessions));
}

/**
 * Where run directories go: `--scratch` when given, else RUNNER_TEMP, else
 * the system temp directory, the first that exists outside the home
 * directory. On a GitHub-hosted runner RUNNER_TEMP is inside the home
 * directory, so the system temp directory takes over there.
 */
export function scratchBase(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
  who: Identity = currentIdentity(),
): { base: string } | { error: string } {
  if (explicit !== undefined) {
    const problem = baseProblem(explicit, who);
    return problem === undefined
      ? { base: explicit }
      : { error: `scratch directory ${explicit} ${problem}` };
  }
  const tried: string[] = [];
  for (const candidate of [env.RUNNER_TEMP, tmpdir()]) {
    if (!candidate) continue;
    const problem = baseProblem(candidate, who);
    if (problem === undefined) return { base: candidate };
    tried.push(`${candidate} ${problem}`);
  }
  return {
    error: `no directory for the run directory: ${tried.join("; ")}; pass --scratch <dir> with a directory outside the home directory`,
  };
}

function baseProblem(dir: string, who: Identity): string | undefined {
  if (!isAbsolute(dir)) return "is not an absolute path";
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return "does not exist";
  const real = resolved(dir);
  const home = resolved(who.home);
  if (real === home || within(real, home))
    return "is inside the home directory";
  return undefined;
}
