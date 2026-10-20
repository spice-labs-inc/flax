import { describe, expect, it } from "vitest";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { stringify } from "yaml";
import { linkHostsCheck } from "../src/check/link-hosts.ts";
import { hostAllowed, loadLinkHosts } from "../src/lib/link-hosts.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { makeRepo, run } from "./helpers.ts";

const FILE = "link-hosts.yml";

function hostsFile(overrides: Record<string, unknown> = {}): string {
  return stringify({
    max_query_length: 64,
    long_query_hosts: ["github.com"],
    hosts: ["github.com/notes-co", "*.notes-co.example"],
    ...overrides,
  });
}

describe("link-hosts.yml", () => {
  it("accepts this repository's file, which opens github.com only under notes-co", async () => {
    expect(await run(linkHostsCheck, makeRepo())).toEqual([]);
    const { hosts } = loadLinkHosts(FIXTURE_WORKSPACE);
    if (hosts === undefined) throw new Error("link-hosts.yml does not load");
    expect(hostAllowed(hosts, "github.com", "/notes-co/backend")).toBe(
      true,
    );
    expect(hostAllowed(hosts, "github.com", "/other/backend")).toBe(false);
    expect(
      hostAllowed(hosts, "maven.pkg.github.com", "/notes-co/widget"),
    ).toBe(true);
    expect(hostAllowed(hosts, "maven.pkg.github.com", "/other/x")).toBe(false);
    expect(hostAllowed(hosts, "docs.notes-co.example", "/")).toBe(true);
    expect(hostAllowed(hosts, "a.b.notes-labs.dev", "/")).toBe(true);
    expect(hostAllowed(hosts, "notes-co.example.attacker.example", "/")).toBe(
      false,
    );
    expect(hostAllowed(hosts, "evilnotes-co.example", "/")).toBe(false);
    expect(hostAllowed(hosts, "notes-co.example", "/")).toBe(true);
    expect(hostAllowed(hosts, "a.b.notes-co.example", "/")).toBe(true);
    expect(hostAllowed(hosts, "notes-co.org", "/")).toBe(false);
  });

  it("is required", async () => {
    expect(await run(linkHostsCheck, makeRepo({ linkHosts: null }))).toEqual([
      `${FILE}: is missing`,
    ]);
  });

  it("refuses wildcards over a whole top-level domain, schemes, ports and unknown keys", async () => {
    const problems = async (text: string) =>
      run(linkHostsCheck, makeRepo({ linkHosts: text }));
    for (const bad of [
      "*.io",
      "https://docs.notes-co.example",
      "docs.notes-co.example:8443",
      "Docs.NotesCo.io",
      "docs.notes-co.example.",
      "*",
    ])
      expect(await problems(hostsFile({ hosts: [bad] }))).toHaveLength(1);
    expect(await problems(hostsFile({ max_query_length: 1000 }))).toHaveLength(
      1,
    );
    expect(await problems(hostsFile({ extra: true }))).toHaveLength(1);
    expect(await problems("hosts: [")).toEqual([
      expect.stringMatching(/^link-hosts\.yml: is not valid YAML/),
    ]);
  });
});
