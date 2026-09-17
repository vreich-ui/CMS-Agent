// Transport-neutral core of the MCP Streamable-HTTP endpoint. Extracted from
// netlify/functions/mcp.mts (which is now a thin adapter, mirroring the OAuth oauthEndpoints.ts
// pattern) so the SAME auth + session + dispatch logic serves both Netlify Functions and the
// Cloud Run MCP Service (docs/platform/DIRECTION.md Phase 4). Anything Netlify-request-lifecycle
// specific (connectLambdaBlobs, per-request manager refresh) stays in the adapters, never here.

import { handleMcpJsonRpc } from "../workspace/server.js";
import type { WorkspaceToolContext } from "../workspace/tools.js";
import { workspaceActorKinds, workspaceChangeSources, type WorkspaceActor, type WorkspaceChangeSource } from "../../workspace/changeTypes.js";
import { hasBearerToken, unauthorizedResponse, type HeaderMap } from "../../runtime/auth.js";
import { McpSessionManager, negotiateProtocolVersion, type McpClientInfo } from "../transport/session.js";
import { OAuthService } from "../auth/oauthService.js";
import { buildWwwAuthenticate, parseBearerToken, resourceMetadataUrl } from "../auth/wwwAuthenticate.js";
import { resolveBaseUrl } from "../auth/metadata.js";
import { findAnyScopedBearerTokenPolicy, type ScopedBearerTokenPolicy } from "../auth/scopedBearerTokens.js";
import { getExecutionRepository } from "../../runtime/repositories.js";

const SESSION_HEADER = "mcp-session-id";
const PROTOCOL_HEADER = "mcp-protocol-version";

export type McpHttpRequest = { httpMethod: string; body: string | null; headers: HeaderMap; signal?: AbortSignal };

// A client that has hung up gets no further work. This does not abort a blob read already in
// flight — the store client's SDK calls take no signal — so it is a floor, not a ceiling: what it
// reliably stops is the REST of a batch, and any dispatch not yet started.
const clientGone = { statusCode: 499, headers: {}, body: "" } satisfies McpHttpResponse;
export type McpHttpResponse = { statusCode: number; headers: Record<string, string>; body: string };

// `timing`, when passed, times the JSON.stringify itself as the `sec.serialize` section — passed
// only at the call sites that return a real tool/session result, where serialization cost is worth
// separating from the rest; the small constant-shaped error bodies elsewhere don't need it.
const json = (statusCode: number, body: unknown, headers: Record<string, string> = {}, timing?: RequestTiming): McpHttpResponse => ({
  statusCode,
  headers: { "content-type": "application/json", ...headers },
  body: timing ? timing.mark("serialize", () => JSON.stringify(body)) : JSON.stringify(body)
});

const empty = (statusCode: number, headers: Record<string, string> = {}): McpHttpResponse => ({ statusCode, headers, body: "" });

const isMcpNotification = (message: unknown) => {
  const request = message as { id?: unknown; method?: unknown };
  return request.id === undefined && typeof request.method === "string" && request.method.startsWith("notifications/");
};

const isInitialize = (message: unknown) => (message as { method?: unknown }).method === "initialize";

const readHeader = (headers: HeaderMap, name: string): string | undefined => {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName && typeof value === "string") return value;
  }
  return undefined;
};

// Attribution context for change history. The secure proxy stamps a verified human actor via these
// headers after identity checks; direct bearer-token callers default to an agent actor. This is
// attribution, not authorization — a bearer holder could self-describe.
const parseActorHeader = (value: string | undefined): WorkspaceActor | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { kind?: unknown; id?: unknown; label?: unknown };
    if (typeof parsed?.kind !== "string" || !(workspaceActorKinds as readonly string[]).includes(parsed.kind)) return undefined;
    return {
      kind: parsed.kind as WorkspaceActor["kind"],
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      label: typeof parsed.label === "string" ? parsed.label : undefined
    };
  } catch {
    return undefined;
  }
};

const parseSourceHeader = (value: string | undefined): WorkspaceChangeSource | undefined =>
  value && (workspaceChangeSources as readonly string[]).includes(value) ? value as WorkspaceChangeSource : undefined;

