import type { Attempt, ProbeResult, Target } from "./probe.ts";

export interface TargetVerdict {
  name: string;
  host: string;
  port: number;
  pass: boolean;
  /** One entry per attempt. */
  lines: string[];
}

/** What a connection to an address fails with when the box has no route at all. */
export const NO_ROUTE = ["ENETUNREACH", "EHOSTUNREACH"] as const;

export interface CheckVerdict {
  pass: boolean;
  controls: string[];
  targets: TargetVerdict[];
  problems: string[];
}

function describe(a: Attempt): string {
  return `${a.kind}: ${a.outcome} (${a.detail})`;
}

/**
 * Decides the check from what the probe saw in a box started with no
 * network (lbx --no-network), as every job run is. Every attempt to reach a
 * target must be blocked, and every connection to an address must fail with
 * no route. The probe must reach a listener on loopback, which proves it can
 * tell reached from blocked; the box must have no address besides loopback,
 * and its proxy variables must name no proxy.
 */
export function judge(
  targets: readonly Target[],
  result: ProbeResult | undefined,
): CheckVerdict {
  const problems: string[] = [];
  if (result === undefined)
    return {
      pass: false,
      controls: [],
      targets: targets.map((t) => ({
        name: t.name,
        host: t.host,
        port: t.port,
        pass: false,
        lines: ["the probe gave no result"],
      })),
      problems: ["the probe in the box gave no result"],
    };
  const controls = [`loopback: ${describe(result.loopback)}`];
  if (result.loopback.outcome !== "reached")
    problems.push(
      "the probe could not reach a listener on loopback, so its refusals prove nothing",
    );
  if (result.proxy !== null)
    problems.push(
      `the box was started with no network, but its proxy variables name a proxy (${result.proxy})`,
    );
  const interfaces = Array.isArray(result.interfaces)
    ? result.interfaces
    : undefined;
  if (interfaces === undefined)
    problems.push("the probe did not report the box's network interfaces");
  else {
    controls.push(
      `addresses in the box: ${interfaces.map((i) => `${i.name} ${i.address}`).join(", ") || "none"}`,
    );
    const outside = interfaces.filter((i) => !i.internal);
    if (outside.length > 0)
      problems.push(
        `the box was started with no network, but has an address besides loopback: ${outside.map((i) => `${i.name} ${i.address}`).join(", ")}`,
      );
  }

  const verdicts = targets.map((t): TargetVerdict => {
    const got = result.targets.find(
      (r) => r.host === t.host && r.port === t.port,
    );
    if (got === undefined)
      return {
        name: t.name,
        host: t.host,
        port: t.port,
        pass: false,
        lines: ["not probed"],
      };
    const lines = got.attempts.map(describe);
    let pass = got.attempts.every((a) => a.outcome !== "reached");
    for (const a of got.attempts) {
      if (
        a.kind.startsWith("tcp ") &&
        a.outcome === "blocked" &&
        !(NO_ROUTE as readonly string[]).includes(a.detail)
      ) {
        pass = false;
        lines.push(
          `${a.kind}: expected no route (${NO_ROUTE.join(" or ")}), got ${a.detail}`,
        );
      }
    }
    return { name: t.name, host: t.host, port: t.port, pass, lines };
  });
  return {
    pass: problems.length === 0 && verdicts.every((v) => v.pass),
    controls,
    targets: verdicts,
    problems,
  };
}

/** The verdict as the job log shows it: PASS or FAIL per target, then the controls. */
export function formatVerdict(v: CheckVerdict): string {
  const out = ["Network refusal check (box with no network)", ""];
  for (const t of v.targets) {
    out.push(`${t.pass ? "PASS" : "FAIL"}  ${t.name} (${t.host}:${t.port})`);
    for (const line of t.lines) out.push(`        ${line}`);
  }
  out.push("", "Controls:", ...v.controls.map((c) => `  ${c}`));
  if (v.problems.length > 0)
    out.push("", "Problems:", ...v.problems.map((p) => `  ${p}`));
  out.push("", v.pass ? "PASS: every target was refused" : "FAIL");
  return `${out.join("\n")}\n`;
}
