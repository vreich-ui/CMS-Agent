export type HeaderMap = Record<string, string | undefined>;

const getAuthorizationHeader = (headers: HeaderMap) => headers.authorization ?? headers.Authorization;

export function hasBearerToken(headers: HeaderMap, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  return getAuthorizationHeader(headers) === `Bearer ${expectedToken}`;
}

export const unauthorizedResponse = {
  error: { code: "unauthorized", message: "Missing or invalid bearer token." }
};
