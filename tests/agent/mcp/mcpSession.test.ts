import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetSharedMemoryStateStore } from "../../../src/agent/mcp/state/stateStore.js";
import { OAuthService } from "../../../src/agent/mcp/auth/oauthService.js";
import { computeS256Challenge } from "../../../src/agent/mcp/auth/pkce.js";

type Headers = Record<string, string | undefined>;
const AUTH = { authorization: "Bearer test-token" };

const post = (body: unknown, headers: Headers = {}) =>
  handler({ httpMethod: "POST", headers: { ...AUTH, ...headers }, body: JSON.stringify(body) });

const initialize = (headers: Headers = {}, params: Record<string, unknown> = {}) =>
  post({ jsonrpc: "2.0", id: 1, method: "initialize", params }, headers);

describe("mcp streamable-http session + auth", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    delete process.env.WORKSPACE_STORE;
    delete process.env.MCP_REQUIRE_SESSION;
    resetSharedMemoryStateStore();
  });

  it("returns 401 with a WWW-Authenticate resource_metadata pointer when unauthenticated", async () => {
    const res = await handler({ httpMethod: "POST", headers: { host: "site.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
    expect(res.statusCode).toBe(401);
    const challenge = res.headers["www-authenticate"];
    expect(challenge).toContain("Bearer resource_metadata=");
    expect(challenge).toContain("https://site.example/.well-known/oauth-protected-resource");
    expect(JSON.parse(res.body).error.code).toBe("unauthorized");
  });

  it("flags an invalid bearer token in the challenge", async () => {
    const res = await handler({ httpMethod: "POST", headers: { authorization: "Bearer nope", host: "site.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('error="invalid_token"');
  });

  it("issues an Mcp-Session-Id and negotiated protocol on initialize", async () => {
    const res = await initialize({}, { protocolVersion: "2025-06-18", clientInfo: { name: "Claude", version: "1.0" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["mcp-session-id"]).toMatch(/^mcps_/);
    expect(res.headers["mcp-protocol-version"]).toBe("2025-06-18");
    const body = JSON.parse(res.body);
    expect(body.result.serverInfo.name).toBe("publishing-workspace-mcp");
    expect(body.result.sessionId).toBe(res.headers["mcp-session-id"]);
  });

  it("negotiates the protocol version, falling back to latest for unknown requests", async () => {
    expect((await initialize({}, { protocolVersion: "2025-03-26" })).headers["mcp-protocol-version"]).toBe("2025-03-26");
    expect((await initialize({}, { protocolVersion: "1999-01-01" })).headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("accepts follow-up requests carrying a valid session id", async () => {
    const sessionId = (await initialize()).headers["mcp-session-id"]!;
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sessionId });
    expect(res.statusCode).toBe(200);
    expect(res.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(JSON.parse(res.body).result.tools.map((t: { name: string }) => t.name)).toContain("workspace.get_nodes");
  });

  it("returns 404 for an unknown or expired session id", async () => {
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": "mcps_deadbeef" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("session_not_found");
  });

  it("terminates a session on DELETE and rejects its reuse", async () => {
    const sessionId = (await initialize()).headers["mcp-session-id"]!;
    const del = await handler({ httpMethod: "DELETE", headers: { ...AUTH, "mcp-session-id": sessionId }, body: null });
    expect(del.statusCode).toBe(204);

    const reuse = await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { "mcp-session-id": sessionId });
    expect(reuse.statusCode).toBe(404);

    const secondDelete = await handler({ httpMethod: "DELETE", headers: { ...AUTH, "mcp-session-id": sessionId }, body: null });
    expect(secondDelete.statusCode).toBe(404);
  });

  it("requires a session id to DELETE", async () => {
    const res = await handler({ httpMethod: "DELETE", headers: { ...AUTH }, body: null });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("missing_session");
  });

  it("rejects GET with 405 and an Allow header (no server-initiated SSE stream)", async () => {
    const res = await handler({ httpMethod: "GET", headers: { ...AUTH }, body: null });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toContain("POST");
  });

  it("still serves stateless bearer callers without a session id by default", async () => {
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res.statusCode).toBe(200);
  });

  describe("strict session enforcement", () => {
    afterEach(() => delete process.env.MCP_REQUIRE_SESSION);
    it("rejects non-initialize requests without a session id when MCP_REQUIRE_SESSION=true", async () => {
      process.env.MCP_REQUIRE_SESSION = "true";
      const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe("missing_session");

      // initialize still works and yields a usable session under strict mode.
      const sessionId = (await initialize()).headers["mcp-session-id"]!;
      const ok = await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { "mcp-session-id": sessionId });
      expect(ok.statusCode).toBe(200);
    });
  });

  it("accepts an OAuth-minted access token as bearer credentials", async () => {
    // Mint a token through the OAuth flow on the same shared in-process store the handler reads.
    const service = new OAuthService();
    const client = await service.register({ redirect_uris: ["https://claude.ai/cb"], client_name: "Claude" });
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const validation = await service.validateAuthorizationRequest({ response_type: "code", client_id: client.client_id, redirect_uri: "https://claude.ai/cb", code_challenge: computeS256Challenge(verifier), code_challenge_method: "S256" });
    if (validation.status !== "ok") throw new Error("expected ok validation");
    const { location } = await service.approveAuthorization(validation.request, { kind: "agent", label: "Claude (oauth)" });
    const code = new URL(location).searchParams.get("code")!;
    const tokens = await service.token({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: "https://claude.ai/cb", code_verifier: verifier });

    const res = await handler({ httpMethod: "POST", headers: { authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result.tools.length).toBeGreaterThan(0);
  });
});
