import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpHttpRequest, McpHttpResponse } from "../../../src/agent/mcp/http/mcpEndpoint.js";

// Diagnostic Server-Timing instrumentation on the MCP control-plane endpoint (shared by the Cloud
// Run plane and the Netlify adapter — both call handleMcpHttp). This suite drives the endpoint
// directly, the way visualIdentityPropose.test.ts does, rather than through the Netlify handler,
// because the cold-start assertion needs a FRESH module instance (a fresh `handledFirstRequestInThis
// Process` flag) per test — see freshHandleMcpHttp below.

const TEST_TOKEN = "server-timing-suite-token";

const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.MCP_API_TOKEN = TEST_TOKEN;
  // The instrumentation mirrors MCP_TOOL_LOG's shape: off by default under VITEST, on by explicit
  // env var — exactly like a test of tool-call logging would set MCP_TOOL_LOG=on.
  process.env.MCP_SERVER_TIMING = "on";
  delete process.env.MCP_REQUIRE_SESSION;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

// Re-imports mcpEndpoint.ts as a brand-new module instance, so its module-scope cold-start flag
// starts unset again — the same way a fresh Cloud Run instance starts unset.
const freshHandleMcpHttp = async (): Promise<(request: McpHttpRequest) => Promise<McpHttpResponse>> => {
  vi.resetModules();
  const mod = await import("../../../src/agent/mcp/http/mcpEndpoint.js");
  return mod.handleMcpHttp;
};

const toolsListRequest = (id: number, token = TEST_TOKEN): McpHttpRequest => ({
  httpMethod: "POST",
  headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })
});

describe("Server-Timing diagnostics on the MCP control-plane endpoint", () => {
  it("carries a Server-Timing header with a work metric and at least one sec. metric", async () => {
    const handleMcpHttp = await freshHandleMcpHttp();
    const response = await handleMcpHttp(toolsListRequest(1));

    expect(response.statusCode).toBe(200);
    const header = response.headers["server-timing"];
    expect(header).toBeDefined();
    expect(header).toMatch(/(?:^|,\s*)work;dur=\d/);
    expect(header).toMatch(/(?:^|,\s*)sec\.[a-z_]+;dur=\d/);
    // Meaningful sections named in the task: parse, auth, dispatch, serialize should all show up on
    // a plain tools/list call (no session header, so no sec.session on this particular request).
    expect(header).toContain("sec.parse;");
    expect(header).toContain("sec.auth;");
    expect(header).toContain("sec.dispatch;");
    expect(header).toContain("sec.serialize;");
  });

  it("flags only the FIRST request handled by a fresh module instance as cold", async () => {
    const handleMcpHttp = await freshHandleMcpHttp();

    const first = await handleMcpHttp(toolsListRequest(1));
    const second = await handleMcpHttp(toolsListRequest(2));

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.headers["server-timing"]).toMatch(/(?:^|,\s*)cold;dur=1(?:,|$)/);
    expect(second.headers["server-timing"]).not.toMatch(/\bcold\b/);
  });

  it("never puts a token value anywhere in the Server-Timing header", async () => {
    const handleMcpHttp = await freshHandleMcpHttp();

    const authed = await handleMcpHttp(toolsListRequest(1));
    const rejected = await handleMcpHttp(toolsListRequest(2, "wrong-token"));

    expect(authed.headers["server-timing"] ?? "").not.toContain(TEST_TOKEN);
    // The endpoint still times the (failed) auth resolution on a 401, and that header must be just
    // as clean of the presented token as a successful call's header is of the real one.
    expect(rejected.statusCode).toBe(401);
    expect(rejected.headers["server-timing"] ?? "").not.toContain("wrong-token");
    expect(rejected.headers["server-timing"] ?? "").not.toContain(TEST_TOKEN);
  });

  it("is off by default under VITEST (no header) and back on when MCP_SERVER_TIMING=on", async () => {
    const handleMcpHttp = await freshHandleMcpHttp();
    delete process.env.MCP_SERVER_TIMING;
    const withoutFlag = await handleMcpHttp(toolsListRequest(1));
    expect(withoutFlag.headers["server-timing"]).toBeUndefined();

    process.env.MCP_SERVER_TIMING = "on";
    const withFlag = await handleMcpHttp(toolsListRequest(2));
    expect(withFlag.headers["server-timing"]).toBeDefined();
  });

  it("never disturbs the client-gone/499 path — no Server-Timing header, response untouched", async () => {
    const handleMcpHttp = await freshHandleMcpHttp();
    const controller = new AbortController();
    controller.abort();
    const response = await handleMcpHttp({ ...toolsListRequest(1), signal: controller.signal });
    expect(response.statusCode).toBe(499);
    expect(response.headers["server-timing"]).toBeUndefined();
  });
});
