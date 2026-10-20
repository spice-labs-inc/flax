/** Whether a failure message says the runner never reached the env: a name that did not resolve, a refused or dropped connection. Shared by the data build and the page, so it imports nothing of either. */
export declare function isUnreachable(message: string): boolean;
