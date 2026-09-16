// Thin client for the Conductor Workbench data transport (see spec/HANDOFF.md
// §3, superseded by the WP-03 task brief, and further superseded by the
// workbench-cloudrun repoint below).
//
// Three transports, chosen by env at build/dev time:
//
//   - Fixtures (VITE_MOCK=1, or nothing configured — the default for
//     `npm run dev`): every verb resolves from `mockStore` instead of the
//     network, after a small artificial delay so loading states are
//     exercised.
//   - The `workbench-broker` network path (VITE_API_BASE set): a small
//     server-side broker that holds the MCP token behind an httpOnly
//     session cookie —
//       POST {BASE}/api/mcp      {verb, args?} -> {ok:true,data} | {ok:false,error:{code,message,verb}}
//       GET  {BASE}/api/session  -> SessionInfo
//       POST {BASE}/api/login    {password}    -> {ok:true,...SessionInfo} | {ok:false,error}
//       POST {BASE}/api/logout   -> {ok:true}
//   - The Cloud Run MCP transport (VITE_MCP_TRANSPORT=cloudrun, set by the
//     Netlify build — see netlify.toml): talks directly to the live Cloud
//     Run control plane. This REPLACES a prior "Netlify transport" that
//     POSTed to this site's own `/api/workspace-mcp` Netlify Function —
//     that entire Netlify Functions MCP plane is dead (proven live from the
//     authenticated browser: `POST /api/workspace-mcp -> 502
//     ERR_REQUIRE_ESM: require() of ES Module /var/task/workspace-mcp.mts
//     from /var/task/workspace-mcp.js`; `/api/mcp` 502s identically). Per
//     ui/src/connection.ts's header comment, "GCloud is the only control
//     plane the UI ever talks to (Netlify's MCP proxy paths and the
//     Identity secure-proxy auth mode were retired once Cloud Run became
//     the sole target)" — this transport mirrors that exact model instead
//     of inventing a new one: an absolute Cloud Run endpoint + a manually
//     entered MCP bearer token, sent as `Authorization: Bearer <token>` on
//     every request. See the "Cloud Run MCP transport" section below.


// --- env / mode flags --------------------------------------------------------

const rawEnv = import.meta.env;
const API_BASE: string = (rawEnv.VITE_API_BASE as string | undefined) ?? '';
const explicitMock = rawEnv.VITE_MOCK as string | undefined;
const explicitReadOnly = rawEnv.VITE_READ_ONLY as string | undefined;

/**
 * Cloud Run MCP transport — see this file's header comment. Set by the
 * Netlify build (netlify.toml) when this app is served at /workbench on the
 * existing cms-agent.netlify.app site; it talks straight to the live Cloud
 * Run control plane with a manually entered bearer token instead of any
 * broker or Netlify Function.
 */
export const IS_CLOUD_RUN_TRANSPORT: boolean = (rawEnv.VITE_MCP_TRANSPORT as string | undefined) === 'cloudrun';

// Same env var ui/ reads (import.meta.env.VITE_CLOUD_RUN_MCP_URL) so one
// Netlify build-environment setting configures both apps' Cloud Run
// endpoint. Falls back to the known-good production Cloud Run MCP URL when
// unset, but stays overridable at runtime (Settings-style env var, not a
// hardcoded constant used unconditionally) for local dev or a staging Cloud
// Run service.
const CLOUD_RUN_MCP_URL: string =
  (rawEnv.VITE_CLOUD_RUN_MCP_URL as string | undefined)?.trim() ||
  'https://cms-agent-mcp-937996366809.us-central1.run.app/mcp';

/**
 * Fixture mode. Explicit `VITE_MOCK=1` always wins; explicit `VITE_MOCK=0`
 * always forces network mode. Left unset, mock mode is the default whenever
 * no broker base URL is configured and the Cloud Run transport isn't
 * selected, so `npm run dev` works with zero config.
 */
