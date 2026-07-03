export class McpClientError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
  }
}

type JsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: { structuredContent?: { ok: boolean; data?: T; error?: unknown } };
  error?: { message: string; data?: unknown };
};

export type McpClientConfig = {
  endpoint: string;
  token: string;
};

export async function callMcpTool<T>(config: McpClientConfig, name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!config.token.trim()) throw new McpClientError("Enter an MCP bearer token before calling workspace tools.");

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } })
  });

  const payload = (await response.json().catch(() => null)) as JsonRpcResponse<T> | null;
  if (!response.ok) throw new McpClientError(`MCP request failed with HTTP ${response.status}.`, payload);
  if (!payload) throw new McpClientError("MCP response was not valid JSON.");
  if (payload.error) throw new McpClientError(payload.error.message, payload.error.data);

  const envelope = payload.result?.structuredContent;
  if (!envelope?.ok) throw new McpClientError("MCP tool returned an error.", envelope?.error ?? payload);
  return envelope.data as T;
}
