import { type KeyObject } from "node:crypto";
/** What the service asks of GitHub; the tests stand in for it. */
export interface GitHub {
    json(path: string): Promise<unknown>;
    download(path: string, maxBytes: number): Promise<Buffer>;
    graphql(query: string): Promise<unknown>;
}
/** The app's private key from the environment: the PEM itself (newlines as \n allowed, so it fits one .env line) or base64 of the PEM. */
export declare function appKey(raw: string): KeyObject;
/** A GitHub App JWT, valid for 9 minutes from a minute ago (GitHub allows 10 and clocks drift). */
export declare function appJwt(appId: string, key: KeyObject, now: number): string;
/** GitHub as the reader app's installation on this repository: hour-long installation tokens, renewed 5 minutes early. */
export declare class AppGitHub implements GitHub {
    #private;
    constructor(appId: string, key: KeyObject, repo: string, f?: typeof fetch);
    json(path: string): Promise<unknown>;
    graphql(query: string): Promise<unknown>;
    download(path: string, maxBytes: number): Promise<Buffer>;
}
