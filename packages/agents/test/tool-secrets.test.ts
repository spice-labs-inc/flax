import { describe, expect, it } from "vitest";
import {
  toolSecretEnv,
  UPSTREAM_OPERATIONS,
  upstreamSecretsByServer,
  upstreamSecrets,
  withoutToolSecrets,
} from "../src/lib/tools.ts";
import { secretValues } from "../src/run-job/report.ts";
import { credentialValues } from "../src/tools-server/start-upstreams.ts";
import { clusters } from "../src/tools-server/kubernetes.ts";

describe("tool secrets", () => {
  it("names a secret list for every upstream, with one kubeconfig per cluster", () => {
    expect(Object.keys(upstreamSecretsByServer()).sort()).toEqual(
      Object.keys(UPSTREAM_OPERATIONS).sort(),
    );
    expect(upstreamSecretsByServer().kubernetes).toEqual(Object.values(clusters()));
    expect(toolSecretEnv()).toEqual([
      "KUBECONFIG_DEV",
      "KUBECONFIG_STAGING",
      "KUBECONFIG_PROD",
      "KUBECONFIG_SHARED_SERVICES",
      "AGENTS_READER_APP_ID",
      "AGENTS_READER_PRIVATE_KEY",
      "OPENOBSERVE_CI_AUTH",
      "SLACK_AGENTS_BOT_TOKEN",
    ]);
  });

  it("lists each needed secret once, in a fixed order", () => {
    expect(upstreamSecrets(["slack", "openobserve"])).toEqual([
      "KUBECONFIG_SHARED_SERVICES",
      "OPENOBSERVE_CI_AUTH",
      "SLACK_AGENTS_BOT_TOKEN",
    ]);
    expect(upstreamSecrets(["builtin"])).toEqual([]);
    expect(upstreamSecrets(["nope"])).toEqual([]);
  });

  it("strips every tool secret from an environment and keeps the rest", () => {
    const env = Object.fromEntries(toolSecretEnv().map((n) => [n, "value"]));
    expect(withoutToolSecrets({ ...env, PATH: "/bin", OTHER: "k" })).toEqual({
      PATH: "/bin",
      OTHER: "k",
    });
  });

  it("scrubs the gateway issuer key and every tool credential from reports", () => {
    expect(
      secretValues({
        LLM_GATEWAY_ISSUER_KEY: "issuer-key",
        SLACK_AGENTS_BOT_TOKEN: " bot-token\n",
        OPENOBSERVE_CI_AUTH: "basic-value",
        KUBECONFIG_PROD: "abc",
        PATH: "/usr/bin",
      }),
    ).toEqual(["issuer-key", "basic-value", "bot-token"]);
  });

  it("does not scrub the GitHub App ids, which are public numbers docs and commits name", () => {
    expect(
      secretValues({
        AGENTS_READER_APP_ID: "1234567",
        AGENTS_READER_PRIVATE_KEY: "reader-private-key",
        AGENTS_WRITER_APP_ID: "7654321",
        AGENTS_WRITER_PRIVATE_KEY: "writer-private-key",
      }).sort(),
    ).toEqual(["reader-private-key", "writer-private-key"]);
  });

  it("leaves the reader app id out of what the tool upstreams scrub too", () => {
    expect(
      credentialValues(
        {
          AGENTS_READER_APP_ID: "1234567",
          AGENTS_READER_PRIVATE_KEY: "reader-private-key",
        },
        ["github"],
      ),
    ).toEqual(["reader-private-key"]);
  });
});
