// Request-shaped logic for the OAuth endpoints, kept out of the Netlify function files so it can be
// unit-tested directly (the .mts handlers are thin adapters, per the repo's architecture rules).
//
// Each function takes a normalized request and returns a normalized { statusCode, headers, body }.

import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  OAUTH_PATHS,
  resolveBaseUrl
} from "../auth/metadata.js";
import { OAuthError, OAuthService } from "../auth/oauthService.js";
import { actorForApproval, renderConsentPage, renderErrorPage, resolveApprovalSecret, verifyApproval } from "../auth/consent.js";

export type HttpResponse = { statusCode: number; headers: Record<string, string>; body: string };
export type OAuthRequest = {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  body: string | null;
};

const MCP_RESOURCE_PATH = "/api/mcp";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version", "access-control-allow-methods": "GET, POST, OPTIONS" };

const json = (statusCode: number, body: unknown, extraHeaders: Record<string, string> = {}): HttpResponse => ({
  statusCode,
  headers: { "content-type": "application/json", ...CORS, ...extraHeaders },
  body: JSON.stringify(body)
});

const html = (statusCode: number, body: string): HttpResponse => ({
  statusCode,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  body
});

const redirect = (location: string): HttpResponse => ({
  statusCode: 302,
  headers: { location, "cache-control": "no-store" },
  body: ""
});

const preflight = (): HttpResponse => ({ statusCode: 204, headers: { ...CORS }, body: "" });

const oauthErrorResponse = (error: unknown): HttpResponse => {
  if (error instanceof OAuthError) return json(error.status, { error: error.error, error_description: error.errorDescription });
  return json(500, { error: "server_error", error_description: error instanceof Error ? error.message : "Unknown error" });
};

// Accepts form-urlencoded (OAuth default) and, defensively, JSON.
const parseBody = (request: OAuthRequest): Record<string, string | undefined> => {
  const raw = request.body ?? "";
  if (!raw) return {};
  const contentType = (request.headers["content-type"] ?? request.headers["Content-Type"] ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, value === undefined || value === null ? undefined : String(value)]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
};

export const handleProtectedResourceMetadata = (request: OAuthRequest): HttpResponse => {
  if (request.httpMethod === "OPTIONS") return preflight();
  const baseUrl = resolveBaseUrl(request.headers);
  return json(200, buildProtectedResourceMetadata(baseUrl, `${baseUrl}${MCP_RESOURCE_PATH}`), { "cache-control": "public, max-age=3600" });
};

export const handleAuthorizationServerMetadata = (request: OAuthRequest): HttpResponse => {
  if (request.httpMethod === "OPTIONS") return preflight();
  const baseUrl = resolveBaseUrl(request.headers);
  return json(200, buildAuthorizationServerMetadata(baseUrl), { "cache-control": "public, max-age=3600" });
};

export const handleRegister = async (request: OAuthRequest, service = new OAuthService()): Promise<HttpResponse> => {
  if (request.httpMethod === "OPTIONS") return preflight();
  if (request.httpMethod !== "POST") return json(405, { error: "invalid_request", error_description: "Use POST to register a client." });
  try {
    const body = request.body ? JSON.parse(request.body) : {};
    const client = await service.register(body);
    return json(201, { ...client, client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000) });
  } catch (error) {
    if (error instanceof SyntaxError) return json(400, { error: "invalid_client_metadata", error_description: "Body must be valid JSON." });
    return oauthErrorResponse(error);
  }
};

export const handleAuthorize = async (
  request: OAuthRequest,
  env: NodeJS.ProcessEnv = process.env,
  service = new OAuthService()
): Promise<HttpResponse> => {
  if (request.httpMethod === "OPTIONS") return preflight();
  const isPost = request.httpMethod === "POST";
  const params = isPost ? parseBody(request) : request.query;

  try {
    const validation = await service.validateAuthorizationRequest(params);
    if (validation.status === "redirect") return redirect(validation.location);

    if (!isPost) {
      return html(200, renderConsentPage(validation.request, { actionPath: OAUTH_PATHS.authorize, secretConfigured: !!resolveApprovalSecret(env) }));
    }

    // POST = the human submitted the consent form.
    if (!verifyApproval(params.approval, env)) {
      return html(200, renderConsentPage(validation.request, {
        actionPath: OAUTH_PATHS.authorize,
        secretConfigured: !!resolveApprovalSecret(env),
        error: "Incorrect approval secret. The connection was not authorized."
      }));
    }
    const { location } = await service.approveAuthorization(validation.request, actorForApproval(validation.request));
    return redirect(location);
  } catch (error) {
    if (error instanceof OAuthError) return html(error.status, renderErrorPage(error.error, error.errorDescription));
    return html(500, renderErrorPage("server_error", error instanceof Error ? error.message : "Unknown error"));
  }
};

export const handleToken = async (request: OAuthRequest, service = new OAuthService()): Promise<HttpResponse> => {
  if (request.httpMethod === "OPTIONS") return preflight();
  if (request.httpMethod !== "POST") return json(405, { error: "invalid_request", error_description: "Use POST for the token endpoint." });
  try {
    const tokens = await service.token(parseBody(request));
    return json(200, tokens, { "cache-control": "no-store", pragma: "no-cache" });
  } catch (error) {
    return oauthErrorResponse(error);
  }
};
