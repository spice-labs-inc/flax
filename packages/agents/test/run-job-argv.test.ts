import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { THINKING_LEVELS } from "../src/lib/job.ts";
import {
  buildLbxArgv,
  BOX_MODEL_KEY_PLACEHOLDER,
  MAX_RUN_SECONDS,
  PI_MAILBOX_EXTENSION,
  piProviderExtension,
  piCommand,
  runName,
  RUNNER_SECRET_ENV,
  runTimeoutSeconds,
  type LbxArgs,
} from "../src/run-job/argv.ts";

const base: LbxArgs = {
  lbx: "lbx",
  network: { socketDir: "/dev/shm/agents-abc123" },
  dataDir: "/run/x/data",
  timeoutSeconds: 1800,
  runName: "job-hello-123-1",
  command: piCommand("acme/acme-deepseek-v4.1-flash", "high", ["k8s-pods"]),
};

const jobName = fc.stringMatching(/^[a-z][a-z0-9-]{1,40}$/);
const thinkingLevel = fc.constantFrom(...THINKING_LEVELS);
const modelId = fc.stringMatching(
  /^[a-z0-9][a-z0-9._-]{0,10}\/[A-Za-z0-9][A-Za-z0-9._-]{0,20}$/,
);

describe("lbx argv", () => {
  it("is exactly the documented lbx --run command line: no network, the socket directory, the placeholder key and the plugin loaded first", () => {
    expect(buildLbxArgv(base)).toEqual([
      "lbx",
      "--run",
      "--runtime",
      "docker",
      "--no-network",
      "--data",
      "/run/x/data",
      "--timeout",
      "1800",
      "--socket-dir",
      "/dev/shm/agents-abc123",
      "job-hello-123-1",
      "--",
      "env",
      "FLAX_AGENTS_MODEL_BASE_URL=http://127.0.0.1:18080",
      "ACME_BASE_URL=http://127.0.0.1:18080",
      "ACME_API_KEY=held-by-the-runner",
      "sh",
      "-c",
      'exec pi "$@" > /data/answer.txt',
      "pi",
      "--print",
      "--mode",
      "text",
      "--offline",
      "--no-extensions",
      "--extension",
      "/opt/pi-extensions/pi-mcp-mailbox.mjs",
      "--extension",
      "/opt/pi-extensions/node_modules/pi-provider-acme",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--session-dir",
      "/data/session",
      "--model",
      "acme/acme-deepseek-v4.1-flash",
      "--thinking",
      "high",
      "--tools",
      "read,grep,find,ls,k8s-pods",
      "@/data/prompt.md",
      "@/data/output.schema.json",
      "@/data/input.json",
    ]);
    expect(BOX_MODEL_KEY_PLACEHOLDER).toBe("held-by-the-runner");
  });

  it("keeps lbx options before the run name and the command after --, for any job", () => {
    fc.assert(
      fc.property(
        jobName,
        modelId,
        fc.integer({ min: 1, max: 200 }),
        fc.stringMatching(/^\d{1,12}$/),
        thinkingLevel,
        (job, model, turns, id, thinking) => {
          const name = runName(
            job,
            { GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: "2" },
            new Date(0),
          );
          const argv = buildLbxArgv({
            ...base,
            runName: name,
            timeoutSeconds: runTimeoutSeconds(turns),
            command: piCommand(model, thinking),
          });
          const sep = argv.indexOf("--");
          expect(argv[sep - 1]).toBe(name);
          expect(argv.slice(sep + 1)).toEqual(piCommand(model, thinking));
          const options = argv.slice(1, sep - 1);
          expect(options.filter((a) => a.startsWith("--"))).toEqual([
            "--run",
            "--runtime",
            "--no-network",
            "--data",
            "--timeout",
            "--socket-dir",
          ]);
          const timeout = Number(argv[argv.indexOf("--timeout") + 1]);
          expect(timeout).toBeGreaterThanOrEqual(60);
          expect(timeout).toBeLessThanOrEqual(MAX_RUN_SECONDS);
          // The script is fixed; the model only ever travels as its own argument.
          expect(argv[sep + 7]).toBe('exec pi "$@" > /data/answer.txt');
          expect(argv[argv.indexOf("--model") + 1]).toBe(model);
          expect(argv[argv.indexOf("--thinking") + 1]).toBe(thinking);
        },
      ),
    );
  });

  it("never names a variable for the box, nor a net policy", () => {
    const argv = buildLbxArgv(base);
    expect(argv).not.toContain("--env");
    expect(argv).not.toContain("--net-policy");
  });

  it("keeps both model keys, the writer app's secrets and the delivery secrets to the runner", () => {
    expect(RUNNER_SECRET_ENV).toEqual([
      "LLM_GATEWAY_ISSUER_KEY",
      "MODEL_API_KEY",
      "AGENTS_WRITER_APP_ID",
      "AGENTS_WRITER_PRIVATE_KEY",
      "SLACK_AGENTS_POST_TOKEN",
      "YOUTUBE_CLIENT_ID",
      "YOUTUBE_CLIENT_SECRET",
      "YOUTUBE_REFRESH_TOKEN",
      "YOUTUBE_CHANNEL_ID",
      "FLAX_AGENTS_MEDIA_READ_TOKEN",
      "FLAX_AGENTS_MEDIA_DISPATCH_TOKEN",
      "FLAX_AGENTS_ORG_READ_TOKEN",
    ]);
  });

  it.each<[Partial<LbxArgs>, string]>([
    [{ timeoutSeconds: 0 }, "timeout must be a whole number"],
    [{ timeoutSeconds: 604801 }, "timeout must be a whole number"],
    [{ timeoutSeconds: 1.5 }, "timeout must be a whole number"],
    [{ runName: "-job" }, "is not a valid lbx name"],
    [{ runName: "job/../x" }, "is not a valid lbx name"],
    [{ runName: "j".repeat(129) }, "is not a valid lbx name"],
    [
      { network: { socketDir: "sock" } },
      "the socket directory must be an absolute path",
    ],
    [{ dataDir: "data" }, "the data directory must be an absolute path"],
    [{ command: [] }, "the command is empty"],
  ])("refuses %o", (override, message) => {
    expect(() => buildLbxArgv({ ...base, ...override })).toThrow(message);
  });

  it("with no socket directory (the network refusal check), is lbx --no-network alone", () => {
    const argv = buildLbxArgv({ ...base, network: { noNetwork: true } });
    expect(argv.slice(0, 6)).toEqual([
      "lbx",
      "--run",
      "--runtime",
      "docker",
      "--no-network",
      "--data",
    ]);
    expect(argv).not.toContain("--socket-dir");
  });

  it("gives Pi its bash tool only for a job with shell on, and refuses bash as a job tool", () => {
    const tools = (argv: string[]) => argv[argv.indexOf("--tools") + 1];
    expect(tools(piCommand("m/x", "high", ["t1"]))).toBe(
      "read,grep,find,ls,t1",
    );
    expect(tools(piCommand("m/x", "high", ["t1"], { shell: true }))).toBe(
      "read,grep,find,ls,bash,t1",
    );
    expect(() => piCommand("m/x", "high", ["bash"])).toThrow(
      "one of Pi's own tools",
    );
  });
});

