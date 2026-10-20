import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { stringify } from "yaml";
import type { LaunchRequest, Launcher } from "../src/run-job/launcher.ts";
import {
  interfaceAddresses,
  probe,
  proxyOf,
  type Attempt,
  type ProbeResult,
  type Target,
} from "../src/net-check/probe.ts";
import { PLAN_FILE, runNetCheck } from "../src/net-check/run.ts";
import {
  kubeconfigServer,
  targetsFrom,
  withAddresses,
} from "../src/net-check/targets.ts";
import { formatVerdict, judge } from "../src/net-check/verdict.ts";
import { writeFakeLbx } from "./fake-lbx.ts";
import { makeRepo } from "./helpers.ts";

// Built at runtime so no credential-shaped literal sits in the source.
const TOKEN = ["service", "account", "token", "9f8e7d6c"].join("-");
const WHO = { uid: process.getuid!(), home: "/nonexistent-home" };

function kubeconfig(server: string): string {
  return stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      { name: "c", cluster: { server, "certificate-authority-data": "Q0E=" } },
    ],
    users: [{ name: "reader", user: { token: TOKEN } }],
    contexts: [{ name: "c", context: { cluster: "c", user: "reader" } }],
    "current-context": "c",
  });
}

const blocked = (kind: string, detail = "ENOTFOUND"): Attempt => ({
  kind,
  outcome: "blocked",
  detail,
});

const TARGETS: Target[] = [
  {
    name: "GitHub API",
    host: "api.github.com",
    port: 443,
    addresses: ["140.82.112.6"],
  },
  { name: "Slack API", host: "slack.com", port: 443, addresses: [] },
];

/** What the probe sees in a box started with lbx --no-network: only loopback, no proxy, no route. */
function noNetworkResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    proxy: null,
    interfaces: [
      { name: "lo", address: "127.0.0.1", internal: true },
      { name: "lo", address: "::1", internal: true },
    ],
    loopback: { kind: "loopback", outcome: "reached", detail: "connected" },
    targets: TARGETS.map((t) => ({
      name: t.name,
      host: t.host,
      port: t.port,
      attempts: [
        blocked("dns-lookup", "EAI_AGAIN"),
        blocked("dns-query", "EAI_AGAIN"),
        ...t.addresses.map((a) => blocked(`tcp ${a}`, "ENETUNREACH")),
        blocked("tcp-by-name", "EAI_AGAIN"),
      ],
    })),
    ...overrides,
  };
}