export const IS_MOCK: boolean = explicitMock === '1' || (explicitMock === undefined && !API_BASE && !IS_CLOUD_RUN_TRANSPORT);

/**
 * W3 — which workspace this browser is talking to, as a cache key.
 *
 * The persisted query cache (App.tsx) is keyed on it so a browser pointed at a different control
 * plane — a staging Cloud Run service, a local broker, fixtures — never paints from the cache of
 * another one. Contains no credential: it is a transport name and a URL, both of which the client
 * already ships in its bundle.
 */
export const WORKSPACE_CACHE_KEY: string =
  IS_MOCK ? 'fixtures' : IS_CLOUD_RUN_TRANSPORT ? `cloudrun:${CLOUD_RUN_MCP_URL}` : `broker:${API_BASE || location.origin}`;

/**
 * Read-only defaults ON, so a misconfigured deploy is safe rather than
 * permissive. Two ways it turns off:
 *   - explicit `VITE_READ_ONLY=0`;
 *   - fixture mode, where every mutation lands in the in-memory `mockStore`
 *     and there is nothing real to protect. Keeping it on there would make the
 *     app undemonstrable without a broker.
 * Against the workbench-broker network path this flag is advisory UI state
 * only — that broker enforces its own `READ_ONLY` server-side and returns
 * 403 regardless. The Cloud Run transport has no such flag at all — an
 * authorized operator's mutation calls genuinely reach the live workspace,
 * exactly like ui/'s own Cloud Run connection — so this client-side default
 * is the only thing standing between that transport and production
 * mutations on first deploy; it is enforced before any call leaves the
 * browser, in confirmAction.ts.
 */
export const IS_READ_ONLY: boolean = explicitReadOnly === '0' ? false : !IS_MOCK;

const MOCK_DELAY_MS = 120;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- errors -------------------------------------------------------------------

/**
 * Base error for every verb failure. `message` is always the backend's own
 * message where one exists (HANDOFF §7.10 — latency/error honesty); only
 * client-side failures with no backend body get a locally authored message.
 */
export class McpError extends Error {
  readonly code: string;
  readonly verb: string;

  constructor(code: string, message: string, verb: string) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.verb = verb;
  }
}

/** A 401 from the broker, or a rejected bearer token on the Cloud Run transport — the credential is missing, wrong, or expired. UI should show a re-login/re-enter-token prompt. */
export class AuthError extends McpError {
  constructor(verb: string, message?: string) {
    super('unauthenticated', message ?? 'Your session has expired — log in again.', verb);
    this.name = 'AuthError';
  }
}

/** A 403 from the broker's read-only guard, or confirmAction refusing a mutation. */
export class ReadOnlyError extends McpError {
  constructor(verb: string, message?: string) {
    super(
      'read_only',
      // P2-06 — operator copy, not developer copy. The old text named an
      // environment variable, which tells the person holding this console
      // nothing they can act on and reads like a bug. This says what is
      // true and who can change it.
      message ?? `This workspace is open in read-only mode, so "${verb}" was not sent. Nothing was changed.`,
      verb,
    );
    this.name = 'ReadOnlyError';
  }
}

/**
 * P2-04 — a 403 from the Cloud Run MCP endpoint. Distinct from AuthError on
 * purpose: the old transport treated 401 and 403 identically, so a single
 * "you may not call this particular verb" answer ran through
 * `reportAuthExpired`, threw the operator back to the token gate and
 * emptied the whole query cache. A 403 means the credential was understood
 * and refused for this call — it says nothing about the session, so it
 * surfaces on the panel that asked and nowhere else.
 */
export class PermissionError extends McpError {
  constructor(verb: string, message?: string) {
    // U7 polish — operator copy: says what was refused and what to do,
    // not just the raw verb name (matches ReadOnlyError's own P2-06 fix
    // just above). The real 403 path below always supplies its own
    // message (the backend's own refusal text); this default only covers
    // a PermissionError constructed without one.
    super(
      'forbidden',
      message ?? `This workspace refused "${verb}" for your current credentials — nothing was changed. Ask whoever manages access here if you need it granted.`,
      verb,
    );
    this.name = 'PermissionError';
  }
}

