/** Whether an Authorization header carries this bearer token, compared in constant time. */
export declare function bearerMatches(header: string | undefined, token: string): boolean;
