import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../../../src/agent/mcp/state/stateStore.js";
import { OAuthError, OAuthService } from "../../../src/agent/mcp/auth/oauthService.js";
import { computeS256Challenge, verifyPkceS256 } from "../../../src/agent/mcp/auth/pkce.js";
import { buildAuthorizationServerMetadata, buildProtectedResourceMetadata, resolveBaseUrl } from "../../../src/agent/mcp/auth/metadata.js";
import { buildWwwAuthenticate, parseBearerToken } from "../../../src/agent/mcp/auth/wwwAuthenticate.js";
import { actorForApproval, resolveApprovalSecret, verifyApproval } from "../../../src/agent/mcp/auth/consent.js";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"; // 65 valid chars
const CHALLENGE = computeS256Challenge(VERIFIER);

const newService = (nowRef = { value: 1_000 }) => {
  const clock = () => nowRef.value;
  return { service: new OAuthService({ store: new MemoryStateStore(clock), clock, ttls: { codeMs: 1000, accessMs: 2000, refreshMs: 5000 } }), nowRef };
};

describe("PKCE S256", () => {
  it("verifies a matching verifier and rejects mismatches / malformed input", () => {
    expect(verifyPkceS256(VERIFIER, CHALLENGE)).toBe(true);
    expect(verifyPkceS256("wrong-but-long-enough-verifier-value-1234567890", CHALLENGE)).toBe(false);
    expect(verifyPkceS256("too-short", CHALLENGE)).toBe(false); // fails length rule
    expect(verifyPkceS256("", CHALLENGE)).toBe(false);
  });
});

describe("OAuth metadata", () => {
  it("builds RFC 9728 protected-resource metadata", () => {
    const doc = buildProtectedResourceMetadata("https://site.example", "https://site.example/api/mcp");
    expect(doc.resource).toBe("https://site.example/api/mcp");
    expect(doc.authorization_servers).toEqual(["https://site.example"]);
    expect(doc.scopes_supported).toEqual(["mcp"]);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });

  it("builds RFC 8414 authorization-server metadata requiring PKCE S256", () => {
    const doc = buildAuthorizationServerMetadata("https://site.example");
    expect(doc.issuer).toBe("https://site.example");
    expect(doc.authorization_endpoint).toBe("https://site.example/oauth/authorize");
    expect(doc.token_endpoint).toBe("https://site.example/oauth/token");
    expect(doc.registration_endpoint).toBe("https://site.example/oauth/register");
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));
  });

  it("resolves the base URL from proxy headers", () => {
    expect(resolveBaseUrl({ host: "site.example" })).toBe("https://site.example");
    expect(resolveBaseUrl({ host: "site.example", "x-forwarded-proto": "http" })).toBe("http://site.example");
    expect(resolveBaseUrl({ host: "localhost:8888" })).toBe("http://localhost:8888");
    expect(resolveBaseUrl({})).toBe("http://localhost:8888");
  });
});

describe("WWW-Authenticate", () => {
  it("advertises resource metadata and optional error", () => {
    expect(buildWwwAuthenticate({ resourceMetadataUrl: "https://x/.well-known/oauth-protected-resource" }))
      .toBe('Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"');
    expect(buildWwwAuthenticate({ resourceMetadataUrl: "https://x/m", error: "invalid_token", errorDescription: "expired" }))
      .toBe('Bearer resource_metadata="https://x/m", error="invalid_token", error_description="expired"');
  });

  it("parses bearer tokens case-insensitively", () => {
    expect(parseBearerToken("Bearer abc.def")).toBe("abc.def");
    expect(parseBearerToken("bearer xyz")).toBe("xyz");
    expect(parseBearerToken("Basic abc")).toBeUndefined();
    expect(parseBearerToken(undefined)).toBeUndefined();
  });
});

describe("consent approval", () => {
  it("resolves and verifies the approval secret with a documented fallback", () => {
    expect(resolveApprovalSecret({ MCP_OAUTH_APPROVAL_SECRET: "dedicated", MCP_API_TOKEN: "static" } as NodeJS.ProcessEnv)).toBe("dedicated");
    expect(resolveApprovalSecret({ MCP_API_TOKEN: "static" } as NodeJS.ProcessEnv)).toBe("static");
    expect(resolveApprovalSecret({} as NodeJS.ProcessEnv)).toBeUndefined();

    const env = { MCP_OAUTH_APPROVAL_SECRET: "s3cret" } as NodeJS.ProcessEnv;
    expect(verifyApproval("s3cret", env)).toBe(true);
    expect(verifyApproval("nope", env)).toBe(false);
    expect(verifyApproval("anything", {} as NodeJS.ProcessEnv)).toBe(false); // no secret configured
  });

  it("attributes an approved connection to an agent labelled by client", () => {
    expect(actorForApproval({ clientId: "c", clientName: "Claude", redirectUri: REDIRECT, codeChallenge: CHALLENGE, scope: "mcp" }))
      .toEqual({ kind: "agent", label: "Claude (oauth)" });
    expect(actorForApproval({ clientId: "c", redirectUri: REDIRECT, codeChallenge: CHALLENGE, scope: "mcp" }))
      .toEqual({ kind: "agent", label: "mcp-oauth-client" });
  });
});