/** Fetch itself failed, or the response body could not be parsed as JSON. */
export class NetworkError extends McpError {
  constructor(verb: string, message: string) {
    super('network_error', message, verb);
    this.name = 'NetworkError';
  }
}

// --- mutating-verb gate -------------------------------------------------------
// The full HANDOFF §6 mutating list, minus `node_validate_input` and
// `workspace_validate_node` — both are explicitly "(no confirm)": read-shaped
// calls that never pass through confirmAction.
export const MUTATING_VERBS: ReadonlySet<string> = new Set([
  'workflow_start_dry_run',
  'workflow_run_all',
  'workflow_run_next_node',
  'workflow_run_until',
  'workflow_run_node',
  'workflow_pause_run',
  'workflow_resume_run',
  'workflow_cancel_run',
  'workflow_reset_run',
  'workflow_retry_node',
  'workflow_set_operator_publish_decision',
  'workflow_publish_run',
  'workspace_update_node_prompt',
  'workspace_update_node_tools',
  'workspace_update_node_skills',
  'workspace_update_node_model_config',
  'workspace_update_node_input_schema',
  'workspace_update_node_output_schema',
  'workspace_update_node_metadata',
  'workspace_update_node_default_output',
  'workspace_adopt_output_as_default',
  // W6 — node_execute creates a real run record server-side (synthetic, workflowId
  // "independent_node") and, in openai mode, spends money on a model call. It also writes the
  // node's stage output on success. It is a mutation by every measure this set exists to catch.
  'node_execute',
  'changes_restore',
  // W5 — editing the Client Manager's prompt bumps its revision, which invalidates every
  // outstanding agent_ref. That is a change to the agent every editor's admin chat talks to.
  'agent_update',
  'stage_save_output',
  'skill_update',
  'skill_assign',
  'skill_unassign',
  'skill_restore_version',
  'learning_record_observation',
  'learning_archive_observation',
  'playbook_curate',
  'playbook_apply_delta',
  'playbook_migrate_observations',
  'feedback_record',
  'evaluation_create_rubric',
  'evaluation_update_rubric',
  'evaluation_run',
  'evaluation_run_regression',
  'evaluation_restore_rubric_version',
  'optimizer_analyze',
  'optimizer_propose',
  'optimizer_run_trial',
  'optimizer_promote',
  'optimizer_auto_promote',
  'dataset_build',
  'dataset_export_sft',
  'dataset_export_preferences',
]);

// confirmAction.ts marks the call stack while it invokes a mutating verb's
// underlying callVerb call, so callVerb can assert (dev-only) that nothing
// reached a mutating verb by any other path.
let confirmedCallDepth = 0;

/** Used only by confirmAction.ts — do not call directly. */
export function __beginConfirmedCall(): void {
  confirmedCallDepth++;
}

/** Used only by confirmAction.ts — do not call directly. */
export function __endConfirmedCall(): void {
  confirmedCallDepth = Math.max(0, confirmedCallDepth - 1);
}

function isDev(): boolean {
  return Boolean(rawEnv.DEV);
}

// --- verb call ------------------------------------------------------------------

interface McpOkResponse<T> {
  ok: true;
  data: T;
}
interface McpErrResponse {
  ok: false;
  error: { code: string; message?: string; issues?: ZodIssueLike[]; verb?: string };
}
type McpResponse<T> = McpOkResponse<T> | McpErrResponse;

/**
 * W3 — the load-budget seam. DEV-only, exactly like App.tsx's `__queryClient` handle and for the
 * same reason: `workbench/tests/firstPaintBudget.spec.ts` asserts a CALL COUNT and a payload size
 * against `workbench/contracts/first-paint.json`, and in fixture mode there is no network panel to
 * read those from — the mock plane resolves in-process. Never in a production bundle.
 */
