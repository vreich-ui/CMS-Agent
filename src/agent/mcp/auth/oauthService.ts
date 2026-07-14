// Minimal, self-contained OAuth 2.1 authorization server for the MCP endpoint.
//
// It implements exactly the surface Claude's remote connector drives — Dynamic Client Registration
// (RFC 7591), the authorization-code grant with mandatory PKCE/S256 (RFC 7636), refresh-token
// rotation, and opaque bearer access tokens — bridged to a human approval step (see consent.ts).
// Nothing here is generic identity infrastructure; it is the smallest correct thing that lets a
// human authorize Claude and hand a usable token back to the connector.
//
// Secrets never persist in the clear: authorization codes and tokens are stored under a SHA-256
// hash of their value, so a leaked blob cannot be replayed.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { WorkspaceActor } from "../../workspace/changeTypes.js";
import { getMcpStateStore, type Clock, type McpStateStore } from "../state/stateStore.js";
import { verifyPkceS256 } from "./pkce.js";
import { MCP_SCOPE } from "./metadata.js";

export class OAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly error: string,
    public readonly errorDescription: string
  ) {
    super(errorDescription);
    this.name = "OAuthError";
  }
}

export type RegisteredClient = {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  scope: string;
  created_at: string;
};

export type ValidatedAuthorizationRequest = {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state?: string;
  resource?: string;
};

export type AuthorizationValidation =
  | { status: "ok"; request: ValidatedAuthorizationRequest }
  | { status: "redirect"; location: string };

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
};

export type AccessTokenRecord = {
  clientId: string;
  scope: string;
  resource?: string;
  actor: WorkspaceActor;
  createdAt: string;
  expiresAt: number;
};

type AuthorizationCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
  actor: WorkspaceActor;
  expiresAt: number;
};

type RefreshTokenRecord = {
  clientId: string;
  scope: string;
  resource?: string;
  actor: WorkspaceActor;
  createdAt: string;
  expiresAt: number;
};

export type OAuthTtls = { codeMs: number; accessMs: number; refreshMs: number };

const DEFAULT_TTLS: OAuthTtls = {
  codeMs: 5 * 60 * 1000,
  accessMs: 60 * 60 * 1000,
  refreshMs: 30 * 24 * 60 * 60 * 1000
};

const KEYS = {
  client: (id: string) => `mcp/oauth/client/${id}`,
  code: (hash: string) => `mcp/oauth/code/${hash}`,
  access: (hash: string) => `mcp/oauth/token/${hash}`,
  refresh: (hash: string) => `mcp/oauth/refresh/${hash}`
};

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
const opaque = (prefix: string): string => `${prefix}${randomBytes(32).toString("base64url")}`;

const isHttpsOrLoopback = (uri: string): boolean => {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return true;
    // Native connectors register a loopback/custom-scheme redirect; allow http only on loopback.
    if (url.protocol === "http:") return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    // Custom schemes (e.g. app callbacks) are permitted for installed clients.
    return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) && url.protocol !== "javascript:" && url.protocol !== "data:";
  } catch {
    return false;
  }
};

const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;

const timingSafeStringEqual = (a: string, b: string): boolean => {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
};

export class OAuthService {
  private readonly store: McpStateStore;
  private readonly clock: Clock;
  private readonly ttls: OAuthTtls;

  constructor(config: { store?: McpStateStore; clock?: Clock; ttls?: Partial<OAuthTtls> } = {}) {
    this.store = config.store ?? getMcpStateStore();
    this.clock = config.clock ?? Date.now;
    this.ttls = { ...DEFAULT_TTLS, ...config.ttls };
  }

  // --- Dynamic Client Registration (RFC 7591) --------------------------------------------------
  async register(body: unknown): Promise<RegisteredClient> {
    const request = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const redirectUris = asStringArray(request.redirect_uris);
    if (!redirectUris || redirectUris.length === 0) {
      throw new OAuthError(400, "invalid_client_metadata", "redirect_uris is required and must be a non-empty array of strings.");
    }
    const invalid = redirectUris.find((uri) => !isHttpsOrLoopback(uri));
    if (invalid) {
      throw new OAuthError(400, "invalid_redirect_uri", "Every redirect_uri must be https, a loopback http URL, or a custom application scheme.");
    }
    const client: RegisteredClient = {
      client_id: opaque("mcpc_"),
      client_name: typeof request.client_name === "string" ? request.client_name : undefined,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: request.token_endpoint_auth_method === "client_secret_basic" ? "client_secret_basic" : "none",
      grant_types: asStringArray(request.grant_types) ?? ["authorization_code", "refresh_token"],
      response_types: asStringArray(request.response_types) ?? ["code"],
      scope: typeof request.scope === "string" && request.scope.trim() ? request.scope : MCP_SCOPE,
      created_at: new Date(this.clock()).toISOString()
    };
    // Registered clients are long-lived; no TTL.
    await this.store.put(KEYS.client(client.client_id), client);
    return client;
  }

  async getClient(clientId: string): Promise<RegisteredClient | null> {
    if (!clientId) return null;
    return this.store.get<RegisteredClient>(KEYS.client(clientId));
  }

