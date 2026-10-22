// esbuild defines this in the bundles under dist/ (src/bundle/build.ts) as the repository root, relative to the bundle file.
declare const FLAX_AGENTS_BUNDLE_ROOT: string | undefined;

/** The repository root relative to the running bundle, or undefined when running from source. */
export const BUNDLE_ROOT: string | undefined =
  typeof FLAX_AGENTS_BUNDLE_ROOT === "string"
    ? FLAX_AGENTS_BUNDLE_ROOT
    : undefined;

// esbuild also defines the agent Dockerfile's text in the bundles: the agent-image check runs in a preflight before a
// workspace installs its packages, so the file cannot be read from the package then.
declare const FLAX_AGENTS_BUNDLED_AGENT_DOCKERFILE: string | undefined;

/** The agent Dockerfile's text inside a bundle, or undefined when running from source. */
export const BUNDLED_AGENT_DOCKERFILE: string | undefined =
  typeof FLAX_AGENTS_BUNDLED_AGENT_DOCKERFILE === "string"
    ? FLAX_AGENTS_BUNDLED_AGENT_DOCKERFILE
    : undefined;