// W6 adds `args`, held by reference and never cloned: an acceptance test needs to assert WHAT a
// control sent, not merely that it sent something — "the replay went against this run's upstream
// outputs" and "the default adopted was scoped to the bound run" are the properties worth holding,
// and both live in the arguments. Nothing in product code reads this field.
type VerbCallRecord = { verb: string; at: number; bytes: number; args?: object };
const recordVerbCall = (verb: string, startedAt: number, result: unknown, args?: object): void => {
  if (!isDev() || typeof window === 'undefined') return;
  const w = window as unknown as { __verbCalls?: VerbCallRecord[] };
  (w.__verbCalls ??= []).push({ verb, at: startedAt, bytes: JSON.stringify(result ?? null)?.length ?? 0, ...(args ? { args } : {}) });
};

export async function callVerb<T>(verb: string, args?: object): Promise<T> {
  if (isDev() && typeof window !== 'undefined') {
    const startedAt = Date.now();
    const result = await callVerbInner<T>(verb, args);
    recordVerbCall(verb, startedAt, result, args);
    return result;
  }
  return callVerbInner<T>(verb, args);
}

async function callVerbInner<T>(verb: string, args?: object): Promise<T> {
  if (MUTATING_VERBS.has(verb) && confirmedCallDepth === 0 && isDev()) {
    // eslint-disable-next-line no-console
    console.error(
      `[api] mutating verb "${verb}" was called outside confirmAction() — every mutating verb must go through the confirmAction gate.`,
    );
  }

  if (IS_MOCK) {
    return callVerbMock<T>(verb, (args ?? {}) as Args);
  }
  if (IS_CLOUD_RUN_TRANSPORT) {
    return callVerbCloudRun<T>(verb, args);
  }
  return callVerbNetwork<T>(verb, args);
}

