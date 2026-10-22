export type Yaml = string | number | boolean | null | Yaml[] | {
    [k: string]: Yaml;
};
export declare function parseYaml(text: string): Yaml;
