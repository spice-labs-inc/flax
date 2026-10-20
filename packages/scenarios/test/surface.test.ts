import { describe, expect, it } from "vitest";
import { isCommitSha } from "../src/lib/repo.ts";
import { mergeItems, requiredEnvs } from "../src/lib/surface.ts";
import type { Env, Sighting, SurfaceItem } from "../src/lib/types.ts";

const at = (env?: Env): Sighting => ({
  ...(env ? { env } : {}),
  source: { kind: "url", url: `https://example.test/${env ?? "repo"}` },
  readAt: "2026-10-07T00:00:00.000Z",
});

const reading = (
  env: Env | undefined,
  label: string,
  details: Record<string, unknown>,
): SurfaceItem => ({
  id: "api:GET /x",
  label,
  surface: "api",
  area: `area ${label}`,
  envs: env ? [env] : [],
  seen: [at(env)],
  details,
});

describe("mergeItems", () => {
  const [merged] = mergeItems([
    reading("dev", "dev", { a: 1, onlyDev: true }),
    reading(undefined, "source", { a: 0 }),
    reading("prod", "prod", { a: 3 }),
    reading("staging", "staging", { a: 2, onlyStaging: true }),
  ]);

  it("takes label, area and details whole from the prod reading", () => {
    expect(merged).toMatchObject({
      label: "prod",
      area: "area prod",
      details: { a: 3 },
    });
    expect(merged?.details).not.toHaveProperty("onlyStaging");
  });

  it("sorts env-less sightings first, then by env", () => {
    expect(merged?.seen.map((s) => s.env ?? "none")).toEqual([
      "none",
      "prod",
      "staging",
      "dev",
    ]);
    expect(merged?.envs).toEqual(["prod", "staging", "dev"]);
  });

  it("falls back to staging, then dev, then the first env-less reading", () => {
    expect(
      mergeItems([
        reading(undefined, "first", {}),
        reading("dev", "dev", {}),
        reading(undefined, "second", {}),
      ])[0]?.label,
    ).toBe("dev");
    expect(
      mergeItems([
        reading(undefined, "first", {}),
        reading(undefined, "second", {}),
      ])[0]?.label,
    ).toBe("first");
  });
});

describe("requiredEnvs", () => {
  it("drops only envs that were read and lack the item", () => {
    const lacks = new Map<Env, (id: string) => boolean>([
      ["staging", (id) => id === "gone"],
    ]);
    expect(requiredEnvs("gone", lacks)).toEqual(["prod", "dev"]);
    expect(requiredEnvs("kept", lacks)).toEqual(["prod", "staging", "dev"]);
  });
});

describe("isCommitSha", () => {
  it("takes only full 40-character SHAs, which need a fetch instead of a clone", () => {
    expect(isCommitSha("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(isCommitSha("0123456")).toBe(false);
    expect(isCommitSha("main")).toBe(false);
    expect(isCommitSha("v1.2.3")).toBe(false);
  });
});
