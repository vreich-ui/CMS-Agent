import { afterEach, describe, expect, it, vi } from "vitest";
import { callMcpMethod, callMcpTool, createMcpClient, McpClientError } from "../../ui/src/mcp/client.js";
import type { McpConnection } from "../../ui/src/connection.js";

// The mock server echoes a JSON-RPC result; each test inspects the requests the client actually
// sent (URL + Authorization header), which is the contract the credential lifecycle must uphold.
type SentRequest = { url: string; authorization: string | undefined; body: unknown };

function stubFetch(handler?: (request: SentRequest) => { status?: number; payload?: unknown }) {
  const sent: SentRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const request: SentRequest = {
      url: String(url),
      authorization: (init.headers as Record<string, string>).authorization,
      body: JSON.parse(String(init.body))
    };
    sent.push(request);
    const { status = 200, payload = { jsonrpc: "2.0", id: 1, result: { ok: true } } } = handler?.(request) ?? {};
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  }));
  return sent;
}

const direct = (token: string, endpoint = "/api/mcp"): McpConnection => ({ mode: "direct", endpoint, token });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initial token entry", () => {
  it("refuses to send a direct request without a token, before any network call", async () => {
    const sent = stubFetch();
    await expect(callMcpMethod(direct(""), "initialize")).rejects.toThrow("Enter an MCP bearer token");
    expect(sent).toHaveLength(0);
  });

  it("uses a newly entered token on the next request without changing the endpoint", async () => {
    const sent = stubFetch();
    const getConnection = vi.fn(() => direct(""));
    const client = createMcpClient(getConnection);
    await expect(client.method("initialize")).rejects.toThrow(McpClientError);

    getConnection.mockReturnValue(direct("first-token"));
    await client.method("initialize");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/mcp");
    expect(sent[0].authorization).toBe("Bearer first-token");
  });
});

describe("token replacement and clearing", () => {
  it("a replaced token affects the next request", async () => {
    const sent = stubFetch();
    let connection = direct("old-token");
    const client = createMcpClient(() => connection);
    await client.method("initialize");
    connection = direct("new-token");
    await client.method("initialize");
    expect(sent.map((request) => request.authorization)).toEqual(["Bearer old-token", "Bearer new-token"]);
  });

  it("a cleared token is removed from subsequent requests (no request is sent at all)", async () => {
    const sent = stubFetch();
    let connection = direct("live-token");
    const client = createMcpClient(() => connection);
    await client.method("initialize");
    connection = direct("");
    await expect(client.method("initialize")).rejects.toThrow("Enter an MCP bearer token");
    expect(sent).toHaveLength(1); // only the first call reached the network
  });
});

describe("endpoint changes", () => {
  it("changing the endpoint keeps the same credential behavior in direct mode", async () => {
    const sent = stubFetch();
    let connection = direct("stable-token", "/api/mcp");
    const client = createMcpClient(() => connection);
    await client.method("initialize");
    connection = direct("stable-token", "http://localhost:9999/api/mcp");
    await client.method("initialize");
    expect(sent.map((request) => request.url)).toEqual(["/api/mcp", "http://localhost:9999/api/mcp"]);
    expect(new Set(sent.map((request) => request.authorization))).toEqual(new Set(["Bearer stable-token"]));
  });

  it("regression: a direct token is still sent when the endpoint happens to be the deployed proxy path", async () => {
    // The old implementation inferred secure-proxy mode from this exact string and silently
    // dropped the manual token (docs/constellation/data-model-gaps.md §1).
    const sent = stubFetch();
    await callMcpMethod(direct("manual-token", "/api/workspace-mcp"), "initialize");
    expect(sent[0].authorization).toBe("Bearer manual-token");
  });
});

