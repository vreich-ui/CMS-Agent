import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { routeControlPlaneRequest } from "../../../src/agent/mcp/http/controlPlaneRouter.js";
import { handleNodeRequest, parseAllowedOrigins, isOriginAllowed, corsResponseHeaders, corsPreflightHeaders } from "../../../src/agent/entrypoints/mcpServerMain.js";
import { mcpStateUsesBlobs } from "../../../src/agent/mcp/state/stateStore.js";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const AUTH = { authorization: "Bearer test-token", host: "svc.example" };
const savedEnv = { ...process.env };
beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });
afterEach(() => { process.env = { ...savedEnv }; resetRepositoryManager(); });

const route = (method: string, path: string, body: unknown = null, headers: Record<string, string> = {}, query: Record<string, string> = {}) =>
  routeControlPlaneRequest({ method, path, query, headers, body: body === null ? null : JSON.stringify(body) });

describe("control-plane router", () => {
  it("serves an unauthenticated health probe", async () => {
    const response = await route("GET", "/health");
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ status: "ok", service: "cms-agent-mcp" });
  });

  it("retains /healthz as a backward-compatible health alias", async () => {
    const response = await route("GET", "/healthz");
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ status: "ok", service: "cms-agent-mcp" });
  });

  it("dispatches MCP tools/list through the shared endpoint core at /mcp and /api/mcp", async () => {
    for (const path of ["/mcp", "/api/mcp"]) {
      const response = await route("POST", path, { jsonrpc: "2.0", id: 1, method: "tools/list" }, AUTH);
      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body);
      const toolNames = parsed.result.tools.map((tool: { name: string }) => tool.name);
      // The full catalog is served, including the Phase 3 improvement tools (underscore wire form).
      expect(toolNames).toContain("optimizer_status");
      expect(toolNames).toContain("evaluation_run");
    }
  });

  it("rejects an unauthenticated MCP call with 401 + WWW-Authenticate", async () => {
    const response = await route("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { host: "svc.example" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Bearer");
  });

  it("serves OAuth protected-resource discovery for remote connectors", async () => {
    const response = await route("GET", "/.well-known/oauth-protected-resource", null, { host: "svc.example" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toHaveProperty("authorization_servers");
  });

  it("404s unknown paths", async () => {
    const response = await route("GET", "/nope");
    expect(response.statusCode).toBe(404);
  });
});

