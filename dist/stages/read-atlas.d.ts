import type { Stage } from '../pipeline/machine.ts';
export { parseSections } from '../atlas/doc.ts';
export interface AtlasDoc {
    name: string;
    file: string;
    fm: Record<string, string | string[]>;
    sections: Record<string, string>;
}
export interface AtlasRead {
    repos: AtlasDoc[];
    architecture: string;
    machines: string;
    index: string;
}
export declare const readAtlas: Stage;
