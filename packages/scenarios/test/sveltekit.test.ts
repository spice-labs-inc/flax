import { describe, expect, it } from "vitest";
import {
  fileRoutes,
  fileSections,
  findTestIds,
  formActions,
  moduleExports,
  parseRouteId,
  parseRoutes,
  routeItems,
  sectionOf,
  testIdItems,
  type SourceFile,
} from "../src/builders/sveltekit.ts";
import type { Sighting } from "../src/lib/types.ts";

const seen = (path: string): Sighting => ({
  source: {
    kind: "repo",
    repo: "acme/example",
    ref: "main",
    commit: "abc1234",
    path,
  },
  readAt: "2026-10-07T00:00:00.000Z",
});
const file = (path: string, text = ""): SourceFile => ({ path, text });

describe("parseRouteId", () => {
  it("drops groups and matchers and records params", () => {
    expect(
      parseRouteId("/(marketing)/blog/[slug=word]/[[lang]]/[...rest]"),
    ).toEqual({
      path: "/blog/[slug]/[[lang]]/[...rest]",
      groups: ["marketing"],
      params: [
        { name: "slug", kind: "required", matcher: "word" },
        { name: "lang", kind: "optional" },
        { name: "rest", kind: "rest" },
      ],
    });
  });

  it("keeps static text around a param and decodes escapes", () => {
    expect(parseRouteId("/app/org-[org_uuid=uuid]").path).toBe(
      "/app/org-[org_uuid]",
    );
    expect(parseRouteId("/a[x+3f]b").path).toBe("/a?b");
    expect(parseRouteId("/").path).toBe("/");
  });
});

describe("parseRoutes", () => {
  const files = [
    file("src/routes/+layout.svelte"),
    file("src/routes/(app)/+layout.ts", "export const ssr = false;"),
    file("src/routes/(app)/items/+page.svelte"),
    file(
      "src/routes/(app)/items/+page.server.ts",
      `import { fail } from "@sveltejs/kit";
export async function load() { return {}; }
export const actions = {
  create: async ({ request }) => { const x = { nested: 1 }; return x; },
  "delete-all": async () => fail(400),
  async archive() {},
} satisfies Actions;`,
    ),
    file("src/routes/(app)/items/[id=uuid]/+page.svelte"),
    file(
      "src/routes/(app)/items/[id=uuid]/+page.server.ts",
      "export const actions = { default: async () => {} };",
    ),
    file(
      "src/routes/api/items/+server.ts",
      `export async function GET() {}
export const POST = async () => {};
const del = () => {};
export { del as DELETE };
export function fallback() {}`,
    ),
    file("src/routes/api/items/+server.spec.ts", "export function PUT() {}"),
    file(
      "src/routes/old/+page.ts",
      `export function load() { redirect(308, resolve("/items/[id=uuid]", { id })); }`,
    ),
    file("src/routes/+error.svelte"),
  ];
  const routes = parseRoutes(files);

  it("lists pages and endpoints, never layouts or error pages", () => {
    expect(routes.map((r) => r.path)).toEqual([
      "/api/items",
      "/items",
      "/items/[id]",
      "/old",
    ]);
  });

  it("reads form actions, loads, groups and endpoint methods", () => {
    const items = routes.find((r) => r.path === "/items");
    expect(items?.groups).toEqual(["app"]);
    expect(items?.page).toMatchObject({
      component: true,
      load: false,
      serverLoad: true,
    });
    expect(items?.page?.actions).toEqual(["create", "delete-all", "archive"]);
    expect(
      routes.find((r) => r.path === "/api/items")?.endpoint?.methods,
    ).toEqual(["GET", "POST", "DELETE", "fallback"]);
  });

  it("follows a component-less page's redirect", () => {
    expect(routes.find((r) => r.path === "/old")?.page).toMatchObject({
      component: false,
      redirectsTo: ["/items/[id]"],
    });
  });

  it("emits one item per page, form action and endpoint method", () => {
    const ids = routeItems(routes, {
      surface: "dashboard",
      envs: ["dev"],
      seen,
    }).map((i) => i.id);
    expect(ids).toEqual([
      "dashboard:endpoint:GET /api/items",
      "dashboard:endpoint:POST /api/items",
      "dashboard:endpoint:DELETE /api/items",
      "dashboard:endpoint:* /api/items",
      "dashboard:route:/items",
      "dashboard:action:/items?/create",
      "dashboard:action:/items?/delete-all",
      "dashboard:action:/items?/archive",
      "dashboard:route:/items/[id]",
      "dashboard:action:/items/[id]?/default",
      "dashboard:route:/old",
    ]);
  });
});