async function callVerbNetwork<T>(verb: string, args?: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/mcp`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verb, args: args ?? {} }),
    });
  } catch (err) {
    throw new NetworkError(verb, err instanceof Error ? err.message : 'The network request failed.');
  }

  let parsed: McpResponse<T> | null = null;
  try {
    parsed = (await res.json()) as McpResponse<T>;
  } catch {
    parsed = null;
  }

  if (res.status === 401) {
    throw new AuthError(verb, parsed && !parsed.ok ? describeErrorEnvelope(parsed.error) : undefined);
  }
  if (res.status === 403) {
    throw new ReadOnlyError(verb, parsed && !parsed.ok ? describeErrorEnvelope(parsed.error) : undefined);
  }
  if (!parsed) {
    throw new NetworkError(verb, `The broker returned an unreadable response (status ${res.status}).`);
  }
  if (!parsed.ok) {
    throw new McpError(
      parsed.error.code,
      describeErrorEnvelope(parsed.error) ?? 'MCP tool returned an error.',
      parsed.error.verb || verb,
    );
  }
  return parsed.data;
}

// The server's tool-error envelope (toolKit.ts's ToolErrorEnvelope) is
// `{code, message?, issues?}` — a Zod validation failure carries `code:
// "validation_error"` and `issues` (raw ZodIssue[]) but NO `message` at
// all. Shared by every transport that speaks this envelope (the
// workbench-broker network path and the Cloud Run transport's
// structuredContent.error below) so a validation error always surfaces the
// one thing (issues) that names the real cause, never a silent drop of a
// populated envelope.
interface ZodIssueLike {
  code?: string;
  path?: Array<string | number>;
  message?: string;
  [key: string]: unknown;
}

interface ErrorEnvelope {
  code?: string;
  message?: string;
  issues?: ZodIssueLike[];
}

function formatIssue(issue: ZodIssueLike): string {
  const path =
    Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : '(root)';
  const code = typeof issue.code === 'string' && issue.code ? issue.code : 'issue';
  const detail = typeof issue.message === 'string' && issue.message ? issue.message : JSON.stringify(issue);
  return `${code} at ${path} — ${detail}`;
}

function describeErrorEnvelope(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return undefined;
  const env = error as ErrorEnvelope;
  const parts: string[] = [];
  if (typeof env.code === 'string' && env.code) parts.push(env.code);
  if (typeof env.message === 'string' && env.message) parts.push(env.message);
  if (Array.isArray(env.issues) && env.issues.length > 0) {
    parts.push(env.issues.map(formatIssue).join('; '));
  }
  return parts.length > 0 ? parts.join(': ') : undefined;
}

// --- Cloud Run bearer token storage --------------------------------------------
// Mirrors ui/src/storage.ts (safe localStorage access — private-mode/storage-denied
// browsers throw on any access) and ui/src/App.tsx's persistence rule exactly: in
// deployed mode the token is held in memory only and NEVER read from or written to
// storage, so a credential typed into a shared/public deployment doesn't linger in
// the browser after the tab closes. Only a local dev build (`import.meta.env.DEV`)
// persists it, purely for developer convenience — see ui/App.tsx's `isDeployedMode`
// and its `TOKEN_KEY` effect for the exact same rule applied there.
const TOKEN_KEY = 'cms-agent.mcpToken';
const isDeployedMode = !rawEnv.DEV;

function store(persistent: boolean): Storage | null {
  try {
    return persistent ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

function readStorage(key: string, persistent: boolean): string | null {
  try {
    return store(persistent)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null, persistent: boolean): void {
  try {
    const s = store(persistent);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Token simply doesn't persist when storage is unavailable.
  }
}

/**
 * P2-04 (interim, until the broker holds the token server-side — Track A).
 *
 * Before: in a deployed build the token was memory-only, so every reload
 * and every new tab threw the operator back to the token gate. That is the
 * single most-repeated piece of friction in this app, and it was paid on
 * every refresh.
 *
 * Now: deployed builds persist it in `sessionStorage` — scoped to the one
 * tab, cleared when that tab closes, never shared with another tab or
 * another site. A reload keeps working; walking away still ends the
 * session. Local dev keeps using localStorage for convenience, unchanged.
 *
 * This is deliberately temporary. Once the broker deploys (Track A) the
 * browser stops holding a workspace credential at all and this whole
 * section goes away.
 */
const TOKEN_PERSISTENT = !isDeployedMode;

let cloudRunToken: string = readStorage(TOKEN_KEY, TOKEN_PERSISTENT) ?? '';

/** The current bearer token, trimmed. Never logged — read only by callVerbCloudRun and the token-entry gate's "already set" check. */
export function getCloudRunToken(): string {
  return cloudRunToken.trim();
}

/** Sets the active bearer token; persists it only outside deployed mode (see the storage section's header comment). */
export function setCloudRunToken(token: string): void {
  cloudRunToken = token;
  writeStorage(TOKEN_KEY, token || null, TOKEN_PERSISTENT);
}

/** Clears the stored token (logout). */
export function clearCloudRunToken(): void {
  setCloudRunToken('');
}

// --- Redaction -------------------------------------------------------------------
// Mirrors ui/src/connection.ts's redaction helpers exactly: bearer credentials must
// never appear in logs, thrown error messages, or the DOM, even when a broken
// upstream (a proxy's error page, a misconfigured server) echoes a header back
// verbatim in its response body.
const BEARER_VALUE = /bearer\s+(?:[a-z0-9._~+/=-]*[0-9._~+/=][a-z0-9._~+/=-]*|[a-z-]{12,})/gi;

function redactSecretText(text: string): string {
  return text.replace(BEARER_VALUE, 'Bearer [redacted]');
}

// --- Cloud Run MCP transport ----------------------------------------------------
// Talks directly to the live Cloud Run control plane over JSON-RPC — the same
// request/response shape ui/src/mcp/client.ts uses:
//   request:  {jsonrpc:"2.0", id, method:"tools/call", params:{name, arguments}}
//   success:  result.structuredContent = {ok, data, error}  ->  returns `.data`
// The browser holds the MCP bearer token directly; there is no server-side broker
// in front of this plane (Cloud Run always used direct bearer-token auth against
// its absolute URL — see ui/src/connection.ts's header comment).
//
// Unlike ui/'s client, every failure path here keeps the raw HTTP status and a
// truncated snippet of the actual response body in the thrown message. This is the
// exact gap that hid the dead Netlify transport for as long as it did: a 502 with
// an HTML/JSON error body has no `structuredContent`, so a client that only reads
// `structuredContent.error` falls through to a generic "MCP tool returned an
// error" and never surfaces the real HTTP 502 / `ERR_REQUIRE_ESM` underneath. A
// non-2xx or unparseable response must never read as less informative than the
// raw facts — a 502 must read like a 502.
const RESPONSE_SNIPPET_MAX = 400;

function snippet(text: string): string {
  const trimmed = redactSecretText(text).trim();
  if (!trimmed) return '(empty response body)';
  return trimmed.length > RESPONSE_SNIPPET_MAX ? `${trimmed.slice(0, RESPONSE_SNIPPET_MAX)}…` : trimmed;
}

interface CloudRunJsonRpcResponse<T> {
  result?: { structuredContent?: { ok: boolean; data?: T; error?: unknown } };
  error?: { message: string; data?: unknown };
}

// --- W0: one POST per verb -------------------------------------------------------
// This transport used to collect every verb called in the same event-loop tick and
// send them as ONE JSON-RPC batch POST (P2-03, "tick-level JSON-RPC batching").
// Measured live on 2026-09-14 from the operator's browser, that trade was inverted:
// a batch costs the SLOWEST verb in it, for every verb in it, and one dropped
// connection rejects all of them together. A Workbench mount batched
// `workspace_get_nodes` (2.2 s) with an unscoped `workflow_list_runs` (16 s) and
// `constellation_get_attention` (which drops the connection somewhere between 13 s
// and 56 s), so the whole screen waited on the worst call in the tick and then lost
// the lot — nodes and prompt included, which had been ready for fourteen seconds.
//
// So: one POST per verb. Extra round trips are cheap against a warm keep-alive
// connection; head-of-line blocking between unrelated panels is not. Each call now
// succeeds, fails, times out and retries entirely on its own.
//
// Nothing on the wire had to change: this already sent a single request object
// (not an array) whenever a "batch" happened to hold one call, and `unwrapRpc`
// still tolerates a one-element array answer.

/**
 * Per-call ceiling. Nothing on this plane may hang forever. Before this, a verb
 * whose connection was dropped mid-flight simply never settled, and every
 * `isLoading` bound to it stayed a skeleton for the life of the page — that is
 * exactly the "Attention / Recent runs / Learning activity skeletons forever"
 * symptom, and no amount of error-card work upstream can fix a promise that never
 * rejects. 25 s sits above the slowest verb ever measured healthy here (16 s,
 * unscoped `workflow_list_runs`) and well below a human's patience for a dead panel.
 */
export const CALL_TIMEOUT_MS = 25_000;

// Both are module state rather than constants only so the test seam at the bottom of
// this section can point a test at a same-origin stub and shorten the clock; nothing
// in the app ever reassigns them.
let cloudRunEndpoint: string = CLOUD_RUN_MCP_URL;
let cloudRunTimeoutMs: number = CALL_TIMEOUT_MS;

// JSON-RPC ids stay unique per page so a response is always attributable, even
// though each POST now carries exactly one request.
let rpcSeq = 0;

function rpcRequest(id: number, verb: string, args?: object) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'tools/call' as const,
    params: { name: verb, arguments: args ?? {} },
  };
}

/** Turns one JSON-RPC response object into the resolved value, or throws. */
function unwrapRpc<T>(payload: CloudRunJsonRpcResponse<T> | undefined, verb: string): T {
  if (!payload) {
    throw new NetworkError(verb, 'The Cloud Run MCP endpoint returned no response for this call.');
  }
  if (payload.error) {
    throw new McpError('mcp_error', redactSecretText(payload.error.message), verb);
  }
  const structured = payload.result?.structuredContent;
  if (!structured || structured.ok !== true) {
    const errCode =
      structured?.error && typeof structured.error === 'object' && 'code' in structured.error
        ? String((structured.error as { code?: unknown }).code)
        : 'mcp_error';
    throw new McpError(errCode, describeErrorEnvelope(structured?.error) ?? 'MCP tool returned an error.', verb);
  }
  return structured.data as T;
}

async function callVerbCloudRun<T>(verb: string, args?: object): Promise<T> {
  const token = getCloudRunToken();
  if (!token) {
    throw new AuthError(verb, 'Enter an MCP bearer token before calling workspace tools.');
  }

  const controller = new AbortController();
  // The abort covers the response BODY as well as the connection — a server that
  // answers headers promptly and then stops writing is the same dead panel to a
  // reader as one that never answers at all.
  const timer = setTimeout(() => controller.abort(), cloudRunTimeoutMs);
  const timedOut = () => new NetworkError(verb, `timed out after ${Math.round(cloudRunTimeoutMs / 1000)}s`);

  try {
    let res: Response;
    try {
      res = await fetch(cloudRunEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(rpcRequest(++rpcSeq, verb, args)),
        signal: controller.signal,
      });
    } catch (err) {
      // An abort is OUR ceiling, not the network's failure. Reporting it as a generic
      // "network request failed" sends an operator looking at their wifi instead of at
      // a verb that is genuinely too slow.
      if (controller.signal.aborted) throw timedOut();
      const message = err instanceof Error ? redactSecretText(err.message) : 'The network request failed.';
      throw new NetworkError(verb, message);
    }

    // Always read the raw body as text first (never `res.json()` directly) so a
    // non-2xx or non-JSON response — the 502 case this transport replaces — still
    // has real text to report instead of silently discarding it on a parse failure.
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch (err) {
      // REVIEW FIX — a body read that fails for any reason OTHER than our own abort used to be
      // swallowed, leaving bodyText empty; execution then fell through to the JSON branch and the
      // operator was told "the response was not valid JSON (HTTP 200):" with nothing after the
      // colon. The commonest cause is the documented Cloud Run symptom — the connection reset
      // mid-body — so the message pointed away from the actual failure. Report what happened.
      if (controller.signal.aborted) throw timedOut();
      const message = err instanceof Error ? redactSecretText(err.message) : 'The response body could not be read.';
      throw new NetworkError(verb, `Cloud Run MCP response body was cut off (HTTP ${res.status}): ${message}`);
    }

    if (res.status === 401) {
      throw new AuthError(verb, `The Cloud Run MCP endpoint rejected the bearer token (HTTP 401): ${snippet(bodyText)}`);
    }
    if (res.status === 403) {
      // P2-04 — NOT an AuthError. See PermissionError's doc comment.
      throw new PermissionError(verb, `The workspace refused this call (HTTP 403): ${snippet(bodyText)}`);
    }
    if (!res.ok) {
      throw new NetworkError(verb, `Cloud Run MCP request failed with HTTP ${res.status}: ${snippet(bodyText)}`);
    }

    let parsed: unknown = null;
    try {
      parsed = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      throw new NetworkError(verb, `Cloud Run MCP response was not valid JSON (HTTP ${res.status}): ${snippet(bodyText)}`);
    }

    // A server that answers a single request with a one-element array is handled
    // rather than trusted — the same tolerance the batch path had, kept.
    const payload = (Array.isArray(parsed) ? parsed[0] : parsed) as CloudRunJsonRpcResponse<T> | undefined;
    return unwrapRpc<T>(payload, verb);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Test-only seam, mirroring LoginGate.tsx's `__test_setUnauthenticated`/`__test_reset`
 * exports. The Cloud Run transport is selected by a build-time env flag, so a test
 * against the fixture-mode dev server cannot reach this path through `callVerb` at
 * all; `call` is the only way to exercise it. `setEndpoint` points it at a
 * same-origin stub (no cross-origin preflight to fake), and `setTimeoutMs` shortens
 * the 25 s clock so the timeout can be proven in milliseconds rather than waited out.
 */
export const __test_cloudRun = {
  call: <T,>(verb: string, args?: object): Promise<T> => callVerbCloudRun<T>(verb, args),
  setEndpoint: (url: string): void => { cloudRunEndpoint = url; },
  setTimeoutMs: (ms: number): void => { cloudRunTimeoutMs = ms; },
  reset: (): void => { cloudRunEndpoint = CLOUD_RUN_MCP_URL; cloudRunTimeoutMs = CALL_TIMEOUT_MS; },
};

function getSessionCloudRun(): SessionInfo {
  return { authenticated: Boolean(getCloudRunToken()), readOnly: IS_READ_ONLY };
}

// --- session ----------------------------------------------------------------

export interface SessionInfo {
  authenticated: boolean;
  operator?: string;
  readOnly: boolean;
  workspace?: { version: number; ok: boolean };
}

export async function getSession(): Promise<SessionInfo> {
  if (IS_MOCK) {
    await delay(MOCK_DELAY_MS);
    return { authenticated: true, operator: 'mock-operator', readOnly: IS_READ_ONLY, workspace: { version: 1, ok: true } };
  }
  if (IS_CLOUD_RUN_TRANSPORT) {
    return getSessionCloudRun();
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/session`, { credentials: 'include' });
  } catch (err) {
    throw new NetworkError('session', err instanceof Error ? err.message : 'The network request failed.');
  }
  if (!res.ok) {
    throw new NetworkError('session', `Session check failed (status ${res.status}).`);
  }
  return (await res.json()) as SessionInfo;
}

/**
 * `password` is overloaded by transport: the broker network path reads it as
 * an operator password; the Cloud Run transport reads it as the literal MCP
 * bearer token entered into the token-entry gate (LoginGate.tsx) — never
 * validated against the network up front (ui/'s Cloud Run connection does
 * the same: a non-empty token is accepted immediately and the first real
 * tool call is what actually proves it, surfacing a precise 401/403 via
 * AuthError above if it's wrong).
 */
export async function login(password: string): Promise<SessionInfo> {
  if (IS_MOCK) {
    await delay(MOCK_DELAY_MS);
    if (!password) throw new AuthError('login', 'Password is required.');
    return { authenticated: true, operator: 'mock-operator', readOnly: IS_READ_ONLY, workspace: { version: 1, ok: true } };
  }
  if (IS_CLOUD_RUN_TRANSPORT) {
    const token = password.trim();
    if (!token) throw new AuthError('login', 'Enter an MCP bearer token before calling workspace tools.');
    setCloudRunToken(token);
    return getSessionCloudRun();
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch (err) {
    throw new NetworkError('login', err instanceof Error ? err.message : 'The network request failed.');
  }
  const body = (await res.json().catch(() => null)) as (SessionInfo & { ok: true }) | { ok: false; error: { code: string; message: string } } | null;
  if (res.status === 401 || !body || !body.ok) {
    const message = body && !body.ok ? body.error.message : 'Login failed.';
    throw new AuthError('login', message);
  }
  return body;
}

export async function logout(): Promise<void> {
  if (IS_MOCK) {
    await delay(MOCK_DELAY_MS);
    return;
  }
  if (IS_CLOUD_RUN_TRANSPORT) {
    setCloudRunToken('');
    return;
  }
  await fetch(`${API_BASE}/api/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
}

// --- fixture-mode verb resolution --------------------------------------------
// The handlers and the ~600 KB fixture set they read live in ./mock/handlers,
// loaded through a dynamic import so a deployed build never downloads them.
// See that file's header for why.

export type Args = Record<string, unknown>;

async function callVerbMock<T>(verb: string, args: Args): Promise<T> {
  const { runMockVerb } = await import('./mock/handlers');
  return runMockVerb<T>(verb, args);
}
