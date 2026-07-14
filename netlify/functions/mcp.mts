import { handleMcpJsonRpc } from "../../src/agent/mcp/workspace/server.js";
import type { WorkspaceToolContext } from "../../src/agent/mcp/workspace/tools.js";
import { workspaceActorKinds, workspaceChangeSources, type WorkspaceActor, type WorkspaceChangeSource } from "../../src/agent/workspace/changeTypes.js";
import { hasBearerToken, unauthorizedResponse, type HeaderMap } from "../../src/agent/runtime/auth.js";
import { connectLambdaBlobs } from "../../src/agent/runtime/lambdaBlobs.js";
import { refreshRepositoryManagerForRequest } from "../../src/agent/runtime/repositories.js";
import { McpSessionManager, negotiateProtocolVersion, type McpClientInfo } from "../../src/agent/mcp/transport/session.js";
import { OAuthService } from "../../src/agent/mcp/auth/oauthService.js";
import { buildWwwAuthenticate, parseBearerToken, resourceMetadataUrl } from "../../src/agent/mcp/auth/wwwAuthenticate.js";
import { resolveBaseUrl } from "../../src/agent/mcp/auth/metadata.js";

const SESSION_HEADER = "mcp-session-id";
const PROTOCOL_HEADER = "mcp-protocol-version";

type FunctionResponse = { statusCode: number; headers: Record<string, string>; body: string };

const json = (statusCode: number, body: unknown, headers: Record<string, string> = {}): FunctionResponse => ({
  statusCode,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body)
});

const empty = (statusCode: number, headers: Record<string, string> = {}): FunctionResponse => ({ statusCode, headers, body: "" });

const isMcpNotification = (message: unknown) => {
  const request = message as { id?: unknown; method?: unknown };
  return request.id === undefined && typeof request.method === "string" && request.method.startsWith("notifications/");
};

const isInitialize = (message: unknown) => (message as { method?: unknown }).method === "initialize";

const readHeader = (headers: HeaderMap, name: string): string | undefined => {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName && typeof value === "string") return value;
  }
  return undefined;
};

// Attribution context for change history. The secure proxy (workspace-mcp) stamps a verified
// human actor via these headers after identity checks; direct bearer-token callers default to an
// agent actor. This is attribution, not authorization — a bearer holder could self-describe.
const parseActorHeader = (value: string | undefined): WorkspaceActor | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { kind?: unknown; id?: unknown; label?: unknown };
    if (typeof parsed?.kind !== "string" || !(workspaceActorKinds as readonly string[]).includes(parsed.kind)) return undefined;
    return {
      kind: parsed.kind as WorkspaceActor["kind"],
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      label: typeof parsed.label === "string" ? parsed.label : undefined
    };
  } catch {
    return undefined;
  }
};

const parseSourceHeader = (value: string | undefined): WorkspaceChangeSource | undefined =>
  value && (workspaceChangeSources as readonly string[]).includes(value) ? value as WorkspaceChangeSource : undefined;

// Precedence for the attributed actor: an explicit proxy header (verified human) wins; otherwise a
// token-derived actor (OAuth client); otherwise the direct-caller default (agent).
const buildToolContext = (headers: HeaderMap, tokenActor?: WorkspaceActor): WorkspaceToolContext => ({
  actor: parseActorHeader(headers["x-workspace-actor"]) ?? tokenActor ?? { kind: "agent" },
  source: parseSourceHeader(headers["x-workspace-source"]) ?? "mcp",
  requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
});

type AuthOutcome = { ok: true; actor?: WorkspaceActor } | { ok: false; presentedToken: boolean };

// Accept either the static workspace bearer (back-compat) or an OAuth-minted access token. On
// failure the caller returns 401 with a WWW-Authenticate pointer so a connector can discover the
// authorization server and complete the OAuth flow.
const authenticate = async (headers: HeaderMap): Promise<AuthOutcome> => {
  if (hasBearerToken(headers, process.env.MCP_API_TOKEN)) return { ok: true };
  const token = parseBearerToken(readHeader(headers, "authorization"));
  if (!token) return { ok: false, presentedToken: false };
  const record = await new OAuthService().verifyAccessToken(token);
  if (record) return { ok: true, actor: record.actor };
  return { ok: false, presentedToken: true };
};