describe("the verdict of the network refusal check", () => {
  it("passes a box with no network, where every attempt is blocked with no route", () => {
    const v = judge(TARGETS, noNetworkResult());
    expect(v.pass).toBe(true);
    const text = formatVerdict(v);
    expect(text).toContain("Network refusal check (box with no network)");
    expect(text).toContain("PASS  GitHub API (api.github.com:443)");
    expect(text).toContain("        tcp 140.82.112.6: blocked (ENETUNREACH)");
    expect(text).toContain("addresses in the box: lo 127.0.0.1, lo ::1");
    expect(text.trimEnd().endsWith("PASS: every target was refused")).toBe(
      true,
    );
  });

  it("fails a box that has a proxy, an address besides loopback or a route", () => {
    const proxied = judge(
      TARGETS,
      noNetworkResult({ proxy: "http://172.18.0.2:3128" }),
    );
    expect(proxied.pass).toBe(false);
    expect(proxied.problems).toEqual([
      "the box was started with no network, but its proxy variables name a proxy (http://172.18.0.2:3128)",
    ]);

    const addressed = noNetworkResult();
    addressed.interfaces.push({
      name: "eth0",
      address: "172.17.0.2",
      internal: false,
    });
    const v1 = judge(TARGETS, addressed);
    expect(v1.pass).toBe(false);
    expect(v1.problems).toEqual([
      "the box was started with no network, but has an address besides loopback: eth0 172.17.0.2",
    ]);

    // A timeout or a refused connection means a route exists, even with nothing reached.
    for (const detail of ["timed out", "ECONNREFUSED"]) {
      const routed = noNetworkResult();
      routed.targets[0]!.attempts[2] = blocked("tcp 140.82.112.6", detail);
      const v = judge(TARGETS, routed);
      expect(v.pass).toBe(false);
      expect(v.targets.map((t) => t.pass)).toEqual([false, true]);
      expect(v.targets[0]!.lines).toContain(
        `tcp 140.82.112.6: expected no route (ENETUNREACH or EHOSTUNREACH), got ${detail}`,
      );
    }
    const hostUnreachable = noNetworkResult();
    hostUnreachable.targets[0]!.attempts[2] = blocked(
      "tcp 140.82.112.6",
      "EHOSTUNREACH",
    );
    expect(judge(TARGETS, hostUnreachable).pass).toBe(true);

    const unreported = noNetworkResult() as Partial<ProbeResult>;
    delete unreported.interfaces;
    const v2 = judge(TARGETS, unreported as ProbeResult);
    expect(v2.pass).toBe(false);
    expect(v2.problems).toContain(
      "the probe did not report the box's network interfaces",
    );
  });

  it("fails a target that was reached any way", () => {
    const reached = noNetworkResult();
    reached.targets[0]!.attempts[2] = {
      kind: "tcp 140.82.112.6",
      outcome: "reached",
      detail: "connected",
    };
    const v1 = judge(TARGETS, reached);
    expect(v1.pass).toBe(false);
    expect(v1.targets.map((t) => t.pass)).toEqual([false, true]);

    const resolved = noNetworkResult();
    resolved.targets[1]!.attempts[0] = {
      kind: "dns-lookup",
      outcome: "reached",
      detail: "resolved to 192.0.2.1",
    };
    expect(judge(TARGETS, resolved).targets[1]!.pass).toBe(false);
  });

  it("fails when the probe could not tell reached from blocked, or gave nothing", () => {
    const noLoopback = judge(
      TARGETS,
      noNetworkResult({ loopback: blocked("loopback", "EACCES") }),
    );
    expect(noLoopback.pass).toBe(false);
    expect(noLoopback.problems).toContain(
      "the probe could not reach a listener on loopback, so its refusals prove nothing",
    );
    const nothing = judge(TARGETS, undefined);
    expect(nothing.pass).toBe(false);
    expect(formatVerdict(nothing)).toContain("FAIL  GitHub API");
  });
});