describe("Pi's command for a job with tools", () => {
  const model = "acme/acme-deepseek-v4.1-flash";
  const thinking = "high";
  const after = (argv: string[], flag: string) =>
    argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

  it("loads the plugin before the Acme provider, for a job without tools too", () => {
    const argv = piCommand(model, thinking);
    expect(after(argv, "--extension")).toEqual([
      PI_MAILBOX_EXTENSION,
      piProviderExtension()!,
    ]);
    expect(PI_MAILBOX_EXTENSION).toBe("/opt/pi-extensions/pi-mcp-mailbox.mjs");
    expect(after(argv, "--tools")).toEqual(["read,grep,find,ls"]);
    expect(argv.slice(0, 4)).toEqual([
      "env",
      "FLAX_AGENTS_MODEL_BASE_URL=http://127.0.0.1:18080",
      "ACME_BASE_URL=http://127.0.0.1:18080",
      "ACME_API_KEY=held-by-the-runner",
    ]);
  });

  it("adds the job's tools to the allowlist, and changes nothing else", () => {
    const argv = piCommand(model, thinking, ["k8s-pods", "slack-history"]);
    expect(after(argv, "--tools")).toEqual([
      "read,grep,find,ls,k8s-pods,slack-history",
    ]);
    const withTools = [...argv];
    withTools[withTools.indexOf("--tools") + 1] = "read,grep,find,ls";
    expect(withTools).toEqual(piCommand(model, thinking));
  });

  it.each<[string[], string]>([
    [["Bad"], '"Bad" is not a tool name'],
    [["a,b"], '"a,b" is not a tool name'],
    [["k8s-pods", "k8s-pods"], "a tool is named twice"],
    [["read"], '"read" is one of Pi\'s own tools'],
  ])("refuses the tools %o", (tools, message) => {
    expect(() => piCommand(model, thinking, tools)).toThrow(message);
  });

  it("always passes the thinking level, and refuses one Pi does not take", () => {
    for (const level of THINKING_LEVELS)
      expect(after(piCommand(model, level), "--thinking")).toEqual([level]);
    for (const level of ["", "none", "HIGH", "high,max"])
      expect(() => piCommand(model, level)).toThrow(
        `"${level}" is not a thinking level Pi takes`,
      );
  });
});

