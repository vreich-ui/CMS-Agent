import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../../../src/agent/mcp/state/stateStore.js";
import { OAuthService } from "../../../src/agent/mcp/auth/oauthService.js";
import { computeS256Challenge } from "../../../src/agent/mcp/auth/pkce.js";
import {
  handleAuthorizationServerMetadata,
  handleAuthorize,
  handleProtectedResourceMetadata,
  handleRegister,
  handleToken,
  type OAuthRequest
} from "../../../src/agent/mcp/http/oauthEndpoints.js";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const CHALLENGE = computeS256Challenge(VERIFIER);
const APPROVAL_ENV = { MCP_OAUTH_APPROVAL_SECRET: "s3cret" } as NodeJS.ProcessEnv;

const req = (over: Partial<OAuthRequest>): OAuthRequest => ({ httpMethod: "GET", headers: {}, query: {}, body: null, ...over });
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

describe("OAuth discovery documents", () => {
  it("serves protected-resource metadata as JSON derived from the request host", () => {
    const res = handleProtectedResourceMetadata(req({ headers: { host: "site.example" } }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const doc = JSON.parse(res.body);
    expect(doc.resource).toBe("https://site.example/api/mcp");
    expect(doc.authorization_servers).toEqual(["https://site.example"]);
  });

  it("serves authorization-server metadata as JSON", () => {
    const res = handleAuthorizationServerMetadata(req({ headers: { host: "site.example" } }));
    const doc = JSON.parse(res.body);
    expect(doc.authorization_endpoint).toBe("https://site.example/oauth/authorize");
    expect(doc.token_endpoint).toBe("https://site.example/oauth/token");
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("answers CORS preflight", () => {
    const res = handleProtectedResourceMetadata(req({ httpMethod: "OPTIONS" }));
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("OAuth endpoints — full browser flow", () => {
  it("registers, renders consent, gates on the approval secret, and issues a token", async () => {
    const service = new OAuthService({ store: new MemoryStateStore() });

    // 1. Dynamic client registration.
    const reg = await handleRegister(req({ httpMethod: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude" }) }), service);
    expect(reg.statusCode).toBe(201);
    const client = JSON.parse(reg.body);
    expect(client.client_id).toMatch(/^mcpc_/);
    expect(client.client_id_issued_at).toBeTypeOf("number");

    const query = { response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "st", scope: "mcp" };

    // 2. Authorize GET renders the consent screen.
    const consent = await handleAuthorize(req({ httpMethod: "GET", query }), APPROVAL_ENV, service);
    expect(consent.statusCode).toBe(200);
    expect(consent.headers["content-type"]).toContain("text/html");
    expect(consent.body).toContain("Authorize workspace access");
    expect(consent.body).toContain("Claude");

    // 3. Wrong approval secret re-renders with an error and issues no code.
    const denied = await handleAuthorize(req({ httpMethod: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ ...query, approval: "wrong" }) }), APPROVAL_ENV, service);
    expect(denied.statusCode).toBe(200);
    expect(denied.body).toContain("Incorrect approval secret");

    // 4. Correct approval secret redirects back to the client with a code.
    const approved = await handleAuthorize(req({ httpMethod: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ ...query, approval: "s3cret" }) }), APPROVAL_ENV, service);
    expect(approved.statusCode).toBe(302);
    const location = new URL(approved.headers.location);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("st");
    const code = location.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // 5. Token exchange with PKCE verifier.
    const tokenRes = await handleToken(req({ httpMethod: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER }) }), service);
    expect(tokenRes.statusCode).toBe(200);
    expect(tokenRes.headers["cache-control"]).toBe("no-store");
    const tokens = JSON.parse(tokenRes.body);
    expect(tokens.access_token).toMatch(/^mcpat_/);
    expect(await service.verifyAccessToken(tokens.access_token)).not.toBeNull();
  });

  it("rejects invalid registration and non-POST methods", async () => {
    const service = new OAuthService({ store: new MemoryStateStore() });
    expect((await handleRegister(req({ httpMethod: "POST", headers: { "content-type": "application/json" }, body: "{}" }), service)).statusCode).toBe(400);
    expect((await handleRegister(req({ httpMethod: "POST", headers: { "content-type": "application/json" }, body: "not json" }), service)).statusCode).toBe(400);
    expect((await handleToken(req({ httpMethod: "GET" }), service)).statusCode).toBe(405);
  });

  it("disables approval and warns when no secret is configured", async () => {
    const service = new OAuthService({ store: new MemoryStateStore() });
    const reg = await handleRegister(req({ httpMethod: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) }), service);
    const client = JSON.parse(reg.body);
    const consent = await handleAuthorize(req({ httpMethod: "GET", query: { response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256" } }), {} as NodeJS.ProcessEnv, service);
    expect(consent.body).toContain("No approval secret is configured");
    expect(consent.body).toContain("disabled");
  });

  it("renders an HTML error page for an unknown client", async () => {
    const service = new OAuthService({ store: new MemoryStateStore() });
    const res = await handleAuthorize(req({ httpMethod: "GET", query: { response_type: "code", client_id: "mcpc_missing", redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256" } }), APPROVAL_ENV, service);
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("invalid_client");
  });
});