describe("handleNodeRequest (node:http translation)", () => {
  let server: Server;
  let baseUrl: string;
  beforeEach(async () => {
    process.env.MCP_API_TOKEN = "test-token";
    server = createServer((req, res) => void handleNodeRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it("round-trips a real MCP request over HTTP", async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) });
    expect(response.status).toBe(200);
    const parsed = await response.json();
    expect(parsed.id).toBe(7);
    expect(Array.isArray(parsed.result.tools)).toBe(true);
  });

  it("serves the canonical health route over HTTP", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ok");
  });

  describe("CORS (browser control-plane access)", () => {
    const ALLOWED_ORIGIN = "https://ui.example.com";
    const DISALLOWED_ORIGIN = "https://evil.example.com";
    beforeEach(() => { process.env.MCP_ALLOWED_ORIGINS = ALLOWED_ORIGIN; });

    it("answers an OPTIONS preflight for an allowed origin with 204 + full CORS headers, no token required", async () => {
      const response = await fetch(`${baseUrl}/mcp`, { method: "OPTIONS", headers: { origin: ALLOWED_ORIGIN } });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
      expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
      expect(response.headers.get("access-control-allow-headers")).toBe("authorization, content-type, mcp-session-id, mcp-protocol-version");
      expect(response.headers.get("access-control-max-age")).toBe("86400");
      expect(await response.text()).toBe("");
    });

    it("answers a preflight from a disallowed origin with 204 but omits every CORS header", async () => {
      const response = await fetch(`${baseUrl}/mcp`, { method: "OPTIONS", headers: { origin: DISALLOWED_ORIGIN } });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-methods")).toBeNull();
    });

    it("preflight succeeds with MCP_ALLOWED_ORIGINS unset — default deny, no CORS headers, still no token needed", async () => {
      delete process.env.MCP_ALLOWED_ORIGINS;
      const response = await fetch(`${baseUrl}/mcp`, { method: "OPTIONS", headers: { origin: ALLOWED_ORIGIN } });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("echoes Access-Control-Allow-Origin and exposes MCP session headers on a real authenticated POST from an allowed origin", async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json", origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
      expect(response.headers.get("access-control-expose-headers")).toBe("mcp-session-id, mcp-protocol-version");
    });

    it("still requires a valid bearer on POST from an allowed origin — CORS is not an auth bypass", async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      expect(response.status).toBe(401);
      // Still carries CORS headers so the browser can actually read the 401 / WWW-Authenticate
      // instead of surfacing an opaque network failure.
      expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    });

    it("a disallowed origin gets no ACAO header even on an otherwise-normal response (auth unaffected)", async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json", origin: DISALLOWED_ORIGIN },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      expect(response.status).toBe(200); // auth still succeeds — CORS and auth are independent
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("a request with no Origin header (non-browser caller) is unaffected by CORS", async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});

describe("CORS helpers (pure)", () => {
  it("parseAllowedOrigins trims, drops empties, and parses one or many origins", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins("   ")).toEqual([]);
    expect(parseAllowedOrigins("https://ui.example.com")).toEqual(["https://ui.example.com"]);
    expect(parseAllowedOrigins(" https://a.example.com , https://b.example.com ,, ")).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("isOriginAllowed matches exact entries and an explicit wildcard; an empty (unset) list denies everything", () => {
    expect(isOriginAllowed("https://ui.example.com", ["https://ui.example.com"])).toBe(true);
    expect(isOriginAllowed("https://evil.example.com", ["https://ui.example.com"])).toBe(false);
    expect(isOriginAllowed(undefined, ["https://ui.example.com"])).toBe(false);
    expect(isOriginAllowed("https://anything.example.com", ["*"])).toBe(true);
    expect(isOriginAllowed("https://ui.example.com", [])).toBe(false);
  });

  it("corsResponseHeaders echoes the origin verbatim and exposes MCP session headers only when allowed", () => {
    expect(corsResponseHeaders("https://ui.example.com", ["https://ui.example.com"])).toEqual({
      "access-control-allow-origin": "https://ui.example.com",
      "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
      vary: "origin"
    });
    // Even with a wildcard entry, the literal request origin is echoed back, never "*".
    expect(corsResponseHeaders("https://ui.example.com", ["*"])["access-control-allow-origin"]).toBe("https://ui.example.com");
    expect(corsResponseHeaders("https://evil.example.com", ["https://ui.example.com"])).toEqual({});
    expect(corsResponseHeaders(undefined, ["https://ui.example.com"])).toEqual({});
  });

  it("corsPreflightHeaders adds allow-methods/allow-headers/max-age on top of the response headers, or nothing when denied", () => {
    expect(corsPreflightHeaders("https://ui.example.com", ["https://ui.example.com"])).toEqual({
      "access-control-allow-origin": "https://ui.example.com",
      "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
      vary: "origin",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
      "access-control-max-age": "86400"
    });
    expect(corsPreflightHeaders("https://evil.example.com", ["https://ui.example.com"])).toEqual({});
    expect(corsPreflightHeaders(undefined, [])).toEqual({});
  });
});

describe("mcpStateUsesBlobs treats gcs like blobs", () => {
  it("uses the blob-shaped (GCS-backed) state store when WORKSPACE_STORE=gcs", () => {
    expect(mcpStateUsesBlobs({ WORKSPACE_STORE: "gcs" } as NodeJS.ProcessEnv)).toBe(true);
    expect(mcpStateUsesBlobs({ WORKSPACE_STORE: "blobs" } as NodeJS.ProcessEnv)).toBe(true);
    expect(mcpStateUsesBlobs({ WORKSPACE_STORE: "memory" } as NodeJS.ProcessEnv)).toBe(false);
    expect(mcpStateUsesBlobs({ WORKSPACE_STORE: "gcs", MCP_STATE_STORE: "memory" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
