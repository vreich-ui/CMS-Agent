// Minimal JSON-RPC MCP client for primitive, guarded calls against external project MCP servers
// (initialize, tools/list, tools/call). It never logs request/response bodies, headers, or tokens.
// The bearer token is only ever placed in the Authorization header and is never echoed in errors.

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "cms-agent", version: "0.1.0" };

export type McpTransport = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

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

const defaultTransport: McpTransport = (input, init) => fetch(input, init) as unknown as ReturnType<McpTransport>;

async function rpc<T>(options: McpClientOptions, method: string, params?: Record<string, unknown>): Promise<T> {
  const transport = options.transport ?? defaultTransport;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  // Token is used only as a bearer header and is never logged.
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await transport(options.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestCounter, method, params: params ?? {} })
  });

  if (!response.ok) throw new McpClientError(`MCP request failed with HTTP ${response.status}.`);

  let payload: JsonRpcResponse<T>;
  try {
    payload = (await response.json()) as JsonRpcResponse<T>;
  } catch {
    throw new McpClientError("MCP response was not valid JSON.");
  }
  if (payload.error) throw new McpClientError(payload.error.message, payload.error.code);
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