const buildToolContext = (headers: HeaderMap, tokenActor?: WorkspaceActor, scopedPolicy?: ScopedBearerTokenPolicy): WorkspaceToolContext => ({
  actor: parseActorHeader(headers["x-workspace-actor"]) ?? tokenActor ?? { kind: "agent" },
  source: parseSourceHeader(headers["x-workspace-source"]) ?? "mcp",
  requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  ...(scopedPolicy ? { allowedToolNames: scopedPolicy.toolAllowlist } : {})
});

type AuthOutcome = { ok: true; actor?: WorkspaceActor; scopedPolicy?: ScopedBearerTokenPolicy } | { ok: false; presentedToken: boolean };

// Accept either the static workspace bearer (MCP_API_TOKEN) or an OAuth-minted access token. On
// failure the caller returns 401 with a WWW-Authenticate pointer so a connector can discover the
// authorization server and complete the flow. Identical on Netlify and Cloud Run.
const authenticate = async (headers: HeaderMap): Promise<AuthOutcome> => {
  if (hasBearerToken(headers, process.env.MCP_API_TOKEN)) return { ok: true };
  const token = parseBearerToken(readHeader(headers, "authorization"));
  if (!token) return { ok: false, presentedToken: false };
  try {
    const scopedPolicy = await findAnyScopedBearerTokenPolicy(token);
    if (scopedPolicy) return { ok: true, scopedPolicy };
  } catch {
    // A malformed scoped-token secret must fail closed exactly like any other invalid bearer and
    // must not reveal configuration detail through an HTTP response or log.
    return { ok: false, presentedToken: true };
  }
  const record = await new OAuthService().verifyAccessToken(token);
  if (record) return { ok: true, actor: record.actor };
  return { ok: false, presentedToken: true };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// K-M11 (2026-09-13, owner-authorized): `tenantId`/`tenant_id` are read here alongside
// `projectId`/`project_id`, not as a second scoping dimension but because they ARE the first one —
// `operationTools.ts`'s `operation.preflight`/`operation.execute`/`operation.list_capability_gaps`
// scope entirely by `tenantId`, and `capabilityFactsLoader.ts`'s `projectRepository.get(tenantId)` /
// `tenantId: config.projectId` is the proof they share one identifier space under two field
// spellings. Before this, a call naming only `tenantId` returned `undefined` here exactly like a
// call naming nothing at all — `operation_preflight` (already granted, #318) let a bearer scoped to
// one tenant read ANY tenant's capability facts, and the same shape would have made
// `operation_execute` a cross-tenant site_inventory read the day it was added to
// SITE_CLIENT_MANAGER_TOOLS. Audited (2026-09-13): those three are the ONLY wire tools whose input
// schema carries `tenantId` anywhere in this codebase (`grep -rl tenantId src/agent/mcp/`), and none
// of the three has a legitimate reason for a scoped bearer to name a tenant other than its own — each
// is "read/act on THIS ONE tenant", never a cross-tenant listing — so requiring all four spellings to
// agree is safe for every current caller, not just these three.
//
// All four keys must agree where more than one is present — the same "no mismatch" rule the
// camel/snake pair already enforced, now over four spellings of one value instead of two.
const requestedProject = (argumentsValue: unknown): string | undefined | null => {
  if (!isPlainObject(argumentsValue)) return undefined;
  let result: string | undefined;
  for (const value of [argumentsValue.projectId, argumentsValue.project_id, argumentsValue.tenantId, argumentsValue.tenant_id]) {
    if (value === undefined) continue;
    if (typeof value !== "string" || !value) return null;
    if (result !== undefined && result !== value) return null;
    result = value;
  }
  return result;
};

// S-26 / K-M9 — run-addressed tools (workflow_get_run, workflow_publish_run, workflow_run_all,
// node_get_latest_output, workflow_cancel_run, workflow_get_run_cost, workflow_publish_readiness,
// workflow_set_operator_publish_decision) name a run and nothing else, so the projectId pin above
// never saw them: a tenant's scoped bearer could read, approve or publish ANY tenant's run by its
// runId. The check is argument-driven rather than a list of tool names, so a run-addressed tool
// added later is covered the day it is added rather than the day someone remembers the list.
const requestedRun = (argumentsValue: unknown): string | undefined | null => {
  if (!isPlainObject(argumentsValue)) return undefined;
  const camel = argumentsValue.runId;
  const snake = argumentsValue.run_id;
  if (camel !== undefined && (typeof camel !== "string" || !camel)) return null;
  if (snake !== undefined && (typeof snake !== "string" || !snake)) return null;
  if (camel !== undefined && snake !== undefined && camel !== snake) return null;
  return (camel ?? snake) as string | undefined;
};

// S-07 — tools whose UNFILTERED answer is the whole workspace, for every tenant at once.
//
// The projectId pin below only fires when a call actually NAMES a project; a call that names none was
// let through on the theory that the tool allowlist alone bounds it. That theory holds for every tool
// on a site bearer up to now: each is addressed by a run or a project and therefore cannot cross a
// tenant boundary. It does NOT hold for `feedback_list` and `learning_list_observations`, which
// return every record in the workspace when no filter is supplied — so admitting a scoped bearer that
// simply omits `projectId` would hand one tenant every other tenant's editorial telemetry.
//
// A list of wire names rather than an argument-driven rule (the shape `requestedRun` uses), because
// the property being encoded — "unfiltered, this returns everyone's rows" — is a fact about the
// tool's semantics that no argument reveals. A tool added later is NOT covered until someone adds it
// here, so: any tool that lists records across projects must be added to this set in the same commit
// that adds it to SITE_CLIENT_MANAGER_TOOLS.
// #376: `site_content_draft_page` (siteContentTools.ts) joins this list too, but for a different
// reason than feedback_list/learning_list_observations above — its own zod schema already marks
// `project_id` required, min length 1, so an omitted or empty project never reaches the tool at all.
// It belongs here anyway as defence in depth: this door has to refuse BEFORE the tool's own parse
// runs, the same "refuse before the membership check" ordering `isScopedMessageAllowed` already
// applies below (line ~194) — a request this door let through on the theory that the tool's own
// validation would catch it is one 400/500 error message away from becoming the door's problem
// instead of a refusal at the door. An entry here costs nothing when the schema already agrees;
// it is only ever a backstop.
const PROJECT_REQUIRED_SCOPED_TOOLS: readonly string[] = ["feedback_list", "learning_list_observations", "site_content_draft_page"];

// An unknown runId is refused exactly like a foreign one, and a store failure fails closed.
// Distinguishing "no such run" from "not your run" would make this check an existence oracle over
// other tenants' run ids.
const isRunInScope = async (runId: string, policy: ScopedBearerTokenPolicy): Promise<boolean> => {
  try {
    const run = await getExecutionRepository().getRun(runId);
    return !!run && policy.projects.includes(run.projectId);
  } catch {
    return false;
  }
};

// Scoped callers receive the normal initialize response, but tools/list is reduced to its exact
// wire-name allowlist. Each tools/call is also checked here before dispatch; the server-side filter
// is defence in depth for the SDK path. Calls that name projectId/project_id (or, K-M11, the same
// identifier under tenantId/tenant_id) must be in scope; calls without any of the four are bounded by
// the explicit tool allowlist ALONE, which is why a tool that lists across projects when unfiltered
// must be named in PROJECT_REQUIRED_SCOPED_TOOLS and refused without one.
const isScopedMessageAllowed = async (message: unknown, policy: ScopedBearerTokenPolicy): Promise<boolean> => {
  if (!isPlainObject(message) || typeof message.method !== "string") return false;
  // Scoped site credentials are for the MCP tool channel only. Keep the session handshake and
  // discovery available, but deny prompts/resources (which can expose workspace-wide metadata)
  // unless a later explicit scoped-resource contract is added.
  if (["initialize", "notifications/initialized", "ping", "tools/list"].includes(message.method)) return true;
  if (message.method !== "tools/call") return false;
  const params = message.params;
  if (!isPlainObject(params) || typeof params.name !== "string" || !policy.toolAllowlist.includes(params.name)) return false;
  const project = requestedProject(params.arguments);
  if (project === null) return false;
  // Refuse BEFORE the membership check, so an omitted project is a refusal rather than a pass. The
  // membership check below then does the rest: naming a foreign project is refused exactly as it
  // already was, and naming the bearer's own project is the only way through.
  if (project === undefined && PROJECT_REQUIRED_SCOPED_TOOLS.includes(params.name)) return false;
  if (project !== undefined && !policy.projects.includes(project)) return false;
  const runId = requestedRun(params.arguments);
  if (runId === null) return false;
  if (runId !== undefined && !(await isRunInScope(runId, policy))) return false;
  return true;
};

const isScopedRequestAllowed = async (body: unknown, policy: ScopedBearerTokenPolicy): Promise<boolean> => {
  if (!Array.isArray(body)) return isScopedMessageAllowed(body, policy);
  const verdicts = await Promise.all(body.map((message) => isScopedMessageAllowed(message, policy)));
  return verdicts.every(Boolean);
};

const unauthorized = (headers: HeaderMap, presentedToken: boolean) => {
  const baseUrl = resolveBaseUrl(headers);
  const challenge = buildWwwAuthenticate({
    resourceMetadataUrl: resourceMetadataUrl(baseUrl),
    ...(presentedToken ? { error: "invalid_token" as const, errorDescription: "The bearer token is invalid or expired." } : {})
  });
  return json(401, unauthorizedResponse, { "www-authenticate": challenge });
};

const sessionRequired = (): boolean => (process.env.MCP_REQUIRE_SESSION ?? "false").toLowerCase() === "true";

// --- Server-Timing diagnostics (DIAGNOSTIC ONLY — no behaviour change, no wire contract change) ---
//
// Mirrors the MCP_TOOL_LOG / toolLoggingEnabled() convention in workspace/server.ts: on by default,
// off under VITEST unless a test explicitly turns it back on, and always overridable in production
// by an env var. A test that wants to see the header sets MCP_SERVER_TIMING=on, exactly as a test of
// tool-call logging would set MCP_TOOL_LOG=on.
//
// The header carries ONLY section names and millisecond durations — never a header value, argument,
// or token — so it cannot violate the repo's "secrets are names/refs, never values" rule by
// construction: nothing but `RequestTiming` ever writes to it, and it only ever appends
// `name;dur=number` tokens.
const serverTimingEnabled = (): boolean =>
  (process.env.MCP_SERVER_TIMING ?? (process.env.VITEST ? "off" : "on")) !== "off";

// Cloud Run gives each instance its own cold start; many instances each pay their own cold cost, so
// "cold vs warm" is a per-process fact, not a per-request one. Module-scope boolean, flipped after
// the first request THIS PROCESS handles — the same shape as any other once-per-instance flag.
let handledFirstRequestInThisProcess = false;

class RequestTiming {
  private readonly enabled: boolean;
  private readonly cold: boolean;
  private readonly startedAt = performance.now();
  private authEndedAt: number | undefined;
  private readonly sections: string[] = [];

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.cold = enabled && !handledFirstRequestInThisProcess;
    if (enabled) handledFirstRequestInThisProcess = true;
  }

  // Times a synchronous section and records it as `sec.<name>;dur=<ms>`. No-ops (just runs `fn`)
  // when disabled, so the cost of a disabled instance is one boolean check.
  mark<T>(name: string, fn: () => T): T {
    if (!this.enabled) return fn();
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.sections.push(`sec.${name};dur=${(performance.now() - start).toFixed(1)}`);
    }
  }

  // Same, for an async section (auth, session lookup, tool dispatch — all real I/O/CPU here).
  async markAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.sections.push(`sec.${name};dur=${(performance.now() - start).toFixed(1)}`);
    }
  }

  // Marks the instant authentication/authorization finished — the boundary `work` measures from.
  authResolved(): void {
    if (this.enabled) this.authEndedAt = performance.now();
  }

  // `work;dur=<ms>` — "time doing the actual job", from the moment auth finished (or from request
  // start, for a response that never got that far, e.g. a 405 before auth runs) to now. Undefined
  // when timing is disabled, so callers can skip attaching a header entirely.
  headerValue(): string | undefined {
    if (!this.enabled) return undefined;
    const workDur = performance.now() - (this.authEndedAt ?? this.startedAt);
    const parts = [...this.sections, `work;dur=${Math.max(0, workDur).toFixed(1)}`];
    if (this.cold) parts.push("cold;dur=1");
    return parts.join(", ");
  }
}

