import { createPrivateKey, createSign } from "node:crypto";
import { isRecord } from "@flax/contract";
const API = "https://api.github.com";
const REQUEST_MS = 30_000;
const DOWNLOAD_MS = 120_000;
/** The app's private key from the environment: the PEM itself (newlines as \n allowed, so it fits one .env line) or base64 of the PEM. */
export function appKey(raw) {
    const text = raw.trim();
    const pem = text.includes("-----BEGIN")
        ? text.replace(/\\n/g, "\n")
        : Buffer.from(text, "base64").toString("utf8");
    if (!pem.includes("-----BEGIN"))
        throw new Error("EXPLORER_GH_APP_KEY is neither a PEM nor base64 of one");
    return createPrivateKey(pem);
}
const b64url = (b) => Buffer.from(b).toString("base64url");
/** A GitHub App JWT, valid for 9 minutes from a minute ago (GitHub allows 10 and clocks drift). */
export function appJwt(appId, key, now) {
    const iat = Math.floor(now / 1000) - 60;
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }));
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key);
    return `${head}.${body}.${b64url(sig)}`;
}
class GitHubError extends Error {
}
/** GitHub as the reader app's installation on this repository: hour-long installation tokens, renewed 5 minutes early. */
export class AppGitHub {
    #appId;
    #key;
    #repo;
    #fetch;
    #token;
    constructor(appId, key, repo, f = fetch) {
        if (!/^\d+$/.test(appId))
            throw new Error("EXPLORER_GH_APP_ID is not a number");
        this.#appId = appId;
        this.#key = key;
        this.#repo = repo;
        this.#fetch = f;
    }
    async #installationToken() {
        const now = Date.now();
        if (this.#token && this.#token.until > now)
            return this.#token.value;
        const jwt = appJwt(this.#appId, this.#key, now);
        const installation = await this.#call(`/repos/${this.#repo}/installation`, jwt);
        const id = isRecord(installation) ? installation["id"] : undefined;
        if (typeof id !== "number")
            throw new GitHubError(`the app is not installed on ${this.#repo}`);
        const made = await this.#call(`/app/installations/${id}/access_tokens`, jwt, {
            method: "POST",
        });
        const token = isRecord(made) ? made["token"] : undefined;
        const expires = isRecord(made) ? made["expires_at"] : undefined;
        if (typeof token !== "string" || typeof expires !== "string")
            throw new GitHubError("GitHub made no installation token");
        this.#token = { value: token, until: Date.parse(expires) - 5 * 60_000 };
        return token;
    }
    async #call(path, bearer, init = {}) {
        const res = await this.#fetch(`${API}${path}`, {
            method: init.method ?? "GET",
            headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${bearer}`,
                "x-github-api-version": "2022-11-28",
                "user-agent": "flax-explorer",
                ...(init.body ? { "content-type": "application/json" } : {}),
            },
            ...(init.body ? { body: init.body } : {}),
            signal: AbortSignal.timeout(REQUEST_MS),
        });
        if (!res.ok) {
            await res.body?.cancel();
            throw new GitHubError(`GitHub answered ${res.status} for ${path.split("?")[0]}`);
        }
        return res.json();
    }
    async json(path) {
        return this.#call(path, await this.#installationToken());
    }
    async graphql(query) {
        return this.#call("/graphql", await this.#installationToken(), {
            method: "POST",
            body: JSON.stringify({ query }),
        });
    }
    async download(path, maxBytes) {
        // GitHub answers with a redirect to storage; fetch drops the authorization header crossing origins.
        const res = await this.#fetch(`${API}${path}`, {
            headers: {
                authorization: `Bearer ${await this.#installationToken()}`,
                "x-github-api-version": "2022-11-28",
                "user-agent": "flax-explorer",
            },
            signal: AbortSignal.timeout(DOWNLOAD_MS),
        });
        if (!res.ok || !res.body) {
            await res.body?.cancel();
            throw new GitHubError(`GitHub answered ${res.status} for ${path}`);
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of res.body) {
            size += chunk.length;
            if (size > maxBytes)
                throw new GitHubError(`${path} is over ${maxBytes} bytes`);
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
}
//# sourceMappingURL=github.js.map