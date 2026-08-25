/**
 * MCP Streamable-HTTP client for the CMS Agent workspace endpoint.
 *
 * Protocol notes (see WP-04 brief):
 *  - JSON-RPC 2.0 over POST.
 *  - `initialize` returns an `Mcp-Session-Id` RESPONSE header; every
 *    subsequent request sends it back as a REQUEST header.
 *  - Responses may be plain JSON or an SSE stream (`text/event-stream`);
 *    request `Accept: application/json, text/event-stream` and handle both.
 *  - Tool results are wrapped in MCP content blocks; the workspace's own
 *    payload is JSON text of shape `{ok:true,data:...}` or
 *    `{ok:false,error:...}` inside the first text content block.
 *  - `DELETE` with the session header ends the session.
 *
 * The bearer token lives ONLY in the Authorization header built here. It
 * is never logged, never echoed in an error, never returned to a caller.
 */

const PROTOCOL_VERSION = "2025-06-18";

export class McpError extends Error {
  /** Backend's own error code/shape, when it provided one. */
  readonly upstreamCode?: string;
  constructor(message: string, upstreamCode?: string) {
    super(message);
    this.name = "McpError";
    this.upstreamCode = upstreamCode;
  }
}

export interface McpClientOptions {
  url: string;
  token: string;
  mock?: boolean;
  /** Overridable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

let nextRequestId = 1;

/** Parses a response body as either JSON or an SSE stream, returning the JSON-RPC message. */
async function parseRpcResponse(res: Response): Promise<JsonRpcResponse> {
  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    let last: JsonRpcResponse | null = null;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (!payload) continue;
      try {
        last = JSON.parse(payload) as JsonRpcResponse;
      } catch {
        // ignore non-JSON SSE lines (comments/keepalives)
      }
    }
    if (!last) {
      throw new McpError("MCP upstream returned an SSE stream with no parsable JSON-RPC data line.");
    }
    return last;
  }

  const text = await res.text();
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new McpError(`MCP upstream returned a non-JSON, non-SSE response (status ${res.status}).`);
  }
}

interface ToolCallPayload {
  ok: true;
  data: unknown;
}
interface ToolCallError {
  ok: false;
  error: unknown;
}

/** Unwraps the workspace's own {ok,data|error} envelope out of an MCP tool result. */
function unwrapToolResult(result: unknown, verb: string): unknown {
  if (!result || typeof result !== "object") {
    throw new McpError(`MCP tool "${verb}" returned an unexpected result shape.`);
  }
  const r = result as { content?: unknown; isError?: boolean };
  if (!Array.isArray(r.content) || r.content.length === 0) {
    throw new McpError(`MCP tool "${verb}" returned no content blocks.`);
  }
  const first = r.content[0] as { type?: string; text?: string };
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new McpError(`MCP tool "${verb}" returned a non-text first content block.`);
  }

  let envelope: ToolCallPayload | ToolCallError;
  try {
    envelope = JSON.parse(first.text) as ToolCallPayload | ToolCallError;
  } catch {
    throw new McpError(`MCP tool "${verb}" returned a content block that was not valid JSON.`);
  }

  if (envelope.ok === true) {
    return envelope.data;
  }

  // Surface the backend's own error text verbatim, never a generic message.
  const errText =
    typeof envelope.error === "string"
      ? envelope.error
      : envelope.error && typeof envelope.error === "object" && "message" in envelope.error
        ? String((envelope.error as { message?: unknown }).message)
        : JSON.stringify(envelope.error);
  throw new McpError(errText);
}

function isSessionExpiredError(err: JsonRpcErrorShape | undefined, httpStatus: number): boolean {
  if (httpStatus === 404 || httpStatus === 400) return true;
  if (!err) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("session") && (msg.includes("expired") || msg.includes("unknown") || msg.includes("not found") || msg.includes("invalid"));
}

export class McpClient {
  private readonly url: string;
  private readonly token: string;
  private readonly mock: boolean;
  private readonly fetchImpl: typeof fetch;