const unauthorized = (headers: HeaderMap, presentedToken: boolean) => {
  const baseUrl = resolveBaseUrl(headers);
  const challenge = buildWwwAuthenticate({
    resourceMetadataUrl: resourceMetadataUrl(baseUrl),
    ...(presentedToken ? { error: "invalid_token" as const, errorDescription: "The bearer token is invalid or expired." } : {})
  });
  return json(401, unauthorizedResponse, { "www-authenticate": challenge });
};

// Strict enforcement is read per request (env is stable per deploy; reading here keeps it testable
// and lets a config change take effect without reimporting the module).
const sessionRequired = (): boolean => (process.env.MCP_REQUIRE_SESSION ?? "false").toLowerCase() === "true";

export const handler = async (event: { httpMethod: string; body: string | null; headers: HeaderMap; blobs?: string }) => {
  // Lambda-mode Netlify Blobs must be connected before any repository / getStore() call.
  connectLambdaBlobs(event);
  refreshRepositoryManagerForRequest();

  const method = event.httpMethod.toUpperCase();
  // Streamable HTTP GET would open a server->client SSE stream; this endpoint does not offer one.
  if (method === "GET") {
    return json(405, { error: { code: "method_not_allowed", message: "This MCP endpoint does not offer a GET SSE stream. Use POST for requests." } }, { allow: "POST, DELETE" });
  }

  const auth = await authenticate(event.headers);
  if (!auth.ok) return unauthorized(event.headers, auth.presentedToken);

  const sessions = new McpSessionManager();
  const sessionId = readHeader(event.headers, SESSION_HEADER);

  // DELETE terminates the session named by the Mcp-Session-Id header.
  if (method === "DELETE") {
    if (!sessionId) return json(400, { error: { code: "missing_session", message: "Mcp-Session-Id header is required to terminate a session." } });
    const existed = await sessions.terminate(sessionId);
    return existed ? empty(204) : json(404, { error: { code: "session_not_found", message: "Unknown or already-terminated session." } });
  }

  if (method !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Use POST." } }, { allow: "POST, DELETE" });

  try {
    const context = buildToolContext(event.headers, auth.actor);
    const rawBody = event.body ? JSON.parse(event.body) : {};

    // Establish a session on initialize and return it via the Mcp-Session-Id header.
    if (!Array.isArray(rawBody) && isInitialize(rawBody)) {
      const params = (rawBody.params ?? {}) as { protocolVersion?: string; clientInfo?: McpClientInfo };
      const protocolVersion = negotiateProtocolVersion(params.protocolVersion);
      const session = await sessions.create({ protocolVersion, clientInfo: params.clientInfo, actor: context.actor ?? { kind: "agent" } });
      const result = await handleMcpJsonRpc(rawBody, context, { protocolVersion, sessionId: session.id });
      return json(200, result, { [SESSION_HEADER]: session.id, [PROTOCOL_HEADER]: protocolVersion });
    }

    // Validate the session when the client provides one (spec: unknown/expired -> 404 so the client
    // re-initializes). Absent sessions remain allowed for stateless bearer callers unless the
    // deployment opts into strict enforcement via MCP_REQUIRE_SESSION.
    let negotiatedProtocol: string | undefined;
    if (sessionId) {
      const session = await sessions.touch(sessionId);
      if (!session) return json(404, { error: { code: "session_not_found", message: "Unknown or expired Mcp-Session-Id. Re-initialize to obtain a new session." } });
      negotiatedProtocol = session.protocolVersion;
    } else if (sessionRequired()) {
      return json(400, { error: { code: "missing_session", message: "Mcp-Session-Id header is required. Call initialize first." } });
    }

    const responseHeaders: Record<string, string> = negotiatedProtocol ? { [PROTOCOL_HEADER]: negotiatedProtocol } : {};

    if (Array.isArray(rawBody)) {
      const calls = rawBody.filter((message) => !isMcpNotification(message));
      if (calls.length === 0) return empty(202, responseHeaders);
      const responses = await Promise.all(calls.map((message) => handleMcpJsonRpc(message, context)));
      return json(200, responses, responseHeaders);
    }
    if (isMcpNotification(rawBody)) return empty(202, responseHeaders);
    return json(200, await handleMcpJsonRpc(rawBody, context), responseHeaders);
  } catch (error) {
    if (error instanceof SyntaxError) return json(400, { error: { code: "invalid_json", message: "Request body must be valid JSON." } });
    return json(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "Unknown error" } });
  }
};
