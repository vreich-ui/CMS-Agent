// Minimal JSON-RPC MCP client for primitive, guarded calls against external project MCP servers
// (initialize, tools/list, tools/call). It never logs request/response bodies, headers, or tokens.
// The bearer token is only ever placed in the Authorization header and is never echoed in errors.
//
// Transport: MCP Streamable HTTP servers may reply with either a single JSON body
// (application/json) or an SSE stream (text/event-stream). We advertise both in Accept and handle
// both, so strict spec-compliant servers are supported and don't reject us with 406.

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "cms-agent", version: "0.1.0" };

export type McpResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
};

export type McpTransport = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<McpResponse>;

export type McpClientOptions = {
  endpoint: string;
  token?: string;
  transport?: McpTransport;
};

export type RemoteTool = { name: string; description?: string; inputSchema?: unknown };

export class McpClientError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = "McpClientError";
  }
}

type JsonRpcResponse<T> = { jsonrpc: "2.0"; id: number | string | null; result?: T; error?: { code: number; message: string; data?: unknown } };

let requestCounter = 0;

const defaultTransport: McpTransport = (input, init) => fetch(input, init) as unknown as Promise<McpResponse>;

// Extract the JSON-RPC message matching our request id from an SSE stream. Each SSE event's `data:`
// lines carry a complete JSON-RPC message; non-JSON events (comments, pings) are ignored.
function parseEventStream<T>(raw: string, id: number): JsonRpcResponse<T> | undefined {
  const messages: JsonRpcResponse<T>[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.replace(/^data:\s?/, "")).join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data) as JsonRpcResponse<T>);
    } catch {
      // Ignore non-JSON SSE events.
    }
  }
  return messages.find((message) => message.id === id) ?? messages.find((message) => message.result !== undefined || message.error !== undefined);
}

async function readPayload<T>(response: McpResponse, id: number): Promise<JsonRpcResponse<T>> {
  const contentType = response.headers?.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (!response.text) throw new McpClientError("MCP event stream response could not be read.");
    let raw: string;
    try {
      raw = await response.text();
    } catch {
      throw new McpClientError("MCP event stream response could not be read.");
    }
    const payload = parseEventStream<T>(raw, id);
    if (!payload) throw new McpClientError("MCP event stream did not include a JSON-RPC response.");
    return payload;
  }
  try {
    return (await response.json()) as JsonRpcResponse<T>;
  } catch {
    throw new McpClientError("MCP response was not valid JSON.");
  }
}

async function rpc<T>(options: McpClientOptions, method: string, params?: Record<string, unknown>): Promise<T> {
  const transport = options.transport ?? defaultTransport;
  const id = ++requestCounter;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  // Token is used only as a bearer header and is never logged.
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await transport(options.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })
  });

  if (!response.ok) throw new McpClientError(`MCP request failed with HTTP ${response.status}.`);

  const payload = await readPayload<T>(response, id);
  // The remote error message is untrusted text (it may echo the bearer token or a credential-bearing
  // URL back to us), so it is never surfaced. Only the numeric JSON-RPC error code is retained.
  if (payload.error) throw new McpClientError("The project MCP server returned an error.", payload.error.code);
  if (payload.result === undefined) throw new McpClientError("MCP response did not include a result.");
  return payload.result;
}

export type InitializeResult = {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
};

export const mcpInitialize = (options: McpClientOptions): Promise<InitializeResult> =>
  rpc<InitializeResult>(options, "initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });

export const mcpListTools = (options: McpClientOptions): Promise<{ tools: RemoteTool[] }> =>
  rpc<{ tools: RemoteTool[] }>(options, "tools/list");

export const mcpListResources = (options: McpClientOptions): Promise<{ resources: Array<{ uri: string; name?: string; mimeType?: string }> }> =>
  rpc<{ resources: Array<{ uri: string; name?: string; mimeType?: string }> }>(options, "resources/list");

export const mcpCallTool = (options: McpClientOptions, name: string, args: Record<string, unknown> = {}): Promise<unknown> =>
  rpc<unknown>(options, "tools/call", { name, arguments: args });
