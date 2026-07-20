import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { routeControlPlaneRequest } from "../../../src/agent/mcp/http/controlPlaneRouter.js";
import { handleNodeRequest } from "../../../src/agent/entrypoints/mcpServerMain.js";
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

  it("serves health over HTTP", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ok");
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
