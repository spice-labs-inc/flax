const NETWORK = /ENOTFOUND|EAI_AGAIN|getaddrinfo|ERR_NAME_NOT_RESOLVED|ECONNREFUSED|ERR_CONNECTION_REFUSED|ECONNRESET|ERR_CONNECTION_RESET|ETIMEDOUT|ERR_CONNECTION_TIMED_OUT|ERR_INTERNET_DISCONNECTED|socket hang up|^TypeError: fetch failed/m;
/** Whether a failure message says the runner never reached the env: a name that did not resolve, a refused or dropped connection. Shared by the data build and the page, so it imports nothing of either. */
export function isUnreachable(message) {
    return NETWORK.test(message);
}
//# sourceMappingURL=unreachable.js.map