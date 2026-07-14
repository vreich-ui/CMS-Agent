// OAuth discovery documents for the MCP Authorization flow.
//
// A remote MCP client (Claude's custom connector) discovers how to authenticate by fetching two
// well-known documents: the Protected Resource Metadata (RFC 9728) advertised by the MCP endpoint,
// and the Authorization Server Metadata (RFC 8414) it points to. Serving real JSON here — ahead of
// the SPA catch-all — is what stops the connector from landing on the dashboard HTML.

export const MCP_SCOPE = "mcp";
export const OAUTH_PATHS = {
  protectedResource: "/.well-known/oauth-protected-resource",
  authorizationServer: "/.well-known/oauth-authorization-server",
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  register: "/oauth/register"
} as const;

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
  resource_documentation: string;
};

export type AuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
  service_documentation: string;
};

// `baseUrl` is the deployment origin (scheme + host, no trailing slash); `resourceUrl` is the
// absolute MCP endpoint URL the token will be scoped to.
export const buildProtectedResourceMetadata = (baseUrl: string, resourceUrl: string): ProtectedResourceMetadata => ({
  resource: resourceUrl,
  authorization_servers: [baseUrl],
  scopes_supported: [MCP_SCOPE],
  bearer_methods_supported: ["header"],
  resource_name: "CMS Agent Publishing Workspace MCP",
  resource_documentation: `${baseUrl}/`
});

export const buildAuthorizationServerMetadata = (baseUrl: string): AuthorizationServerMetadata => ({
  issuer: baseUrl,
  authorization_endpoint: `${baseUrl}${OAUTH_PATHS.authorize}`,
  token_endpoint: `${baseUrl}${OAUTH_PATHS.token}`,
  registration_endpoint: `${baseUrl}${OAUTH_PATHS.register}`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  // Public clients authenticated by PKCE, not a client secret — Claude registers dynamically.
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [MCP_SCOPE],
  service_documentation: `${baseUrl}/`
});

// Derive the deployment origin from request headers. Netlify sits behind a proxy, so honor
// `x-forwarded-proto`/`x-forwarded-host` when present, falling back to `host`.
export const resolveBaseUrl = (headers: Record<string, string | undefined>, fallback = "http://localhost:8888"): string => {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") lower[key.toLowerCase()] = value;
  }
  const host = lower["x-forwarded-host"] ?? lower.host;
  if (!host) return fallback;
  const proto = (lower["x-forwarded-proto"] ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https")).split(",")[0].trim();
  return `${proto}://${host}`;
};