  // --- Authorization request validation --------------------------------------------------------
  // Errors on client_id/redirect_uri render an error page (never redirect to an unvalidated URI);
  // all later errors redirect back to the validated redirect_uri with an OAuth `error`.
  async validateAuthorizationRequest(query: Record<string, string | undefined>): Promise<AuthorizationValidation> {
    const clientId = query.client_id ?? "";
    const client = await this.getClient(clientId);
    if (!client) throw new OAuthError(400, "invalid_client", "Unknown or unregistered client_id.");

    const redirectUri = query.redirect_uri ?? client.redirect_uris[0];
    if (!client.redirect_uris.includes(redirectUri)) {
      throw new OAuthError(400, "invalid_request", "redirect_uri does not match a registered value for this client.");
    }

    const state = query.state;
    const errorRedirect = (error: string, description: string): AuthorizationValidation => {
      const location = new URL(redirectUri);
      location.searchParams.set("error", error);
      location.searchParams.set("error_description", description);
      if (state) location.searchParams.set("state", state);
      return { status: "redirect", location: location.toString() };
    };

    if ((query.response_type ?? "") !== "code") return errorRedirect("unsupported_response_type", "Only response_type=code is supported.");
    if (query.code_challenge_method !== "S256") return errorRedirect("invalid_request", "code_challenge_method must be S256.");
    if (!query.code_challenge) return errorRedirect("invalid_request", "code_challenge is required (PKCE).");

    return {
      status: "ok",
      request: {
        clientId,
        clientName: client.client_name,
        redirectUri,
        codeChallenge: query.code_challenge,
        scope: query.scope && query.scope.trim() ? query.scope : client.scope,
        state,
        resource: query.resource
      }
    };
  }

  // Human approved: mint a one-time authorization code and produce the redirect back to the client.
  async approveAuthorization(request: ValidatedAuthorizationRequest, actor: WorkspaceActor): Promise<{ location: string }> {
    const code = opaque("mcpauth_");
    const record: AuthorizationCodeRecord = {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: request.scope,
      resource: request.resource,
      actor,
      expiresAt: this.clock() + this.ttls.codeMs
    };
    await this.store.put(KEYS.code(hashToken(code)), record, this.ttls.codeMs);
    const location = new URL(request.redirectUri);
    location.searchParams.set("code", code);
    if (request.state) location.searchParams.set("state", request.state);
    return { location: location.toString() };
  }

  // --- Token endpoint --------------------------------------------------------------------------
  async token(body: Record<string, string | undefined>): Promise<TokenResponse> {
    const grantType = body.grant_type ?? "";
    if (grantType === "authorization_code") return this.exchangeAuthorizationCode(body);
    if (grantType === "refresh_token") return this.exchangeRefreshToken(body);
    throw new OAuthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
  }

  private async exchangeAuthorizationCode(body: Record<string, string | undefined>): Promise<TokenResponse> {
    const code = body.code ?? "";
    const codeKey = KEYS.code(hashToken(code));
    const record = code ? await this.store.get<AuthorizationCodeRecord>(codeKey) : null;
    // One-time use: delete on first sight regardless of outcome so a replayed code cannot succeed.
    await this.store.delete(codeKey);
    if (!record || record.expiresAt <= this.clock()) throw new OAuthError(400, "invalid_grant", "Authorization code is invalid or expired.");
    if ((body.client_id ?? "") !== record.clientId) throw new OAuthError(400, "invalid_grant", "client_id does not match the authorization code.");
    if ((body.redirect_uri ?? "") !== record.redirectUri) throw new OAuthError(400, "invalid_grant", "redirect_uri does not match the authorization request.");
    if (!verifyPkceS256(body.code_verifier ?? "", record.codeChallenge)) throw new OAuthError(400, "invalid_grant", "PKCE verification failed.");
    return this.issueTokens({ clientId: record.clientId, scope: record.scope, resource: record.resource, actor: record.actor });
  }

  private async exchangeRefreshToken(body: Record<string, string | undefined>): Promise<TokenResponse> {
    const refreshToken = body.refresh_token ?? "";
    const refreshKey = KEYS.refresh(hashToken(refreshToken));
    const record = refreshToken ? await this.store.get<RefreshTokenRecord>(refreshKey) : null;
    if (!record || record.expiresAt <= this.clock()) throw new OAuthError(400, "invalid_grant", "Refresh token is invalid or expired.");
    if (body.client_id && !timingSafeStringEqual(body.client_id, record.clientId)) {
      throw new OAuthError(400, "invalid_grant", "client_id does not match the refresh token.");
    }
    // Rotate: the presented refresh token is single-use.
    await this.store.delete(refreshKey);
    return this.issueTokens({ clientId: record.clientId, scope: record.scope, resource: record.resource, actor: record.actor });
  }

  private async issueTokens(grant: { clientId: string; scope: string; resource?: string; actor: WorkspaceActor }): Promise<TokenResponse> {
    const nowMs = this.clock();
    const accessToken = opaque("mcpat_");
    const refreshToken = opaque("mcprt_");
    const accessRecord: AccessTokenRecord = {
      clientId: grant.clientId,
      scope: grant.scope,
      resource: grant.resource,
      actor: grant.actor,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: nowMs + this.ttls.accessMs
    };
    const refreshRecord: RefreshTokenRecord = { ...accessRecord, expiresAt: nowMs + this.ttls.refreshMs };
    await this.store.put(KEYS.access(hashToken(accessToken)), accessRecord, this.ttls.accessMs);
    await this.store.put(KEYS.refresh(hashToken(refreshToken)), refreshRecord, this.ttls.refreshMs);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(this.ttls.accessMs / 1000),
      refresh_token: refreshToken,
      scope: grant.scope
    };
  }

  // --- Resource-server verification ------------------------------------------------------------
  // Called by the MCP endpoint on every request that presents a non-static bearer token.
  async verifyAccessToken(token: string): Promise<AccessTokenRecord | null> {
    if (!token) return null;
    const record = await this.store.get<AccessTokenRecord>(KEYS.access(hashToken(token)));
    if (!record) return null;
    if (record.expiresAt <= this.clock()) {
      await this.store.delete(KEYS.access(hashToken(token)));
      return null;
    }
    return record;
  }
}