describe("helpers", () => {
  it("moduleExports sees re-exports with their source", () => {
    expect(
      moduleExports(
        `export { load } from "../+page.ts";\nexport const ssr = false;`,
      ),
    ).toEqual([{ name: "ssr" }, { name: "load", from: "../+page.ts" }]);
  });

  it("formActions is empty without an actions export", () => {
    expect(formActions("export function load() {}")).toEqual([]);
  });

  it("sectionOf skips the app base and params", () => {
    expect(sectionOf("/app/[project_uuid]/org/teams/[team_uuid]")).toBe("org");
    expect(sectionOf("/app/[project_uuid]")).toBe("landing");
    expect(sectionOf("/")).toBe("landing");
    expect(sectionOf("/oauth/consent")).toBe("oauth");
  });
});

describe("findTestIds", () => {
  const files = [
    file(
      "src/lib/Picker.svelte",
      `<script lang="ts">let { testid }: { testid: string } = $props();</script>
<button data-testid={testid}>x</button>
<li data-testid="row-{kind}" data-x="1">y</li>
<p data-testid={\`cell-\${a}-\${b}\`}></p>
<p data-testid={open ? "open-thing" : 'closed-thing'}></p>
<p data-testid={label}></p>`,
    ),
    file(
      "src/routes/app/[id=uuid]/+page.svelte",
      `<script>import Picker from "$lib/Picker.svelte";</script>
<Picker testid="picker-a" /><Picker testid={"picker-b"} /><div data-testid="plain"></div>`,
    ),
    file(
      "src/lib/props.ts",
      `export const attrs = { "data-testid": "from-ts", other: 1 };`,
    ),
    file("src/lib/Other.svelte", `<Unrelated testid="not-a-picker" />`),
    file(
      "src/lib/Picker.spec.ts",
      `getByTestId("spec-only"); const x = '<a data-testid="spec-only">';`,
    ),
  ];
  const hits = findTestIds(files);
  const items = testIdItems(hits, {
    surface: "dashboard",
    envs: ["dev"],
    seen,
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  it("finds static, interpolated, template and conditional ids", () => {
    expect([...byId.keys()].sort()).toEqual([
      "dashboard:testid:*",
      "dashboard:testid:cell-*-*",
      "dashboard:testid:closed-thing",
      "dashboard:testid:from-ts",
      "dashboard:testid:open-thing",
      "dashboard:testid:picker-a",
      "dashboard:testid:picker-b",
      "dashboard:testid:plain",
      "dashboard:testid:row-*",
    ]);
    expect(byId.get("dashboard:testid:row-*")?.details).toMatchObject({
      dynamic: true,
    });
    expect(byId.get("dashboard:testid:open-thing")?.details).toMatchObject({
      dynamic: false,
    });
  });

  it("resolves prop-forwarded ids at the call site, only for files that use the component", () => {
    const a = byId.get("dashboard:testid:picker-a");
    expect(a?.area).toBe("/app/[id]");
    expect(a?.details).toMatchObject({
      via: ["src/lib/Picker.svelte"],
      files: ["src/lib/Picker.svelte", "src/routes/app/[id=uuid]/+page.svelte"],
    });
    expect(byId.has("dashboard:testid:not-a-picker")).toBe(false);
  });

  it("keeps an id it cannot resolve, as a dynamic wildcard with its expression", () => {
    expect(byId.get("dashboard:testid:*")?.details).toMatchObject({
      dynamic: true,
      expressions: ["label"],
    });
  });
});

describe("parse edge cases", () => {
  it("formActions reads keys behind leading comments", () => {
    expect(
      formActions(`export const actions = {
  // creates one
  create: async () => {},
  /* removes, see #12 */ remove: async () => {},
  /** docs */
  async rename() {},
};`),
    ).toEqual(["create", "remove", "rename"]);
  });

  it("moduleExports reads destructured exports", () => {
    expect(
      moduleExports(
        "export const { GET, POST: post, DELETE = del, ...rest } = handlers;",
      ).map((e) => e.name),
    ).toEqual(["GET", "post", "DELETE", "rest"]);
  });

  it("keeps a matcher in the id only when two routes would share a URL", () => {
    const routes = parseRoutes([
      file("src/routes/a/[id=uuid]/+page.svelte"),
      file("src/routes/a/[id=int]/+page.svelte"),
      file("src/routes/b/[id=uuid]/+page.svelte"),
    ]);
    expect(routes.map((r) => r.path)).toEqual([
      "/a/[id=int]",
      "/a/[id=uuid]",
      "/b/[id]",
    ]);
  });
});

describe("test id expressions", () => {
  const hits = findTestIds([
    file(
      "src/lib/Row.svelte",
      `<li data-testid={"row-" + id}></li>
<li data-testid={prefix + "-cell-" + n}></li>
<li data-testid="a-{fn({ x: 1 })}-b"></li>
<li data-testid={c ? "one" : fn(x)}></li>
<li data-testid={(c && "maybe") || "never"}></li>
<button data-testid=save-btn>Save</button>
<button class="x" data-testid=row-{id}/>
<script>const sel = "[data-testid=not-an-attr]";</script>`,
    ),
  ]);
  const byValue = new Map(hits.map((h) => [h.value, h]));

  it("treats any non-literal part as dynamic", () => {
    expect(byValue.get("row-*")).toMatchObject({ dynamic: true });
    expect(byValue.get("*-cell-*")).toMatchObject({ dynamic: true });
    expect(byValue.has("row-")).toBe(false);
  });

  it("handles nested braces inside a quoted interpolation", () => {
    expect(byValue.get("a-*-b")).toMatchObject({ dynamic: true });
  });

  it("splits conditionals and keeps the expression of a wildcard arm", () => {
    expect(byValue.get("one")).toMatchObject({ dynamic: false });
    expect(byValue.get("*")).toMatchObject({
      dynamic: true,
      expression: "fn(x)",
    });
    expect(byValue.get("maybe")).toMatchObject({ dynamic: false });
    expect(byValue.get("never")).toMatchObject({ dynamic: false });
  });

  it("accepts unquoted attribute values, never a selector in a string", () => {
    expect(byValue.get("save-btn")).toMatchObject({ dynamic: false });
    expect(hits.filter((h) => h.value === "row-*")).toHaveLength(2);
    expect(byValue.has("not-an-attr")).toBe(false);
  });
});

describe("fileSections", () => {
  const files = [
    file(
      "src/routes/app/+layout.svelte",
      `<script>import TopBar from "$lib/shell/TopBar.svelte";</script>`,
    ),
    file(
      "src/routes/app/[p=uuid]/surveys/+page.svelte",
      `<script>import Table from "$lib/Table.svelte"; import Local from "./Local.svelte";</script>`,
    ),
    file("src/routes/app/[p=uuid]/surveys/Local.svelte"),
    file(
      "src/routes/app/[p=uuid]/reports/+page.svelte",
      `<script>import Table from "$lib/Table.svelte"; import type { T } from "$lib/types";</script>`,
    ),
    file(
      "src/lib/Table.svelte",
      `<script>import { fmt } from "./format";</script><td data-testid="cell"></td>`,
    ),
    file("src/lib/format.ts"),
    file("src/lib/types.ts"),
    file("src/lib/shell/TopBar.svelte", `<nav data-testid="top-bar"></nav>`),
    file("src/lib/Orphan.svelte", `<p data-testid="orphan"></p>`),
  ];
  const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const sections = fileSections(files, label);

  it("follows $lib and relative imports from pages and layouts", () => {
    expect(sections.get("src/lib/Table.svelte")).toEqual([
      "Reports",
      "Surveys",
    ]);
    expect(sections.get("src/lib/format.ts")).toEqual(["Reports", "Surveys"]);
    expect(
      sections.get("src/routes/app/[p=uuid]/surveys/Local.svelte"),
    ).toEqual(["Surveys"]);
    expect(sections.get("src/lib/shell/TopBar.svelte")).toEqual(["Navigation"]);
    expect(sections.has("src/lib/types.ts")).toBe(false);
  });

  it("names test id areas by section, shared, navigation or unused", () => {
    const items = testIdItems(findTestIds(files), {
      surface: "dashboard",
      envs: ["dev"],
      seen,
      fileSections: sections,
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get("dashboard:testid:cell")).toMatchObject({
      area: "Shared across sections",
      details: { sections: ["Reports", "Surveys"] },
    });
    expect(byId.get("dashboard:testid:top-bar")?.area).toBe("Navigation");
    expect(byId.get("dashboard:testid:orphan")?.area).toBe(
      "Not used by any page",
    );
  });

  it("makes a test id one page renders that page's child, and lists the pages of a shared one", () => {
    const withLocal = [
      ...files,
      file(
        "src/routes/app/[p=uuid]/surveys/Local.svelte",
        `<p data-testid="local"></p>`,
      ),
    ].filter((f, i, all) => all.findLastIndex((g) => g.path === f.path) === i);
    const items = testIdItems(findTestIds(withLocal), {
      surface: "dashboard",
      envs: ["dev"],
      seen,
      fileSections: fileSections(withLocal, label),
      fileRoutes: fileRoutes(withLocal, parseRoutes(withLocal), "dashboard"),
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get("dashboard:testid:local")?.parent).toBe(
      "dashboard:route:/app/[p]/surveys",
    );
    expect(byId.get("dashboard:testid:cell")).toMatchObject({
      details: {
        usedBy: [
          "dashboard:route:/app/[p]/reports",
          "dashboard:route:/app/[p]/surveys",
        ],
      },
    });
    expect(byId.get("dashboard:testid:cell")?.parent).toBeUndefined();
    expect(byId.get("dashboard:testid:top-bar")?.parent).toBeUndefined();
    expect(
      byId.get("dashboard:testid:top-bar")?.details?.["usedBy"],
    ).toBeUndefined();
  });

  it("names route areas through the section label and keeps the raw section", () => {
    const items = routeItems(parseRoutes(files), {
      surface: "dashboard",
      envs: ["dev"],
      seen,
      sectionLabel: label,
    });
    expect(items.find((i) => i.id.endsWith("/surveys"))).toMatchObject({
      area: "Surveys",
      details: { section: "surveys" },
    });
  });
});
