// Pure request router for the Cloud Run control-plane MCP Service (DIRECTION.md Phase 4a). Serves
// the same MCP endpoint and OAuth discovery/flow as the Netlify Functions, from one Node process,
// by dispatching to the shared endpoint cores. Kept transport-neutral (a normalized request in, a
// { statusCode, headers, body } out) so it unit-tests without a socket; mcpServerMain.ts wraps it
// in node:http.
import type { HeaderMap } from "../../runtime/auth.js";
import { handleMcpHttp } from "./mcpEndpoint.js";
import { handleAuthorize, handleAuthorizationServerMetadata, handleProtectedResourceMetadata, handleRegister, handleToken, type HttpResponse, type OAuthRequest } from "./oauthEndpoints.js";

export type RouterRequest = { method: string; path: string; query: Record<string, string | undefined>; headers: HeaderMap; body: string | null };

const notFound = (): HttpResponse => ({ statusCode: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: "not_found", message: "No such endpoint on the CMS-Agent control plane." } }) });

// Health probe for Cloud Run startup/liveness. Deliberately unauthenticated and side-effect-free.
const health = (): HttpResponse => ({ statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ status: "ok", service: "cms-agent-mcp", store: process.env.WORKSPACE_STORE ?? "memory" }) });

const oauthRequest = (request: RouterRequest): OAuthRequest => ({ httpMethod: request.method, headers: request.headers, query: request.query, body: request.body });

// The MCP endpoint path is configurable (Google's guidance uses "/mcp"); it also answers "/api/mcp"
// so the exact same client config works whether it points at Netlify or Cloud Run.
const MCP_PATHS = new Set(["/mcp", "/api/mcp"]);

export async function routeControlPlaneRequest(request: RouterRequest): Promise<HttpResponse> {
  const { method, path } = request;

  if (path === "/healthz" || path === "/") return health();
  if (MCP_PATHS.has(path)) return handleMcpHttp({ httpMethod: method, headers: request.headers, body: request.body });

  // OAuth discovery + endpoints (trailing-segment forms allowed, matching the netlify.toml globs).
  if (path === "/.well-known/oauth-protected-resource" || path.startsWith("/.well-known/oauth-protected-resource/")) return handleProtectedResourceMetadata(oauthRequest(request));
  if (path === "/.well-known/oauth-authorization-server" || path.startsWith("/.well-known/oauth-authorization-server/")) return handleAuthorizationServerMetadata(oauthRequest(request));
  if (path === "/oauth/register") return handleRegister(oauthRequest(request));
  if (path === "/oauth/authorize") return handleAuthorize(oauthRequest(request));
  if (path === "/oauth/token") return handleToken(oauthRequest(request));

  return notFound();
}
