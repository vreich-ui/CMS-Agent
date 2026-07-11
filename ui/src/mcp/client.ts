import { redactSecretText, redactSecretValue } from "../connection.js";
import type { McpConnection } from "../connection.js";

// Every thrown error passes through redaction so bearer values can never reach logs, status
// banners, or serialized error details — even when a server response echoes a header.
export class McpClientError extends Error {
  public readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(redactSecretText(message));
    this.details = details === undefined ? undefined : redactSecretValue(details);
  }
}

type JsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { message: string; data?: unknown };
};

type McpToolResult<T> = {
  structuredContent?: { ok: boolean; data?: T; error?: unknown };
};

// Resolve the Authorization header for the connection, or throw before any request leaves the
// browser. Direct mode requires a non-empty manual token; secure-proxy mode fetches a fresh
// identity token per request (so renewal/expiry is handled at call time, never captured).
async function resolveAuthorization(connection: McpConnection): Promise<string> {
  if (connection.mode === "direct") {
    const token = connection.token.trim();
    if (!token) throw new McpClientError("Enter an MCP bearer token before calling workspace tools.");
    return `Bearer ${token}`;
  }
  const accessToken = (await connection.getAccessToken())?.trim();
  if (!accessToken) throw new McpClientError("No identity session is available for the secure proxy. Log in and try again.");
  return `Bearer ${accessToken}`;
}

export async function callMcpMethod<T>(connection: McpConnection, method: string, params?: Record<string, unknown>): Promise<T> {
  const authorization = await resolveAuthorization(connection);

  const response = await fetch(connection.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? {} })
  });

  const payload = (await response.json().catch(() => null)) as JsonRpcResponse<T> | null;
  if (!response.ok) throw new McpClientError(`MCP request failed with HTTP ${response.status}.`, payload);
  if (!payload) throw new McpClientError("MCP response was not valid JSON.");
  if (payload.error) throw new McpClientError(payload.error.message, payload.error.data);
  if (payload.result === undefined) throw new McpClientError("MCP response did not include a result.", payload);

  return payload.result;
}

export async function callMcpTool<T>(connection: McpConnection, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await callMcpMethod<McpToolResult<T>>(connection, "tools/call", { name, arguments: args });
  const envelope = result.structuredContent;
  if (!envelope?.ok) throw new McpClientError("MCP tool returned an error.", envelope?.error ?? result);
  return envelope.data as T;
}

export type McpClient = {
  method: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  call: <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
};

// Client whose functions resolve the connection at call time. Callers may freely capture
// `client.call` in memoized callbacks or mount-only effects: the credential used is always the
// one current when the request fires, so stale closures can no longer pin stale credentials.
export function createMcpClient(getConnection: () => McpConnection): McpClient {
  return {
    method: <T,>(method: string, params?: Record<string, unknown>) => callMcpMethod<T>(getConnection(), method, params),
    call: <T,>(name: string, args: Record<string, unknown> = {}) => callMcpTool<T>(getConnection(), name, args)
  };
}
