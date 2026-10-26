/** Where scheduled runs leave their results as GitHub workflow artifacts, for the service's fallback and the refresh. */
export interface ResultsSource {
    /** `owner/name` of the repository whose workflow uploads the artifacts. */
    repo: string;
    /** The workflow file name, for listing runs in progress. */
    workflow: string;
    /** The job name the artifacts are named after: `<job>-<env>`, `<job>-shadow-<env>`. */
    job: string;
    /** More jobs whose artifacts carry results under the same names, such as a slower cadence's own job. */
    extraJobs: string[];
}
export interface ExplorerConfig {
    title: string;
    description: string;
    /** The port the service listens on. */
    port: number;
    results: ResultsSource | null;
}
/** The `explorer:` section of flax.yml with defaults; the shared keys give the repo its default owner. */
export declare function explorerConfig(dir?: string): ExplorerConfig;