describe("Pi's command for the repair turn", () => {
  it("continues the run's own session with only the repair request, and changes nothing else", () => {
    const first = piCommand("acme/m", "high", ["k8s-pods"], { shell: true });
    const repair = piCommand("acme/m", "high", ["k8s-pods"], {
      shell: true,
      session: "2026-10-08T12-00-00-000Z_abc.jsonl",
    });
    expect(repair.slice(0, -3)).toEqual(first.slice(0, -3));
    expect(first.slice(-3)).toEqual([
      "@/data/prompt.md",
      "@/data/output.schema.json",
      "@/data/input.json",
    ]);
    expect(repair.slice(-3)).toEqual([
      "--session",
      "/data/session/2026-10-08T12-00-00-000Z_abc.jsonl",
      "@/data/repair.md",
    ]);
  });

  it("refuses a session name that is not a plain session file name", () => {
    for (const session of ["../x.jsonl", "a/b.jsonl", "x.json", ".x.jsonl", ""])
      expect(() => piCommand("acme/m", "high", [], { session })).toThrow(
        "is not a Pi session file name",
      );
  });
});

describe("run limits and names", () => {
  it("gives each turn a minute, capped at three hours", () => {
    expect(runTimeoutSeconds(1)).toBe(60);
    expect(runTimeoutSeconds(30)).toBe(1800);
    expect(runTimeoutSeconds(200)).toBe(MAX_RUN_SECONDS);
    expect(MAX_RUN_SECONDS).toBe(10800);
  });

  it("names a run after the Actions run and attempt, or the time", () => {
    const at = new Date("2026-09-25T15:04:05.678Z");
    expect(
      runName(
        "hello",
        { GITHUB_RUN_ID: "36077537945", GITHUB_RUN_ATTEMPT: "2" },
        at,
      ),
    ).toBe("job-hello-36077537945-2");
    expect(runName("hello", { GITHUB_RUN_ID: "42" }, at)).toBe(
      "job-hello-42-1",
    );
    expect(runName("hello", {}, at)).toBe("job-hello-20260925T150405Z");
    expect(runName("hello", { GITHUB_RUN_ID: "x;rm" }, at)).toBe(
      "job-hello-20260925T150405Z",
    );
  });
});
