import type { Opener } from "../nav.ts";

/** The search palette is one for the whole site: any page opens it, and a closed scenario can reopen it where it was. */
export const search = $state<{
  open: boolean;
  resume: { query: string; selected: number } | null;
  /** What a navigation the palette started should be remembered as, until the explorer lands on it. */
  pending: Opener | null;
}>({ open: false, resume: null, pending: null });
