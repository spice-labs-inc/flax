import { describe, expect, it } from "vitest";
import { findSecrets, secretsCheck } from "../src/check/secrets.ts";
import { jobFiles, makeRepo, run } from "./helpers.ts";

// Built at runtime so this file never contains a token-shaped literal itself.
const fake = {
  github: "ghp" + "_" + "A1b2C3d4".repeat(5),
  githubOauth: "gho" + "_" + "Z9y8X7w6".repeat(5),
  githubApp: "ghs" + "_" + "Q1w2E3r4".repeat(5),
  githubPat: "github" + "_pat_" + "11ABCDEFG0123456789_abcdefghijklmnop",
  slack: "xox" + "b-" + "1234567890-abcdefghij",
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  privateKey: "-----BEGIN " + "OPENSSH PRIVATE KEY-----",
  openai: "sk" + "-proj-" + "Xy7Qm2Lp9Rt4Vb8Nc3Kd6Hf1",
  anthropic: "sk" + "-ant-" + "api03-Pq8Zr2Tx6Wv1Ys5Ua9Ob3Mc7",
};

describe("secret-shaped strings", () => {
  it.each(Object.entries(fake))("flags a %s", (_, secret) => {
    expect(findSecrets(`some text ${secret} more`)).toHaveLength(1);
  });

  it("leaves ordinary text alone", () => {
    const text = [
      "Use a GitHub token (ghp_...) from the vault.",
      "sk-not-a-real-key-just-an-example-string",
      "A github_pat is a fine-grained token.",
      "task-management and AKIA are words.",
    ].join("\n");
    expect(findSecrets(text)).toEqual([]);
  });

  it("accepts a clean repository", async () => {
    expect(
      await run(secretsCheck, makeRepo({ jobs: { demo: jobFiles("demo") } })),
    ).toEqual([]);
  });

  it("names the file and line without echoing the secret", async () => {
    const root = makeRepo({
      jobs: {
        demo: {
          ...jobFiles("demo"),
          "prompt.md": `Summarize.\nUse ${fake.slack} to post.\n`,
          "fixtures/input.json": JSON.stringify({ key: fake.aws }),
        },
      },
    });
    const problems = await run(secretsCheck, root);
    expect(problems).toEqual([
      "jobs/demo/fixtures/input.json: line 1 matches the AWS access key id pattern; remove the secret and rotate it",
      "jobs/demo/prompt.md: line 2 matches the Slack token pattern; remove the secret and rotate it",
    ]);
    for (const p of problems) {
      expect(p).not.toContain(fake.slack);
      expect(p).not.toContain(fake.aws);
    }
  });
});
