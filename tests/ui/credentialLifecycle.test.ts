import { afterEach, describe, expect, it, vi } from "vitest";
import { callMcpMethod, callMcpTool, createMcpClient, McpClientError } from "../../ui/src/mcp/client.js";
import type { McpConnection } from "../../ui/src/connection.js";

// The mock server echoes a JSON-RPC result; each test inspects the requests the client actually
// sent (URL + Authorization header), which is the contract the credential lifecycle must uphold.
// Cloud Run is the sole control plane and always uses direct bearer-token auth — there is no
// alternate connection mode to test.
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

const direct = (token: string, endpoint = "https://cms-agent-mcp.example.run.app/mcp"): McpConnection => ({ endpoint, token });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initial token entry", () => {
  it("refuses to send a request without a token, before any network call", async () => {
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
    expect(sent[0].url).toBe("https://cms-agent-mcp.example.run.app/mcp");
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
  it("changing the endpoint (e.g. a local-dev override) keeps the same credential behavior", async () => {
    const sent = stubFetch();
    let connection = direct("stable-token", "https://cms-agent-mcp.example.run.app/mcp");
    const client = createMcpClient(() => connection);
    await client.method("initialize");
    connection = direct("stable-token", "http://localhost:9999/mcp");
    await client.method("initialize");
    expect(sent.map((request) => request.url)).toEqual(["https://cms-agent-mcp.example.run.app/mcp", "http://localhost:9999/mcp"]);
    expect(new Set(sent.map((request) => request.authorization))).toEqual(new Set(["Bearer stable-token"]));
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
