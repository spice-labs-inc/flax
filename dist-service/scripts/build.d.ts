import { DATA_FILES, type BoardFile, type DataFileName } from "@flax/contract";
export { DATA_FILES, type DataFileName };
export interface BuildInput {
    /** The workspace: surface/, features/, personas/, journeys/ (paths from the config). */
    root: string;
    /** `<env>/<run id>/` directories as `pnpm results:fetch` leaves them. */
    resultsDir: string;
    /** The workspace commit the dataset is at. */
    commit: string;
    now: string;
    board: BoardFile;
    /** The usage history the service keeps (@flax/contract/usage); without it, the file flax.yml names under explorer.usage.history, if any. */
    usage?: unknown;
    /** Downscales failure screenshots in headless Chromium; without it they stay full size. */
    shrink?: <T extends {
        mediaType: string;
        base64: string;
    }>(shots: T[]) => Promise<{
        shots: T[];
        shrunk: boolean;
    }>;
    log: (line: string) => void;
}
export declare class NoRuns extends Error {
}
/** Every data file, built from the dataset and the runs on disk; throws when the dataset has errors or there are no runs. */
export declare function buildData(input: BuildInput): Promise<Record<DataFileName, unknown>>;
/** The files into `dir`, each screenshot as its own image under shots/ so shots.json only names a path per key. */
export declare function writeData(dir: string, data: Record<DataFileName, unknown>): void;
export declare const SHOT_EXT: Record<string, string>;
/** shots.json with each image file read back in as a data URL, for a page that carries its data inside it. */
export declare function inlineShots(dir: string): Record<string, string>;
/** The board with each issue's state from a boardQuery answer; an issue the answer does not name is unknown. */
export declare function withBoardStates(board: BoardFile, answer: unknown, checkedAt: string): BoardFile;
