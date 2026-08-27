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
 *  - The endpoint also accepts a JSON-RPC BATCH — a top-level JSON array of
 *    request objects — and answers with either one JSON array response body
 *    or an SSE stream carrying one `data:` line per response (Track A,
 *    A1.4). `callToolsBatch` below sends one such array per HTTP call so
 *    the `/api/bootstrap` composition (see bootstrap.ts) costs one round
 *    trip to the upstream workspace, not N.
 *
 * The bearer token lives ONLY in the Authorization header built here. It
 * is never logged, never echoed in an error, never returned to a caller.
 *
 * Every upstream call carries an AbortSignal.timeout so a stalled upstream
 * request-handler thread never pins a Cloud Run instance open indefinitely
 * (Track A, A1.4). Callers (index.ts) pass a shorter timeout for
 * policy.ts-classified "read" verbs and the default for everything else.
 */

const PROTOCOL_VERSION = "2025-06-18";

/** Sane default for any upstream call. Exported so index.ts can use the same constant for the
 *  READ_TIMEOUT_MS-vs-default decision instead of a second hardcoded number drifting from this one. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Shorter timeout for policy.ts "read" verbs — reads should fail fast; a read verb that can't
 *  answer in 8s is better retried by the operator than held open for the full 15s budget. */
export const READ_TIMEOUT_MS = 8_000;

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
  id: number | string;
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

/** Parses a response body — JSON (single object OR array, for batched calls) or an SSE stream
 *  (one or more `data:` lines, each a single object or an array) — into a flat list of JSON-RPC
 *  response messages. A single-call response is always length 1. */
async function parseRpcMessages(res: Response): Promise<JsonRpcResponse[]> {
  const contentType = res.headers.get("content-type") ?? "";

  const collectFromPayload = (payload: unknown, into: JsonRpcResponse[]): void => {
    if (Array.isArray(payload)) {
      for (const item of payload) into.push(item as JsonRpcResponse);
    } else if (payload && typeof payload === "object") {
      into.push(payload as JsonRpcResponse);
    }
  };

  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const messages: JsonRpcResponse[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payloadText = trimmed.slice("data:".length).trim();
      if (!payloadText) continue;
      try {
        collectFromPayload(JSON.parse(payloadText), messages);
      } catch {
        // ignore non-JSON SSE lines (comments/keepalives)
      }
    }
    if (messages.length === 0) {
      throw new McpError("MCP upstream returned an SSE stream with no parsable JSON-RPC data line.");
    }
    return messages;
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpError(`MCP upstream returned a non-JSON, non-SSE response (status ${res.status}).`);
  }
  const messages: JsonRpcResponse[] = [];
  collectFromPayload(parsed, messages);
  if (messages.length === 0) {
    throw new McpError(`MCP upstream returned a JSON response with no JSON-RPC message.`);
  }
  return messages;
}

/** Single-message convenience wrapper over parseRpcMessages, for the non-batched call sites. */
async function parseRpcResponse(res: Response): Promise<JsonRpcResponse> {
  const messages = await parseRpcMessages(res);
  return messages[0]!;
}

interface ToolCallPayload {
  ok: true;
  data: unknown;
}
interface ToolCallError {
  ok: false;
  error: unknown;
}

function stringifyEnvelopeError(error: unknown): string {
  return typeof error === "string"
    ? error
    : error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message)
      : JSON.stringify(error);
}

/** Unwraps the workspace's own {ok,data|error} envelope out of an MCP tool result, without
 *  throwing — batch callers need a per-item result even when one item's content is malformed. */
function unwrapToolResultSafe(result: unknown, verb: string): { ok: true; data: unknown } | { ok: false; error: string } {
  if (!result || typeof result !== "object") {
    return { ok: false, error: `MCP tool "${verb}" returned an unexpected result shape.` };
  }
  const r = result as { content?: unknown; isError?: boolean };
  if (!Array.isArray(r.content) || r.content.length === 0) {
    return { ok: false, error: `MCP tool "${verb}" returned no content blocks.` };
  }
  const first = r.content[0] as { type?: string; text?: string };
  if (first.type !== "text" || typeof first.text !== "string") {
    return { ok: false, error: `MCP tool "${verb}" returned a non-text first content block.` };
  }

  let envelope: ToolCallPayload | ToolCallError;
  try {
    envelope = JSON.parse(first.text) as ToolCallPayload | ToolCallError;
  } catch {
    return { ok: false, error: `MCP tool "${verb}" returned a content block that was not valid JSON.` };
  }

  if (envelope.ok === true) return { ok: true, data: envelope.data };
  // Surface the backend's own error text verbatim, never a generic message.
  return { ok: false, error: stringifyEnvelopeError(envelope.error) };
}

/** Unwraps the workspace's own {ok,data|error} envelope, throwing McpError on failure. Used by the
 *  single-call path, which has always thrown here; callToolsBatch uses the safe variant above. */
function unwrapToolResult(result: unknown, verb: string): unknown {
  const outcome = unwrapToolResultSafe(result, verb);
  if (outcome.ok) return outcome.data;
  throw new McpError(outcome.error);
}

function isSessionExpiredError(err: JsonRpcErrorShape | undefined, httpStatus: number): boolean {
  if (httpStatus === 404 || httpStatus === 400) return true;
  if (!err) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("session") && (msg.includes("expired") || msg.includes("unknown") || msg.includes("not found") || msg.includes("invalid"));
}

/** Wraps a fetch call so an AbortSignal.timeout rejection surfaces as a clear McpError instead of
 *  a bare DOMException/AbortError, and any other network failure gets the same treatment. */