describe("the targets", () => {
  it("takes only the API server's host and port from a kubeconfig", () => {
    expect(
      kubeconfigServer(kubeconfig("https://abc.api.k8s.fr-par.scw.cloud:6443")),
    ).toEqual({
      host: "abc.api.k8s.fr-par.scw.cloud",
      port: 6443,
    });
    expect(kubeconfigServer("not: [yaml")).toBe(undefined);
    expect(kubeconfigServer(stringify({ clusters: [] }))).toBe(undefined);
  });

  it("checks each cluster whose kubeconfig is set, then the fixed hosts, and never carries a credential", () => {
    const { targets, notes } = targetsFrom({
      KUBECONFIG_DEV: kubeconfig("https://dev.invalid:6443"),
      KUBECONFIG_STAGING: kubeconfig("https://staging.invalid"),
      KUBECONFIG_PROD: kubeconfig("https://dev.invalid:6443"),
    });
    expect(targets.slice(0, 2)).toEqual([
      { name: "kubernetes dev", host: "dev.invalid", port: 6443 },
      { name: "kubernetes staging", host: "staging.invalid", port: 443 },
    ]);
    expect(targets.map((t) => t.host)).toEqual(
      expect.arrayContaining([
        "api.github.com",
        "slack.com",
        "openobserve.shared-services.svc.notes-co.example",
        "example.com",
      ]),
    );
    expect(notes).toEqual([
      "KUBECONFIG_SHARED_SERVICES is not set or names no server; kubernetes shared-services is not checked",
    ]);
    expect(JSON.stringify(targets)).not.toContain(TOKEN);
  });

  it("adds the addresses the runner resolves, and none when it cannot", async () => {
    expect(
      await withAddresses(
        [
          { name: "a", host: "a.invalid", port: 443 },
          { name: "b", host: "b.invalid", port: 443 },
        ],
        (host) =>
          host === "a.invalid"
            ? Promise.resolve(["192.0.2.1", "192.0.2.2", "192.0.2.3"])
            : Promise.reject(new Error("ENOTFOUND")),
      ),
    ).toEqual([
      {
        name: "a",
        host: "a.invalid",
        port: 443,
        addresses: ["192.0.2.1", "192.0.2.2"],
      },
      { name: "b", host: "b.invalid", port: 443, addresses: [] },
    ]);
  });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
    onTestFinished(() => void server.close());
  });
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("the probe that runs in the box", () => {
  it("finds a proxy in the proxy variables", () => {
    expect(proxyOf({ HTTPS_PROXY: "http://relay:3128" })).toBe(
      "http://relay:3128",
    );
    expect(proxyOf({ http_proxy: "http://10.0.0.2" })).toBe("http://10.0.0.2");
    expect(proxyOf({ HTTPS_PROXY: "" })).toBe(undefined);
    expect(proxyOf({})).toBe(undefined);
  });

  it("lists every address of every interface, and whether it is loopback", () => {
    expect(
      interfaceAddresses({
        lo: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "127.0.0.1/8",
          },
        ],
        eth0: [
          {
            address: "172.17.0.2",
            netmask: "255.255.0.0",
            family: "IPv4",
            mac: "02:42:ac:11:00:02",
            internal: false,
            cidr: "172.17.0.2/16",
          },
        ],
      }),
    ).toEqual([
      { name: "lo", address: "127.0.0.1", internal: true },
      { name: "eth0", address: "172.17.0.2", internal: false },
    ]);
    expect(interfaceAddresses().some((i) => i.internal)).toBe(true);
  });

  it("reports a reachable target as reached, so a refusal means something", async () => {
    const open = createServer((s) => s.destroy());
    const port = await listen(open);
    const result = await probe(
      {
        targets: [
          { name: "open", host: "127.0.0.1", port, addresses: ["127.0.0.1"] },
        ],
        timeoutMs: 1000,
        dnsServers: [`127.0.0.1:${await closedPort()}`],
      },
      {},
    );
    const kinds = Object.fromEntries(
      result.targets[0]!.attempts.map((a) => [a.kind, a.outcome]),
    );
    expect(kinds).toMatchObject({
      "tcp 127.0.0.1": "reached",
      "tcp-by-name": "reached",
    });
    expect(result.loopback.outcome).toBe("reached");
    expect(result.proxy).toBe(null);
  });

  it("reports blocked DNS and blocked connections, and names a proxy it was given", async () => {
    const port = await closedPort();
    const result = await probe(
      {
        targets: [
          { name: "k8s", host: "k8s.invalid", port, addresses: ["127.0.0.1"] },
        ],
        timeoutMs: 1000,
        dnsServers: [`127.0.0.1:${await closedPort()}`],
      },
      { HTTPS_PROXY: "http://127.0.0.1:3128" },
    );
    expect(result.proxy).toBe("http://127.0.0.1:3128");
    expect(result.targets[0]!.attempts.map((a) => [a.kind, a.outcome])).toEqual(
      [
        ["dns-lookup", "blocked"],
        ["dns-query", "blocked"],
        ["tcp 127.0.0.1", "blocked"],
        ["tcp-by-name", "blocked"],
      ],
    );
  });
});

/**
 * Stands in for lbx --no-network: runs the command's shell line on the host
 * with /data pointing at the data directory and no proxy variables.
 */
class ProbeLauncher implements Launcher {
  readonly kind = "lbx";
  readonly requests: LaunchRequest[] = [];

