import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  LbxLauncher,
  parseStatus,
  readStatus,
  StubLauncher,
  statusFile,
} from "../src/run-job/launcher.ts";
import { writeFakeLbx } from "./fake-lbx.ts";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-launch-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function collect(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return () => Buffer.concat(chunks).toString("utf8");
}

describe("lbx status", () => {
  it.each([
    ["status=exited code=0", { status: "exited", code: 0 }],
    ["status=timeout code=124\n", { status: "timeout", code: 124 }],
    ["status=setup-failed code=125", { status: "setup-failed", code: 125 }],
    ["status=refused code=125", { status: "refused", code: 125 }],
    ["status=signal code=143", { status: "signal", code: 143 }],
    [
      "status=exited code=0 cleanup=incomplete",
      { status: "exited", code: 0, cleanupIncomplete: true },
    ],
    [
      "status=timeout code=124 cleanup=incomplete",
      { status: "timeout", code: 124, cleanupIncomplete: true },
    ],
  ])("parses %j", (line, status) => {
    expect(parseStatus(line)).toEqual(status);
  });

  it.each([
    "status=done code=0",
    "status=exited",
    "code=0 status=exited",
    "status=exited code=x",
    "status=exited code=0 cleanup=done",
    "status=exited code=0 cleanup=incomplete extra",
  ])("rejects %j", (line) => {
    expect(parseStatus(line)).toBeUndefined();
  });

  it("trusts the status file over the standard error line", () => {
    const state = scratch();
    expect(readStatus(state, "r", "status=exited code=0")).toEqual({
      status: { status: "exited", code: 0 },
      statusSource: "stderr",
    });
    mkdirSync(join(state, "runs", "r"), { recursive: true });
    writeFileSync(statusFile(state, "r"), "status=timeout code=124\n");
    expect(readStatus(state, "r", "status=exited code=0")).toEqual({
      status: { status: "timeout", code: 124 },
      statusSource: "file",
    });
    expect(readStatus(scratch(), "r", undefined)).toEqual({
      statusSource: "none",
    });
  });
});

describe("launchers", () => {
  it("runs lbx, streams its output and reads the status file", async () => {
    const dir = scratch();
    const lbx = writeFakeLbx(dir);
    const data = join(dir, "data");
    const state = join(dir, "state");
    const config = join(dir, "config");
    mkdirSync(data);
    mkdirSync(state);
    writeFileSync(config, "image.docker=x\n");
    const out = new PassThrough();
    const err = new PassThrough();
    const stdout = collect(out);
    const stderr = collect(err);
    const result = await new LbxLauncher(out, err).launch({
      argv: [lbx, "--data", data, "run-1", "--", "true"],
      env: {
        LLMBOX_STATE_DIR: state,
        LLMBOX_CONFIG: config,
        FAKE_LBX_ANSWER: "{}",
        FAKE_LBX_STATUS: "status=exited code=3",
      },
      stateDir: state,
      runName: "run-1",
      answerPath: join(data, "answer.txt"),
    });
    expect(result).toEqual({
      exitCode: 3,
      status: { status: "exited", code: 3 },
      statusSource: "file",
    });
    expect(stdout()).toBe("pi output\n");
    expect(stderr()).toContain("lbx-run: status=exited code=3");
    expect(readFileSync(join(data, "answer.txt"), "utf8")).toBe("{}");
  });

  it("falls back to the status line when lbx refused and wrote no file", async () => {
    const dir = scratch();
    const lbx = writeFakeLbx(dir);
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "config"), "");
    const result = await new LbxLauncher(
      new PassThrough(),
      new PassThrough(),
    ).launch({
      argv: [lbx, "--data", join(dir, "data"), "run-1", "--", "true"],
      env: {
        LLMBOX_STATE_DIR: join(dir, "state"),
        LLMBOX_CONFIG: join(dir, "config"),
        FAKE_LBX_STATUS: "status=refused code=125",
        FAKE_LBX_NO_FILE: "1",
      },
      stateDir: join(dir, "state"),
      runName: "run-1",
      answerPath: join(dir, "data", "answer.txt"),
    });
    expect(result).toEqual({
      exitCode: 125,
      status: { status: "refused", code: 125 },
      statusSource: "stderr",
    });
  });

  it("rejects when lbx is not there", async () => {
    await expect(
      new LbxLauncher(new PassThrough(), new PassThrough()).launch({
        argv: [join(scratch(), "no-such-lbx")],
        env: {},
        stateDir: "/nonexistent",
        runName: "r",
        answerPath: "/nonexistent/answer.txt",
      }),
    ).rejects.toThrow("ENOENT");
  });

  it("the stub writes its answer where the command would and starts nothing", async () => {
    const dir = scratch();
    const stub = new StubLauncher('{"summary":"hi"}');
    const request = {
      argv: ["lbx", "--run"],
      env: {},
      stateDir: dir,
      runName: "r",
      answerPath: join(dir, "answer.txt"),
    };
    expect(await stub.launch(request)).toEqual({
      exitCode: 0,
      status: { status: "exited", code: 0 },
      statusSource: "stub",
    });
    expect(readFileSync(join(dir, "answer.txt"), "utf8")).toBe(
      '{"summary":"hi"}',
    );
    expect(stub.requests).toEqual([request]);
  });
});
