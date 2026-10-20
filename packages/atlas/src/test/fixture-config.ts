// An org-shaped config (three environments, three sites, four outlets, a gitops repo) for the tests
// whose expectations were written against a full set of tables.
import { setConfig } from "../config.ts";

export function orgLikeConfig(): void {
  setConfig({
    planes: [
      {
        id: "product",
        label: "Product",
        index: true,
        heading: "## Product plane",
        map: true,
        anchor: [-1180, 120, 0],
      },
      {
        id: "delivery",
        label: "Delivery",
        index: true,
        heading: "## Delivery",
        map: true,
        anchor: [-120, 930, -340],
      },
      { id: "infra", label: "Infra", map: true },
      { id: "external", label: "Third party", map: true },
    ],
    map: {
      environments: [
        { id: "env:dev", label: "dev", role: "dev" },
        { id: "env:staging", label: "staging", role: "staging" },
        { id: "env:live", label: "live", role: "live" },
      ],
      sites: [
        {
          id: "ship:website",
          label: "Website",
          host: "^(www|documents)\\.",
          role: "the site",
        },
        {
          id: "ship:docs",
          label: "Docs sites",
          host: "^docs\\.",
          role: "docs",
        },
        { id: "ship:blog", label: "Blog", host: "^blog\\.", role: "blog" },
      ],
      outlets: [
        { id: "ship:releases", label: "Releases", role: "r" },
        { id: "ship:actions", label: "Action tags", role: "a" },
        { id: "ship:libraries", label: "Libraries", role: "l" },
        { id: "ship:ci", label: "Runs in CI", role: "c" },
      ],
      gitops: { repo: "notes-gitops" },
    },
  });
}
