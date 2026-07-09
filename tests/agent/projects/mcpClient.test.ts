import { describe, expect, it } from "vitest";
import { McpClientError, mcpInitialize, mcpListTools, type McpTransport } from "../../../src/agent/projects/mcpClient.js";

const jsonResponse = (payload: unknown): Awaited<ReturnType<McpTransport>> => ({
  ok: true,
  status: 200,
  headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
  json: async () => payload,
  text: async () => JSON.stringify(payload)
});

const sseResponse = (body: string): Awaited<ReturnType<McpTransport>> => ({
  ok: true,
  status: 200,
  headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream; charset=utf-8" : null) },
  json: async () => { throw new Error("event stream is not JSON"); },
  text: async () => body
});

describe("project MCP client transport", () => {
  it("advertises both application/json and text/event-stream in Accept", async () => {
    let accept = "";
    const transport: McpTransport = async (_endpoint, init) => { accept = init.headers.accept; return jsonResponse({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: {} }); };

    await mcpInitialize({ endpoint: "https://project.example/mcp", transport });

    expect(accept).toContain("application/json");
    expect(accept).toContain("text/event-stream");
  });

  it("parses a Streamable HTTP SSE (text/event-stream) response", async () => {
    const transport: McpTransport = async (_endpoint, init) => {
      const { id } = JSON.parse(init.body) as { id: number };
      const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "sse-mcp", version: "2.0.0" } } })}\n\n`;
      return sseResponse(body);
    };

    const result = await mcpInitialize({ endpoint: "https://project.example/mcp", transport });

    expect(result.serverInfo).toEqual({ name: "sse-mcp", version: "2.0.0" });
    expect(result.protocolVersion).toBe("2025-06-18");
  });

  it("still handles a single application/json response", async () => {
    const transport: McpTransport = async (_endpoint, init) => jsonResponse({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: { tools: [{ name: "remote.tool" }] } });
    const result = await mcpListTools({ endpoint: "https://project.example/mcp", transport });
    expect(result.tools).toEqual([{ name: "remote.tool" }]);
  });

  it("never surfaces untrusted remote JSON-RPC error text (which could echo the token)", async () => {
    const SECRET = "super-secret-token";
    const transport: McpTransport = async (_endpoint, init) => jsonResponse({ jsonrpc: "2.0", id: JSON.parse(init.body).id, error: { code: -32000, message: `unauthorized: Bearer ${SECRET}` } });

    let thrown: unknown;
    try {
      await mcpListTools({ endpoint: "https://project.example/mcp", token: SECRET, transport });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpClientError);
    expect((thrown as McpClientError).message).toBe("The project MCP server returned an error.");
    expect((thrown as McpClientError).message).not.toContain(SECRET);
    expect((thrown as McpClientError).code).toBe(-32000);
  });

  it("reports a generic error when an SSE stream carries no JSON-RPC response", async () => {
    const transport: McpTransport = async () => sseResponse("event: ping\ndata: not-json\n\n");
    await expect(mcpInitialize({ endpoint: "https://project.example/mcp", transport })).rejects.toThrowError("MCP event stream did not include a JSON-RPC response.");
  });
});