  async launch(request: LaunchRequest) {
    this.requests.push(request);
    const data = request.argv[request.argv.indexOf("--data") + 1]!;
    const command = request.argv.slice(request.argv.indexOf("--") + 1);
    const line = command[2]!.replaceAll("/data/", `${data}/`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("sh", ["-c", line], {
        env: { PATH: process.env.PATH ?? "" },
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    return {
      exitCode: 0,
      status: { status: "exited" as const, code: 0 },
      statusSource: "file" as const,
    };
  }
}

describe("the network refusal check end to end", () => {
  it("asks lbx for --no-network, starts the box with it and runs the bundled probe, never carrying a credential", async () => {
    const bin = mkdtempSync(join(tmpdir(), "agents-net-check-bin-"));
    const scratch = mkdtempSync(join(tmpdir(), "agents-net-check-"));
    onTestFinished(() => {
      rmSync(bin, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    });
    const lbx = writeFakeLbx(bin);
    const launcher = new ProbeLauncher();
    const port = await closedPort();
    const result = await runNetCheck({
      root: makeRepo(),
      scratch,
      identity: WHO,
      launcher,
      lbx,
      env: {
        PATH: process.env.PATH ?? "",
        KUBECONFIG_DEV: kubeconfig(`https://dev.invalid:${port}`),
        KUBECONFIG_PROD: kubeconfig(`https://prod.invalid:${port}`),
      },
      fixedTargets: [{ name: "a public host", host: "public.invalid", port }],
      lookup: () => Promise.resolve(["127.0.0.1"]),
      dnsServers: [`127.0.0.1:${await closedPort()}`],
    });
    expect(JSON.parse(readFileSync(join(bin, "probes.json"), "utf8"))).toEqual([
      ["--socket-dir", "/"],
      ["--no-network"],
    ]);
    const request = launcher.requests[0]!;
    expect(request.argv.slice(0, 6)).toEqual([
      lbx,
      "--run",
      "--runtime",
      "docker",
      "--no-network",
      "--data",
    ]);
    expect(request.argv).not.toContain("--socket-dir");
    expect(request.argv).not.toContain("--env");
    expect(
      Object.keys(request.env).filter((k) => /KUBECONFIG/.test(k)),
    ).toEqual([]);
    const lbxDir = join(request.env.LLMBOX_CONFIG!, "..");
    expect(existsSync(join(lbxDir, "net-policy.json"))).toBe(false);
    const data = request.argv[request.argv.indexOf("--data") + 1]!;
    const plan = readFileSync(join(data, PLAN_FILE), "utf8");
    expect(plan).toContain("dev.invalid");
    expect(plan).not.toContain(TOKEN);
    expect(result.verdict.problems).toEqual(
      expect.arrayContaining([
        "KUBECONFIG_STAGING is not set or names no server; kubernetes staging is not checked",
        "KUBECONFIG_SHARED_SERVICES is not set or names no server; kubernetes shared-services is not checked",
      ]),
    );

    // The probe ran on this host, which has a network: a closed port
    // refuses the connection, which is a route, so the verdict must fail it.
    expect(result.text).toContain(
      "Network refusal check (box with no network)",
    );
    expect(result.verdict.targets[0]!.pass).toBe(false);
    expect(result.verdict.targets[0]!.lines).toContain(
      "tcp 127.0.0.1: expected no route (ENETUNREACH or EHOSTUNREACH), got ECONNREFUSED",
    );
    expect(result.verdict.pass).toBe(false);
  }, 30_000);

  it("refuses an lbx without --no-network before anything starts", async () => {
    const bin = mkdtempSync(join(tmpdir(), "agents-net-check-bin-"));
    const scratch = mkdtempSync(join(tmpdir(), "agents-net-check-"));
    onTestFinished(() => {
      rmSync(bin, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    });
    const lbx = writeFakeLbx(bin);
    const launcher = new ProbeLauncher();
    await expect(
      runNetCheck({
        root: makeRepo(),
        scratch,
        identity: WHO,
        launcher,
        lbx,
        env: { PATH: process.env.PATH ?? "", FAKE_LBX_NO_SOCKETS: "1" },
        fixedTargets: [],
        lookup: () => Promise.resolve([]),
      }),
    ).rejects.toThrow(
      `the box starts with no network, but ${lbx} does not offer --socket-dir`,
    );
    expect(launcher.requests).toEqual([]);
  }, 30_000);
});
