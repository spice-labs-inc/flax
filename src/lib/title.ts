import { SURFACE_TITLE } from "./features.ts";
import { paragraphs } from "./features/catalog.ts";
import type { Route } from "./location.ts";
import type { Model } from "./model.ts";

/** What a tab, a bookmark and a pasted link call a place: the object on show, and a sentence about it. */
export interface PageMeta {
  title: string;
  description: string;
}

import { CONFIG, envsProse } from "./data.ts";

export const SITE = CONFIG.branding.title;

export const SITE_DESCRIPTION = CONFIG.branding.description;

const DOOR: Record<Route["view"], PageMeta> = {
  now: {
    title: "Now",
    description: `What is failing on ${envsProse(undefined, true)} right now, and what changed in the latest runs.`,
  },
  features: {
    title: "Features",
    description: `Every feature of the product in its own words, with the scenarios that verify it on ${envsProse(undefined, true)}.`,
  },
  personas: {
    title: "Personas",
    description:
      "Who the product serves, how much of each persona's journey is verified, and where the gaps are.",
  },
  planned: {
    title: "Planned",
    description:
      "Features on the Engineering Board that are not built yet, and the scenarios written ahead of them.",
  },
  map: {
    title: "Surface map",
    description:
      "Every API operation, page and flag of the product as a hex, colored by what the scenarios verify.",
  },
};

export const GLOSSARY_META: PageMeta = {
  title: "Glossary",
  description: `The words the ${SITE} explorer uses, and what each one means.`,
};

const verifiedOn = `on ${envsProse(undefined, true)}`;

export function pageMeta(r: Route, m: Model): PageMeta {
  if (r.view === "features") {
    if (r.feature) {
      const f = m.featureAt(r.feature);
      if (!f)
        return {
          title: "No feature at this address",
          description: DOOR.features.description,
        };
      return {
        title: f.name,
        description:
          paragraphs(f.description)[0] ??
          `A ${SURFACE_TITLE[f.surface]} feature and the scenarios that verify it ${verifiedOn}.`,
      };
    }
    const g = m.featureGroups.find((x) => x.surface === r.surface);
    if (g)
      return {
        title: `${g.title} features`,
        description: `The ${g.title} features in the product's own words, with the scenarios that verify them ${verifiedOn}.`,
      };
    if (r.q)
      return {
        title: `Features matching "${r.q}"`,
        description: DOOR.features.description,
      };
    return DOOR.features;
  }
  if (r.view === "personas") {
    const p = m.personas.find((x) => x.id === r.persona);
    const st = p?.stations.find((x) => x.key === r.station);
    if (p && st)
      return {
        title: `${st.name}, ${p.name}`,
        description: `The ${st.name} station on the ${p.name} journey, and what verifies it ${verifiedOn}.`,
      };
    if (p) return { title: p.name, description: p.def.summary };
    if (r.lines)
      return {
        title: "Journey lines",
        description:
          "Each persona's journey through the product, station by station, with what is verified at each stop.",
      };
    if (r.gaps)
      return {
        title: "Gaps",
        description:
          "Stations on a persona's journey that no scenario verifies yet, and what is planned for them.",
      };
    if (r.orphans)
      return {
        title: "On no persona's journey",
        description:
          "Things a customer can touch that no persona's journey passes through yet.",
      };
    return DOOR.personas;
  }
  if (r.view === "map") {
    if (r.scenario) {
      const d = m.detailOf(r.scenario);
      const f = m.featureOf(r.scenario);
      if (d)
        return {
          title: d.name,
          description: `A scenario of ${f ? `"${f.name}"` : "the product"}: its steps and its runs ${verifiedOn}.`,
        };
    }
    const it = r.itemId ? m.items.find((x) => x.id === r.itemId) : undefined;
    if (it?.planned?.kind === "issue")
      return {
        title: it.label,
        description:
          "An open issue on the Engineering Board for a feature not built yet.",
      };
    if (it?.planned?.kind === "scenario")
      return {
        title: it.label,
        description:
          "A scenario written and waiting for the feature it describes to be built.",
      };
    if (it)
      return {
        title: it.label,
        description: `Where ${it.label} stands ${verifiedOn}, and the scenarios that verify it.`,
      };
    const holder = r.inside
      ? m.items.find((x) => x.id === r.inside)
      : undefined;
    if (holder) {
      const name = m.insideOf(holder)?.info.title ?? holder.label;
      return {
        title: r.area ? `${r.area}, ${name}` : name,
        description: `What ${name} holds, each part as a hex colored by what the scenarios verify.`,
      };
    }
    const surface =
      m.surfaces.find((s) => s.island === r.surface)?.title ??
      m.featureGroups.find((g) => g.surface === r.surface)?.title;
    if (surface)
      return {
        title: r.area ? `${r.area}, ${surface}` : surface,
        description: `${surface} on the surface map, each part as a hex colored by what the scenarios verify.`,
      };
  }
  return DOOR[r.view];
}