  private sessionId: string | null = null;
  private initPromise: Promise<string> | null = null;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.mock = opts.mock ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get workspaceVersion(): string {
    return this.mock ? "mock" : PROTOCOL_VERSION;
  }

  /** True once a session has been established (used by /api/health). */
  get hasSession(): boolean {
    return this.sessionId !== null;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.token}`,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...extra,
    };
  }

  /**
   * Ensures a session exists, initializing (and de-duping concurrent
   * initializes via a single in-flight promise) if needed.
   */
  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initialize().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async initialize(): Promise<string> {
    if (this.mock) {
      this.sessionId = "mock-session-id";
      return this.sessionId;
    }

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: nextRequestId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "conductor-workbench-broker", version: "1.0.0" },
        capabilities: {},
      },
    };

    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(req),
    });

    const sessionId = res.headers.get("mcp-session-id");
    const rpc = await parseRpcResponse(res);

    if (!res.ok || rpc.error) {
      throw new McpError(rpc.error?.message ?? `MCP initialize failed with HTTP ${res.status}.`);
    }
    if (!sessionId) {
      throw new McpError("MCP upstream did not return an Mcp-Session-Id header on initialize.");
    }

    this.sessionId = sessionId;

    // Best-effort initialized notification; failure here is not fatal.
    try {
      await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
    } catch {
      // ignore
    }

    return sessionId;
  }

  /** Calls an MCP tool by verb name, returning the unwrapped `data` payload. */
  async callTool(verb: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.mock) {
      await this.ensureSession();
      return mockToolResult(verb, args);
    }

    await this.ensureSession();
    return this.callToolOnce(verb, args, /* allowRetry */ true);
  }

  private async callToolOnce(verb: string, args: Record<string, unknown>, allowRetry: boolean): Promise<unknown> {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: nextRequestId++,
      method: "tools/call",
      params: { name: verb, arguments: args },
    };

    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(req),
    });

    const rpc = await parseRpcResponse(res);

    if (rpc.error && isSessionExpiredError(rpc.error, res.status) && allowRetry) {
      this.sessionId = null;
      await this.ensureSession();
      return this.callToolOnce(verb, args, false);
    }

    if (!res.ok && isSessionExpiredError(rpc.error, res.status) && allowRetry) {
      this.sessionId = null;
      await this.ensureSession();
      return this.callToolOnce(verb, args, false);
    }

    if (rpc.error) {
      throw new McpError(rpc.error.message, String(rpc.error.code));
    }
    if (!res.ok) {
      throw new McpError(`MCP tool "${verb}" call failed with HTTP ${res.status}.`);
    }

    return unwrapToolResult(rpc.result, verb);
  }

  /** Ends the session with the upstream, if one is open. Safe to call multiple times. */
  async shutdown(): Promise<void> {
    if (this.mock) {
      this.sessionId = null;
      return;
    }
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    try {
      await this.fetchImpl(this.url, {
        method: "DELETE",
        headers: this.headers({ "Mcp-Session-Id": sessionId }),
      });
    } catch {
      // best-effort; nothing to recover from on shutdown
    }
  }

  /** Lightweight reachability probe used by /api/health. Does not throw. */
  async probe(): Promise<{ reachable: boolean; workspaceVersion: string }> {
    if (this.mock) {
      return { reachable: true, workspaceVersion: this.workspaceVersion };
    }
    try {
      await this.ensureSession();
      return { reachable: true, workspaceVersion: this.workspaceVersion };
    } catch {
      return { reachable: false, workspaceVersion: this.workspaceVersion };
    }
  }
}

/** Canned results for MOCK_UPSTREAM=1, keyed loosely by verb shape. */
function mockToolResult(verb: string, args: Record<string, unknown>): unknown {
  return {
    mock: true,
    verb,
    args,
    note: "MOCK_UPSTREAM=1: this is a canned response, no real MCP backend was called.",
    receivedAt: new Date().toISOString(),
  };
}