const attachServerTiming = (response: McpHttpResponse, timing: RequestTiming): McpHttpResponse => {
  const header = timing.headerValue();
  if (!header) return response;
  return { ...response, headers: { ...response.headers, "server-timing": header } };
};

// The complete MCP Streamable-HTTP request lifecycle: method routing, auth, session
// create/touch/terminate, and JSON-RPC dispatch. Callers must have already prepared the storage
// backend for the request (Netlify: connectLambdaBlobs; Cloud Run: bootstrapWorkspaceStore at
// startup registers the GCS transport once).
export async function handleMcpHttp(request: McpHttpRequest): Promise<McpHttpResponse> {
  const timing = new RequestTiming(serverTimingEnabled());
  const response = await handleMcpHttpCore(request, timing);
  // Never touch the client-gone/499 path: there is nobody left to read a header, and mcpServerMain
  // special-cases this exact status to destroy the socket rather than write a response.
  if (response.statusCode === 499) return response;
  return attachServerTiming(response, timing);
}

async function handleMcpHttpCore(request: McpHttpRequest, timing: RequestTiming): Promise<McpHttpResponse> {
  const method = request.httpMethod.toUpperCase();
  if (method === "GET") {
    return json(405, { error: { code: "method_not_allowed", message: "This MCP endpoint does not offer a GET SSE stream. Use POST for requests." } }, { allow: "POST, DELETE" });
  }

  const auth = await timing.markAsync("auth", () => authenticate(request.headers));
  timing.authResolved();
  if (!auth.ok) return unauthorized(request.headers, auth.presentedToken);

  const sessions = new McpSessionManager();
  const sessionId = readHeader(request.headers, SESSION_HEADER);

  if (method === "DELETE") {
    if (!sessionId) return json(400, { error: { code: "missing_session", message: "Mcp-Session-Id header is required to terminate a session." } });
    const existed = await timing.markAsync("session", () => sessions.terminate(sessionId));
    return existed ? empty(204) : json(404, { error: { code: "session_not_found", message: "Unknown or already-terminated session." } });
  }

  if (method !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Use POST." } }, { allow: "POST, DELETE" });

  try {
    const context = buildToolContext(request.headers, auth.actor, auth.scopedPolicy);
    const rawBody = timing.mark("parse", () => (request.body ? JSON.parse(request.body) : {}));

    if (auth.scopedPolicy) {
      const scopedPolicy = auth.scopedPolicy;
      const allowed = await timing.markAsync("authz", () => isScopedRequestAllowed(rawBody, scopedPolicy));
      if (!allowed) return unauthorized(request.headers, true);
    }

    if (!Array.isArray(rawBody) && isInitialize(rawBody)) {
      const params = (rawBody.params ?? {}) as { protocolVersion?: string; clientInfo?: McpClientInfo };
      const protocolVersion = negotiateProtocolVersion(params.protocolVersion);
      const session = await timing.markAsync("session", () => sessions.create({ protocolVersion, clientInfo: params.clientInfo, actor: context.actor ?? { kind: "agent" } }));
      const result = await timing.markAsync("dispatch", () => handleMcpJsonRpc(rawBody, context, { protocolVersion, sessionId: session.id }));
      return json(200, result, { [SESSION_HEADER]: session.id, [PROTOCOL_HEADER]: protocolVersion }, timing);
    }

    let negotiatedProtocol: string | undefined;
    if (sessionId) {
      const session = await timing.markAsync("session", () => sessions.touch(sessionId));
      if (!session) return json(404, { error: { code: "session_not_found", message: "Unknown or expired Mcp-Session-Id. Re-initialize to obtain a new session." } });
      negotiatedProtocol = session.protocolVersion;
    } else if (sessionRequired()) {
      return json(400, { error: { code: "missing_session", message: "Mcp-Session-Id header is required. Call initialize first." } });
    }

    const responseHeaders: Record<string, string> = negotiatedProtocol ? { [PROTOCOL_HEADER]: negotiatedProtocol } : {};

    if (request.signal?.aborted) return clientGone;

    if (Array.isArray(rawBody)) {
      const calls = rawBody.filter((message) => !isMcpNotification(message));
      if (calls.length === 0) return empty(202, responseHeaders);
      // Still dispatched in parallel: batching exists precisely so independent calls overlap, and
      // serializing them to gain a mid-batch abort check would be a real regression to buy a small
      // saving. The abort checks bracket the batch instead.
      const responses = await timing.markAsync("dispatch", () => Promise.all(calls.map((message) => handleMcpJsonRpc(message, context))));
      if (request.signal?.aborted) return clientGone;
      return json(200, responses, responseHeaders, timing);
    }
    if (isMcpNotification(rawBody)) return empty(202, responseHeaders);
    const result = await timing.markAsync("dispatch", () => handleMcpJsonRpc(rawBody, context));
    if (request.signal?.aborted) return clientGone;
    return json(200, result, responseHeaders, timing);
  } catch (error) {
    if (error instanceof SyntaxError) return json(400, { error: { code: "invalid_json", message: "Request body must be valid JSON." } });
    return json(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "Unknown error" } });
  }
}
