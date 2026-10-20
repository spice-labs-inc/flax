import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createRunDirs,
  dataDirProblem,
  writeDataFiles,
  type Identity,
} from "../src/run-job/data-dir.ts";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-data-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function privateDir(path: string): string {
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o700);
  return path;
}

const uid = process.getuid!();

describe("data directory rules", () => {
  it("accepts a private directory outside the home directory", () => {
    const root = scratch();
    const who: Identity = { uid, home: privateDir(join(root, "home")) };
    expect(dataDirProblem(privateDir(join(root, "data")), who)).toBeUndefined();
  });

  it("refuses the home directory, its ancestors and anything inside it", () => {
    const root = scratch();
    const home = privateDir(join(root, "home", "runner"));
    const who: Identity = { uid, home };
    const inside = privateDir(join(home, "work", "data"));
    expect(dataDirProblem(inside, who)).toBe(
      `${inside} is inside the home directory`,
    );
    expect(dataDirProblem(home, who)).toBe(`${home} is the home directory`);
    const parent = join(root, "home");
    chmodSync(parent, 0o700);
    expect(dataDirProblem(parent, who)).toBe(
      `${parent} is an ancestor of the home directory`,
    );
  });

  it("sees through links to the home directory", () => {
    const root = scratch();
    const home = privateDir(join(root, "home"));
    privateDir(join(home, "data"));
    symlinkSync(home, join(root, "alias"));
    expect(dataDirProblem(join(root, "alias", "data"), { uid, home })).toBe(
      `${join(root, "alias", "data")} is inside the home directory`,
    );
  });

  it.each([0o755, 0o750, 0o600, 0o777])("refuses mode %o", (mode) => {
    const dir = privateDir(join(scratch(), "data"));
    chmodSync(dir, mode);
    expect(dataDirProblem(dir, { uid, home: "/nonexistent-home" })).toBe(
      `${dir} has mode ${mode.toString(8).padStart(4, "0")}; it must be 0700`,
    );
  });

  it("refuses a directory owned by someone else, a link, a file and a missing path", () => {
    const root = scratch();
    const who: Identity = { uid, home: "/nonexistent-home" };
    const dir = privateDir(join(root, "data"));
    expect(dataDirProblem(dir, { ...who, uid: uid + 1 })).toBe(
      `${dir} is not owned by the runner user`,
    );
    symlinkSync(dir, join(root, "link"));
    expect(dataDirProblem(join(root, "link"), who)).toBe(
      `${join(root, "link")} is a symbolic link`,
    );
    writeFileSync(join(root, "file"), "");
    expect(dataDirProblem(join(root, "file"), who)).toBe(
      `${join(root, "file")} is not a directory`,
    );
    expect(dataDirProblem(join(root, "gone"), who)).toBe(
      `${join(root, "gone")} does not exist`,
    );
    expect(dataDirProblem("data", who)).toBe("data is not an absolute path");
  });
});

describe("run directories", () => {
  it("creates private, separate data, lbx and state directories", () => {
    const base = scratch();
    const dirs = createRunDirs(base, "hello", {
      uid,
      home: "/nonexistent-home",
    });
    expect(dirs.root.startsWith(join(base, "job-hello-"))).toBe(true);
    for (const dir of [dirs.root, dirs.data, dirs.lbx, dirs.state])
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirs.root).sort()).toEqual(["data", "lbx", "state"]);
  });

  it("refuses a scratch directory inside the home directory", () => {
    const root = scratch();
    const home = privateDir(join(root, "home"));
    expect(() => createRunDirs(home, "hello", { uid, home })).toThrow(
      "is inside the home directory",
    );
  });

  it("refuses a relative or missing scratch directory", () => {
    const who = { uid, home: "/nonexistent-home" };
    expect(() => createRunDirs("scratch", "hello", who)).toThrow(
      "must be an absolute path",
    );
    expect(() => createRunDirs(join(scratch(), "gone"), "hello", who)).toThrow(
      "does not exist",
    );
  });

  it("writes the prompt, input and schema, and nothing else but the session directory", () => {
    const dirs = createRunDirs(scratch(), "hello", {
      uid,
      home: "/nonexistent-home",
    });
    writeDataFiles(dirs.data, {
      prompt: "Do it.\n",
      input: { text: "x" },
      schema: { type: "object" },
    });
    expect(readdirSync(dirs.data).sort()).toEqual([
      "input.json",
      "output.schema.json",
      "prompt.md",
      "session",
    ]);
    expect(
      JSON.parse(readFileSync(join(dirs.data, "input.json"), "utf8")),
    ).toEqual({ text: "x" });
    expect(statSync(join(dirs.data, "prompt.md")).mode & 0o777).toBe(0o600);
    expect(
      dataDirProblem(dirs.data, { uid, home: "/nonexistent-home" }),
    ).toBeUndefined();
  });
});
