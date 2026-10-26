import {
  createModel,
  DATA_FILES,
  dataFiles,
  type DataFileName,
  type Manifest,
} from "$lib/model.ts";
import { USAGE_FILE } from "@flax/contract";
import type { LayoutLoad } from "./$types";

export const ssr = false;
export const prerender = false;

type Fetch = typeof fetch;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function manifestOf(v: unknown): Manifest {
  if (
    !isObject(v) ||
    typeof v["version"] !== "string" ||
    !/^[\w.-]{1,80}$/.test(v["version"]) ||
    typeof v["builtAt"] !== "string"
  )
    throw new Error("the data manifest names no version");
  return { version: v["version"], builtAt: v["builtAt"] };
}

/** The single-file page carries its data in a script element the build writes. */
function embedded(): {
  manifest: Manifest;
  raw: Record<DataFileName, unknown>;
} {
  const text = document.getElementById("explorer-data")?.textContent;
  const v: unknown = text ? JSON.parse(text) : undefined;
  if (!isObject(v) || !isObject(v["files"]))
    throw new Error("this page was built without its data");
  const files = v["files"];
  return {
    manifest: manifestOf(v["manifest"]),
    raw: Object.fromEntries(
      DATA_FILES.map((n) => [n, files[n] ?? null]),
    ) as Record<DataFileName, unknown>,
  };
}

async function fetched(
  fetch: Fetch,
): Promise<{ manifest: Manifest; raw: Record<DataFileName, unknown> }> {
  const res = await fetch("/data/manifest.json", { cache: "no-store" });
  if (res.status === 404)
    throw new Error(
      "The explorer has no data yet: its service has not built any.",
    );
  if (!res.ok) throw new Error(`The data manifest answered ${res.status}.`);
  const manifest = manifestOf(await res.json());
  const bodies = await Promise.all(
    DATA_FILES.map(async (name) => {
      const r = await fetch(`/data/${manifest.version}/${name}`);
      // A data version built before usage.json existed has none: no usage history, the same as null.
      if (r.status === 404 && name === USAGE_FILE) return [name, null] as const;
      if (!r.ok) throw new Error(`${name} answered ${r.status}.`);
      return [name, (await r.json()) as unknown] as const;
    }),
  );
  return {
    manifest,
    raw: Object.fromEntries(bodies) as Record<DataFileName, unknown>,
  };
}

export const load: LayoutLoad = async ({ fetch, depends }) => {
  depends("explorer:data");
  try {
    const { manifest, raw } = __EXPLORER_SINGLE_FILE__
      ? embedded()
      : await fetched(fetch);
    const base = __EXPLORER_SINGLE_FILE__ ? "" : `/data/${manifest.version}`;
    return {
      manifest,
      model: createModel(dataFiles(raw, base)),
      problem: null,
    };
  } catch (e) {
    return {
      manifest: null,
      model: null,
      problem: e instanceof Error ? e.message : "The data did not load.",
    };
  }
};
