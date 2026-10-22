import { promises as dns } from "node:dns";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * The in-box half of the network refusal check. It runs inside the run box
 * (not Pi), tries to reach each target every way a misled agent could, and
 * records what happened. It imports only Node's own modules, because it is
 * bundled into one file and run with the box's node.
 */

export interface Target {
  /** What the target is, for the report, such as "kubernetes prod". */
  name: string;
  host: string;
  port: number;
  /** IPv4 addresses the runner resolved outside the box, to try without DNS. */
  addresses: string[];
}

export interface ProbePlan {
  targets: Target[];
  timeoutMs: number;
  /** Name servers for the direct DNS query; the box's own when not set. */
  dnsServers?: string[];
}

export type Outcome = "blocked" | "reached";

export interface Attempt {
  /** dns-lookup, dns-query, tcp <address> or tcp-by-name. */
  kind: string;
  outcome: Outcome;
  detail: string;
}

export interface TargetResult {
  name: string;
  host: string;
  port: number;
  attempts: Attempt[];
}

/** A network interface address the box has; an interface without one is not listed. */
export interface InterfaceAddress {
  name: string;
  address: string;
  /** Loopback. */
  internal: boolean;
}

export interface ProbeResult {
  /** The proxy the box's proxy variables name; null when they name none. */
  proxy: string | null;
  interfaces: InterfaceAddress[];
  loopback: Attempt;
  targets: TargetResult[];
}

export function interfaceAddresses(
  found: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): InterfaceAddress[] {
  return Object.entries(found).flatMap(([name, addresses]) =>
    (addresses ?? []).map((a) => ({
      name,
      address: a.address,
      internal: a.internal,
    })),
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function reason(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return e.code ?? e.message ?? String(err);
}

/** Opens a TCP connection and closes it at once. */
function tcp(host: string, port: number, timeoutMs: number): Promise<Attempt> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (outcome: Outcome, detail: string) => {
      socket.destroy();
      resolve({ kind: "", outcome, detail });
    };
    socket.setTimeout(timeoutMs, () => done("blocked", "timed out"));
    socket.once("connect", () => done("reached", "connected"));
    socket.once("error", (err) => done("blocked", reason(err)));
  });
}

async function dnsLookup(host: string, timeoutMs: number): Promise<Attempt> {
  try {
    const found = await withTimeout(
      dns.lookup(host, { all: true }),
      timeoutMs,
      "lookup",
    );
    return {
      kind: "dns-lookup",
      outcome: "reached",
      detail: `resolved to ${found.map((a) => a.address).join(", ")}`,
    };
  } catch (err) {
    return { kind: "dns-lookup", outcome: "blocked", detail: reason(err) };
  }
}

async function dnsQuery(
  host: string,
  timeoutMs: number,
  servers: string[] | undefined,
): Promise<Attempt> {
  const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
  if (servers !== undefined) resolver.setServers(servers);
  try {
    const found = await withTimeout(
      resolver.resolve4(host),
      timeoutMs + 500,
      "query",
    );
    return {
      kind: "dns-query",
      outcome: "reached",
      detail: `answered ${found.join(", ")}`,
    };
  } catch (err) {
    resolver.cancel();
    return { kind: "dns-query", outcome: "blocked", detail: reason(err) };
  }
}

/** The proxy the box's proxy variables name, if any. */
export function proxyOf(env: NodeJS.ProcessEnv): string | undefined {
  const raw =
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  return raw === undefined || raw === "" ? undefined : raw;
}

/** Proves the probe can connect at all: a listener on loopback inside the box. */
async function loopback(timeoutMs: number): Promise<Attempt> {
  const server = createServer((s) => s.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    const attempt = await tcp("127.0.0.1", port, timeoutMs);
    return { ...attempt, kind: "loopback" };
  } finally {
    server.close();
  }
}

async function probeTarget(
  target: Target,
  plan: ProbePlan,
): Promise<TargetResult> {
  const timeoutMs = plan.timeoutMs;
  const attempts = await Promise.all([
    dnsLookup(target.host, timeoutMs),
    dnsQuery(target.host, timeoutMs, plan.dnsServers),
    ...target.addresses.map(async (address) => ({
      ...(await tcp(address, target.port, timeoutMs)),
      kind: `tcp ${address}`,
    })),
    tcp(target.host, target.port, timeoutMs).then((a) => ({
      ...a,
      kind: "tcp-by-name",
    })),
  ]);
  return { name: target.name, host: target.host, port: target.port, attempts };
}

export async function probe(
  plan: ProbePlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProbeResult> {
  const [loop, targets] = await Promise.all([
    loopback(plan.timeoutMs),
    Promise.all(plan.targets.map((t) => probeTarget(t, plan))),
  ]);
  return {
    proxy: proxyOf(env) ?? null,
    interfaces: interfaceAddresses(),
    loopback: loop,
    targets,
  };
}
