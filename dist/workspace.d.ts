export declare const WORKSPACE_FILE = "flax.yml";
export interface Environment {
    id: string;
    label?: string;
}
export interface Workspace {
    /** Absolute path of the workspace directory. */
    dir: string;
    /** Short organization name used in defaults and titles (never an internal codename). */
    org: string;
    /** GitHub owner the workspace's repositories live under, when any. */
    github?: string;
    /** Environments in order: the first one is the reference environment. */
    environments: Environment[];
    /** Per-package sections, left untyped here; each package validates its own. */
    sections: Record<string, unknown>;
}
export declare class WorkspaceError extends Error {
}
export declare function parseWorkspace(text: string, dir: string): Workspace;
export declare function loadWorkspace(dir: string): Workspace;
/** The section a package owns, or an empty mapping when the workspace has none. */
export declare function section(workspace: Workspace, name: string): Record<string, unknown>;
