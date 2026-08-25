import { test } from "node:test";
import assert from "node:assert/strict";
import { McpClient, McpError } from "./mcp.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sseResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  return new Response(text, {
    status,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function toolResultEnvelope(id: number, payload: { ok: true; data: unknown } | { ok: false; error: unknown }) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    },
  };
}

test("mcp: unwraps {ok:true,data} content block on tools/call", async () => {
  let call = 0;
  const fetchStub = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    call += 1;
    const body = JSON.parse(String(init?.body)) as { method: string; id: number };
    if (body.method === "initialize") {
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: {} }, { "mcp-session-id": "sess-1" });
    }
    if (body.method === "notifications/initialized") {
      return jsonResponse(200, {});
    }
    if (body.method === "tools/call") {
      return jsonResponse(200, toolResultEnvelope(body.id, { ok: true, data: { hello: "world" } }));
    }
    throw new Error(`unexpected method ${body.method}`);
  }) as typeof fetch;

  const client = new McpClient({ url: "http://mock.invalid/mcp", token: "t", fetchImpl: fetchStub });
  const data = await client.callTool("workflow_list_runs", {});
  assert.deepEqual(data, { hello: "world" });
  assert.ok(call >= 2);
});

test("mcp: throws the backend's own error text verbatim on {ok:false}", async () => {
  const fetchStub = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id: number };
    if (body.method === "initialize") {
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: {} }, { "mcp-session-id": "sess-1" });
    }
    if (body.method === "notifications/initialized") return jsonResponse(200, {});
    if (body.method === "tools/call") {
      return jsonResponse(200, toolResultEnvelope(body.id, { ok: false, error: "node not found: xyz" }));
    }
    throw new Error("unexpected");
  }) as typeof fetch;

  const client = new McpClient({ url: "http://mock.invalid/mcp", token: "t", fetchImpl: fetchStub });
  await assert.rejects(() => client.callTool("workflow_get_run", {}), (err: unknown) => {
    assert.ok(err instanceof McpError);
    assert.equal(err.message, "node not found: xyz");
    return true;
  });
});

test("mcp: parses an SSE response and unwraps the JSON-RPC data line", async () => {
  const fetchStub = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id: number };
    if (body.method === "initialize") {
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: {} }, { "mcp-session-id": "sess-1" });
    }
    if (body.method === "notifications/initialized") return jsonResponse(200, {});
    if (body.method === "tools/call") {
      return sseResponse(200, toolResultEnvelope(body.id, { ok: true, data: { via: "sse" } }));
    }
    throw new Error("unexpected");
  }) as typeof fetch;

  const client = new McpClient({ url: "http://mock.invalid/mcp", token: "t", fetchImpl: fetchStub });
  const data = await client.callTool("workflow_list_runs", {});
  assert.deepEqual(data, { via: "sse" });
});

test("mcp: re-initializes and retries once on expired session, then succeeds", async () => {
  let sessionCounter = 0;
  let toolCallAttempts = 0;
  const fetchStub = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id: number };
    if (body.method === "initialize") {
      sessionCounter += 1;
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: {} }, { "mcp-session-id": `sess-${sessionCounter}` });
    }
    if (body.method === "notifications/initialized") return jsonResponse(200, {});
    if (body.method === "tools/call") {
      toolCallAttempts += 1;
      if (toolCallAttempts === 1) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32000, message: "Session expired or unknown" },
        });
      }
      return jsonResponse(200, toolResultEnvelope(body.id, { ok: true, data: { recovered: true } }));
    }
    throw new Error("unexpected");
  }) as typeof fetch;

  const client = new McpClient({ url: "http://mock.invalid/mcp", token: "t", fetchImpl: fetchStub });
  const data = await client.callTool("workflow_list_runs", {});
  assert.deepEqual(data, { recovered: true });
  assert.equal(sessionCounter, 2, "should have re-initialized exactly once");
  assert.equal(toolCallAttempts, 2, "should have retried tools/call exactly once");
});

test("mcp: concurrent calls before init only trigger a single initialize (mutex)", async () => {
  let initCount = 0;
  const fetchStub = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id: number };
    if (body.method === "initialize") {
      initCount += 1;
      // Simulate network latency so concurrent calls race.
      await new Promise((r) => setTimeout(r, 10));
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: {} }, { "mcp-session-id": "sess-1" });
    }
    if (body.method === "notifications/initialized") return jsonResponse(200, {});
    if (body.method === "tools/call") {
      return jsonResponse(200, toolResultEnvelope(body.id, { ok: true, data: { n: body.id } }));
    }
    throw new Error("unexpected");
  }) as typeof fetch;

  const client = new McpClient({ url: "http://mock.invalid/mcp", token: "t", fetchImpl: fetchStub });
  const [a, b, c] = await Promise.all([
    client.callTool("workflow_list_runs", {}),
    client.callTool("workflow_list_runs", {}),
    client.callTool("workflow_list_runs", {}),
  ]);
  assert.ok(a && b && c);
  assert.equal(initCount, 1, "concurrent calls should share a single in-flight initialize");
});

test("mcp: mock mode returns canned results without any network calls", async () => {
  const fetchStub = (async () => {
    throw new Error("fetch should not be called in mock mode");
  }) as typeof fetch;

  const client = new McpClient({ url: "http://mock.invalid/mcp", token: "t", mock: true, fetchImpl: fetchStub });
  const data = (await client.callTool("workflow_list_runs", { foo: "bar" })) as Record<string, unknown>;
  assert.equal(data.mock, true);
  assert.equal(data.verb, "workflow_list_runs");
});
