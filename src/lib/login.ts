/** A GitHub user login: letters, digits and single hyphens, at most 39 characters. */
export const GITHUB_LOGIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** The login of a GitHub user object when it is a person, not an app or bot. */
export function personLogin(user: unknown): string | undefined {
  if (typeof user !== "object" || user === null || Array.isArray(user))
    return undefined;
  const { login, type } = user as Record<string, unknown>;
  if (typeof login !== "string" || !GITHUB_LOGIN.test(login)) return undefined;
  if (type === "Bot" || type === "Organization") return undefined;
  return login;
}