async function fetchOrTimeoutError(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const isAbort =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (isAbort) {
      throw new McpError(`${label} timed out after ${timeoutMs}ms.`);
    }
    throw new McpError(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  private async ensureSession(timeoutMs: number): Promise<string> {
    if (this.sessionId) return this.sessionId;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initialize(timeoutMs).finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async initialize(timeoutMs: number): Promise<string> {
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

    const res = await fetchOrTimeoutError(
      this.fetchImpl,
      this.url,
      { method: "POST", headers: this.headers(), body: JSON.stringify(req) },
      timeoutMs,
      "MCP initialize"
    );

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
      await fetchOrTimeoutError(
        this.fetchImpl,
        this.url,
        { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) },
        timeoutMs,
        "MCP notifications/initialized"
      );
    } catch {
      // ignore
    }

    return sessionId;
  }

  /** Calls an MCP tool by verb name, returning the unwrapped `data` payload. */
  async callTool(verb: string, args: Record<string, unknown> = {}, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.mock) {
      await this.ensureSession(timeoutMs);
      return mockToolResult(verb, args);
    }

    await this.ensureSession(timeoutMs);
    return this.callToolOnce(verb, args, /* allowRetry */ true, timeoutMs);
  }

  private async callToolOnce(verb: string, args: Record<string, unknown>, allowRetry: boolean, timeoutMs: number): Promise<unknown> {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: nextRequestId++,
      method: "tools/call",
      params: { name: verb, arguments: args },
    };

    const res = await fetchOrTimeoutError(
      this.fetchImpl,
      this.url,
      { method: "POST", headers: this.headers(), body: JSON.stringify(req) },
      timeoutMs,
      `MCP tool "${verb}"`
    );

    const rpc = await parseRpcResponse(res);

    if (rpc.error && isSessionExpiredError(rpc.error, res.status) && allowRetry) {
      this.sessionId = null;
      await this.ensureSession(timeoutMs);
      return this.callToolOnce(verb, args, false, timeoutMs);
    }

    if (!res.ok && isSessionExpiredError(rpc.error, res.status) && allowRetry) {
      this.sessionId = null;
      await this.ensureSession(timeoutMs);
      return this.callToolOnce(verb, args, false, timeoutMs);
    }

    if (rpc.error) {
      throw new McpError(rpc.error.message, String(rpc.error.code));
    }
    if (!res.ok) {
      throw new McpError(`MCP tool "${verb}" call failed with HTTP ${res.status}.`);
    }

    return unwrapToolResult(rpc.result, verb);
  }

  /**
   * Calls multiple MCP tools as ONE upstream JSON-RPC batch (array) request. Returns one
   * {ok,data|error} outcome per input call, in the same order — a single failing call never
   * fails the whole batch (Track A, A1.4 / A2). Retries the whole batch once, exactly like the
   * single-call path, if the upstream reports a session-expired-shaped error.
   */
  async callToolsBatch(
    calls: Array<{ verb: string; args: Record<string, unknown> }>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<Array<{ ok: true; data: unknown } | { ok: false; error: string }>> {
    if (calls.length === 0) return [];

    if (this.mock) {
      await this.ensureSession(timeoutMs);
      return calls.map((c) => ({ ok: true, data: mockToolResult(c.verb, c.args) }));
    }

    await this.ensureSession(timeoutMs);
    return this.callToolsBatchOnce(calls, /* allowRetry */ true, timeoutMs);
  }

  private async callToolsBatchOnce(
    calls: Array<{ verb: string; args: Record<string, unknown> }>,
    allowRetry: boolean,
    timeoutMs: number
  ): Promise<Array<{ ok: true; data: unknown } | { ok: false; error: string }>> {
    const requests: JsonRpcRequest[] = calls.map((c) => ({
      jsonrpc: "2.0",
      id: nextRequestId++,
      method: "tools/call",
      params: { name: c.verb, arguments: c.args },
    }));

    const res = await fetchOrTimeoutError(
      this.fetchImpl,
      this.url,
      { method: "POST", headers: this.headers(), body: JSON.stringify(requests) },
      timeoutMs,
      "MCP batch call"
    );

    const messages = await parseRpcMessages(res);
    const byId = new Map<string | number, JsonRpcResponse>();
    for (const msg of messages) {
      if (msg.id !== undefined && msg.id !== null) byId.set(msg.id, msg);
    }

    // If ANY item in the batch looks like a session-expired error and we can still retry, reset
    // the session and retry the whole batch once — mirrors the single-call retry semantics.
    if (allowRetry) {
      const anyExpired = requests.some((req) => {
        const msg = byId.get(req.id);
        return Boolean(msg?.error) && isSessionExpiredError(msg?.error, res.status);
      });
      if (anyExpired || (!res.ok && requests.some((req) => !byId.has(req.id)))) {
        this.sessionId = null;
        await this.ensureSession(timeoutMs);
        return this.callToolsBatchOnce(calls, false, timeoutMs);
      }
    }

    return requests.map((req, i) => {
      const msg = byId.get(req.id);
      const verb = calls[i]!.verb;
      if (!msg) {
        return { ok: false as const, error: `MCP batch response was missing an entry for "${verb}".` };
      }
      if (msg.error) {
        return { ok: false as const, error: msg.error.message };
      }
      return unwrapToolResultSafe(msg.result, verb);
    });
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
      await fetchOrTimeoutError(
        this.fetchImpl,
        this.url,
        { method: "DELETE", headers: this.headers({ "Mcp-Session-Id": sessionId }) },
        DEFAULT_TIMEOUT_MS,
        "MCP shutdown"
      );
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
      await this.ensureSession(READ_TIMEOUT_MS);
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