describe("OAuthService — dynamic client registration", () => {
  it("registers a public client and rejects unsafe redirect_uris", async () => {
    const { service } = newService();
    const client = await service.register({ redirect_uris: [REDIRECT], client_name: "Claude" });
    expect(client.client_id).toMatch(/^mcpc_/);
    expect(client.redirect_uris).toEqual([REDIRECT]);
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(await service.getClient(client.client_id)).not.toBeNull();

    await expect(service.register({})).rejects.toBeInstanceOf(OAuthError);
    await expect(service.register({ redirect_uris: ["http://evil.example/cb"] })).rejects.toMatchObject({ error: "invalid_redirect_uri" });
    await expect(service.register({ redirect_uris: ["javascript:alert(1)"] })).rejects.toMatchObject({ error: "invalid_redirect_uri" });
    expect((await service.register({ redirect_uris: ["http://localhost:1234/cb"] })).client_id).toMatch(/^mcpc_/);
  });
});

describe("OAuthService — authorization-code flow", () => {
  const authorized = async (service: OAuthService) => {
    const client = await service.register({ redirect_uris: [REDIRECT], client_name: "Claude" });
    const validation = await service.validateAuthorizationRequest({
      response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT,
      code_challenge: CHALLENGE, code_challenge_method: "S256", state: "st4te", scope: "mcp"
    });
    if (validation.status !== "ok") throw new Error("expected ok validation");
    const { location } = await service.approveAuthorization(validation.request, actorForApproval(validation.request));
    const url = new URL(location);
    return { client, code: url.searchParams.get("code")!, state: url.searchParams.get("state") };
  };

  it("completes register → authorize → approve → token → verify", async () => {
    const { service } = newService();
    const { client, code, state } = await authorized(service);
    expect(state).toBe("st4te");

    const tokens = await service.token({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    expect(tokens.access_token).toMatch(/^mcpat_/);
    expect(tokens.refresh_token).toMatch(/^mcprt_/);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(2); // accessMs 2000 -> seconds

    const record = await service.verifyAccessToken(tokens.access_token);
    expect(record).toMatchObject({ clientId: client.client_id, scope: "mcp", actor: { kind: "agent", label: "Claude (oauth)" } });
    expect(await service.verifyAccessToken("mcpat_not-a-real-token")).toBeNull();
  });

  it("enforces one-time codes, PKCE, and matching client/redirect", async () => {
    const { service } = newService();
    const { client, code } = await authorized(service);

    await expect(service.token({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: "x".repeat(50) }))
      .rejects.toMatchObject({ error: "invalid_grant" }); // wrong verifier

    // The failed attempt consumed the one-time code; a correct retry now also fails.
    await expect(service.token({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER }))
      .rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("rejects a code exchanged with the wrong redirect_uri", async () => {
    const { service } = newService();
    const { client, code } = await authorized(service);
    await expect(service.token({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: "https://claude.ai/other", code_verifier: VERIFIER }))
      .rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("expires authorization codes", async () => {
    const { service, nowRef } = newService();
    const { client, code } = await authorized(service);
    nowRef.value += 2000; // past codeMs (1000)
    await expect(service.token({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER }))
      .rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("rotates refresh tokens and rejects reuse", async () => {
    const { service } = newService();
    const { client, code } = await authorized(service);
    const first = await service.token({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER });

    const refreshed = await service.token({ grant_type: "refresh_token", refresh_token: first.refresh_token!, client_id: client.client_id });
    expect(refreshed.access_token).toMatch(/^mcpat_/);
    expect(refreshed.access_token).not.toBe(first.access_token);
    expect(await service.verifyAccessToken(refreshed.access_token)).not.toBeNull();

    // The original refresh token was rotated out on first use.
    await expect(service.token({ grant_type: "refresh_token", refresh_token: first.refresh_token!, client_id: client.client_id }))
      .rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("rejects unsupported grant types", async () => {
    const { service } = newService();
    await expect(service.token({ grant_type: "password" })).rejects.toMatchObject({ error: "unsupported_grant_type" });
  });
});

describe("OAuthService — authorization request validation", () => {
  it("renders errors for unknown client / mismatched redirect_uri", async () => {
    const { service } = newService();
    const unknown = await service.validateAuthorizationRequest({ response_type: "code", client_id: "nope", redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256" }).catch((e) => e);
    expect(unknown).toBeInstanceOf(OAuthError);
    expect(unknown.error).toBe("invalid_client");

    const client = await service.register({ redirect_uris: [REDIRECT] });
    const mismatch = await service.validateAuthorizationRequest({ response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.example/cb", code_challenge: CHALLENGE, code_challenge_method: "S256" }).catch((e) => e);
    expect(mismatch).toBeInstanceOf(OAuthError);
    expect(mismatch.error).toBe("invalid_request");
  });

  it("redirects post-validation errors back to the client with an OAuth error", async () => {
    const { service } = newService();
    const client = await service.register({ redirect_uris: [REDIRECT] });

    const noPkce = await service.validateAuthorizationRequest({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge_method: "S256", state: "st" });
    expect(noPkce.status).toBe("redirect");
    if (noPkce.status === "redirect") {
      const url = new URL(noPkce.location);
      expect(url.searchParams.get("error")).toBe("invalid_request");
      expect(url.searchParams.get("state")).toBe("st");
    }

    const badResponseType = await service.validateAuthorizationRequest({ response_type: "token", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256" });
    expect(badResponseType.status).toBe("redirect");
    if (badResponseType.status === "redirect") expect(new URL(badResponseType.location).searchParams.get("error")).toBe("unsupported_response_type");
  });
});
