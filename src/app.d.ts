import type { ScenariosConfig } from "@flax/contract/config";

declare global {
  /** True in the single-file build, which carries its data and routes after a #. */
  const __EXPLORER_SINGLE_FILE__: boolean;
  /** Whether the page follows runs through the explorer service's event stream. */
  const __EXPLORER_LIVE__: boolean;
  /** The workspace's scenario-kit.yaml, baked in at build time. */
  const __FLAX_CONFIG__: ScenariosConfig;
}

export {};
