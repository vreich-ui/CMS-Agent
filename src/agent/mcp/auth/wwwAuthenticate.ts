// Builder + parser for the Bearer challenge the MCP endpoint returns on 401.
//
// Per the MCP Authorization spec, a protected resource MUST advertise where to discover its
// authorization server via `WWW-Authenticate: Bearer resource_metadata="<url>"`. Without this
// header the client has no thread to pull on and cannot begin the OAuth flow — one of the concrete
// reasons the connector previously stalled.

import { OAUTH_PATHS } from "./metadata.js";

export type BearerChallenge = {
  resourceMetadataUrl: string;
  error?: "invalid_token" | "invalid_request" | "insufficient_scope";
  errorDescription?: string;
};

// quoted-string values escape backslash and double-quote per RFC 7235; our inputs are URLs and
// short ASCII descriptions, but escape defensively so the header can never be broken.
const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export const buildWwwAuthenticate = (challenge: BearerChallenge): string => {
  const params = [`resource_metadata=${quote(challenge.resourceMetadataUrl)}`];
  if (challenge.error) params.push(`error=${quote(challenge.error)}`);
  if (challenge.errorDescription) params.push(`error_description=${quote(challenge.errorDescription)}`);
  return `Bearer ${params.join(", ")}`;
};

export const resourceMetadataUrl = (baseUrl: string): string => `${baseUrl}${OAUTH_PATHS.protectedResource}`;

// Extract a bearer token from an Authorization header, case-insensitively on the scheme. Returns
// undefined when absent or malformed so callers treat it as "unauthenticated" uniformly.
export const parseBearerToken = (authorization: string | undefined): string | undefined => {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : undefined;
};