describe("connection-mode changes", () => {
  it("switching direct -> secure-proxy swaps the credential source on the next request", async () => {
    const sent = stubFetch();
    let connection: McpConnection = direct("manual-token");
    const client = createMcpClient(() => connection);
    await client.method("initialize");

    connection = { mode: "secure-proxy", endpoint: "/api/workspace-mcp", getAccessToken: async () => "identity-jwt" };
    await client.method("initialize");

    expect(sent.map((request) => request.authorization)).toEqual(["Bearer manual-token", "Bearer identity-jwt"]);
    expect(sent.map((request) => request.url)).toEqual(["/api/mcp", "/api/workspace-mcp"]);
  });

  it("switching secure-proxy -> direct stops calling the identity getter", async () => {
    const sent = stubFetch();
    const getAccessToken = vi.fn(async () => "identity-jwt");
    let connection: McpConnection = { mode: "secure-proxy", endpoint: "/api/workspace-mcp", getAccessToken };
    const client = createMcpClient(() => connection);
    await client.method("initialize");
    connection = direct("manual-token");
    await client.method("initialize");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(sent[1].authorization).toBe("Bearer manual-token");
  });
});

describe("stale closure regression", () => {
  it("a captured client function uses the credential current at call time, not capture time", async () => {
    const sent = stubFetch();
    let connection = direct("");
    const client = createMcpClient(() => connection);

    // Simulate a mount-only effect capturing the call function before any token exists.
    const capturedAtMount = client.call;
    await expect(capturedAtMount("workspace.get_nodes")).rejects.toThrow(McpClientError);

    connection = direct("entered-later");
    const sentAfterToken = stubFetch(() => ({
      payload: { jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: true, data: { nodes: [] } } } }
    }));
    await capturedAtMount("workspace.get_nodes");

    connection = direct("rotated-token");
    await capturedAtMount("workspace.get_nodes");

    expect(sentAfterToken.map((request) => request.authorization)).toEqual(["Bearer entered-later", "Bearer rotated-token"]);
    expect(sent).toHaveLength(0); // the pre-token attempt never reached the network
  });
});

describe("secure-proxy requests", () => {
  it("resolves the identity token per request so a renewed JWT is picked up", async () => {
    const sent = stubFetch();
    const tokens = ["jwt-1", "jwt-2"];
    const getAccessToken = vi.fn(async () => tokens.shift());
    const connection: McpConnection = { mode: "secure-proxy", endpoint: "/api/workspace-mcp", getAccessToken };
    const client = createMcpClient(() => connection);
    await client.method("initialize");
    await client.method("initialize");
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(sent.map((request) => request.authorization)).toEqual(["Bearer jwt-1", "Bearer jwt-2"]);
  });

  it("fails without a network call when no identity session is available", async () => {
    const sent = stubFetch();
    const connection: McpConnection = { mode: "secure-proxy", endpoint: "/api/workspace-mcp", getAccessToken: async () => undefined };
    await expect(callMcpMethod(connection, "initialize")).rejects.toThrow("No identity session is available");
    expect(sent).toHaveLength(0);
  });
});

describe("redaction", () => {
  it("redacts bearer values echoed in server error payloads", async () => {
    stubFetch(() => ({
      status: 500,
      payload: { jsonrpc: "2.0", id: 1, error: { message: "upstream rejected Bearer super-secret-token", data: { authorization: "Bearer super-secret-token", note: "sent Bearer super-secret-token" } } }
    }));
    const failure = await callMcpMethod(direct("super-secret-token"), "initialize").catch((error: McpClientError) => error);
    const serialized = JSON.stringify({ message: (failure as McpClientError).message, details: (failure as McpClientError).details });
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).toContain("[redacted]");
  });

  it("redacts JSON-RPC error messages and credential-named keys in error data", async () => {
    stubFetch(() => ({
      payload: { jsonrpc: "2.0", id: 1, error: { message: "auth failed for Bearer abc.def-123", data: { api_key: "raw-key", token: "raw-token", nested: { cookie: "session=raw", safe: "keep-me" } } } }
    }));
    const failure = await callMcpMethod(direct("abc.def-123"), "initialize").catch((error: McpClientError) => error);
    const err = failure as McpClientError;
    expect(err.message).toBe("auth failed for Bearer [redacted]");
    expect(err.details).toEqual({ api_key: "[redacted]", token: "[redacted]", nested: { cookie: "[redacted]", safe: "keep-me" } });
  });

  it("tool-envelope errors are redacted too", async () => {
    stubFetch(() => ({
      payload: { jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: false, error: { message: "denied", authorization: "Bearer leak-me" } } } }
    }));
    const failure = await callMcpTool(direct("leak-me"), "workspace.get_nodes").catch((error: McpClientError) => error);
    expect(JSON.stringify((failure as McpClientError).details)).not.toContain("leak-me");
  });
});
