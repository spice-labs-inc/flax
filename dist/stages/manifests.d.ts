import type { Stage } from '../pipeline/machine.ts';
export interface DependencyDrift {
    repo: string;
    /** Named in code but absent from the doc's depends_on. */
    undeclared: Array<{
        target: string;
        sources: string[];
    }>;
    /** Declared in frontmatter but named by no manifest, workflow or module. */
    unverified: string[];
}
export interface ManifestResult {
    /** repo -> target -> how it was found */
    derived: Record<string, Record<string, string[]>>;
    drift: DependencyDrift[];
    /** Repos with no checkout available, so nothing could be verified. */
    unchecked: string[];
}
export declare const manifests: Stage;
