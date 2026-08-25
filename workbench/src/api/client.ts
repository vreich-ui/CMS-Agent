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

import { mockStore } from './mockStore';
import * as adapters from './adapters';
import type { Skill } from '../types';

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
      message ??
        `"${verb}" is disabled — the workbench is running read-only. Set VITE_READ_ONLY=0 to enable mutations.`,
      verb,
    );
    this.name = 'ReadOnlyError';
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
  'changes_restore',
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

export async function callVerb<T>(verb: string, args?: object): Promise<T> {
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

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Token simply doesn't persist when storage is unavailable.
  }
}

let cloudRunToken: string = isDeployedMode ? '' : (readStorage(TOKEN_KEY) ?? '');

/** The current bearer token, trimmed. Never logged — read only by callVerbCloudRun and the token-entry gate's "already set" check. */
export function getCloudRunToken(): string {
  return cloudRunToken.trim();
}

/** Sets the active bearer token; persists it only outside deployed mode (see the storage section's header comment). */
export function setCloudRunToken(token: string): void {
  cloudRunToken = token;
  if (!isDeployedMode) writeStorage(TOKEN_KEY, token || null);
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

async function callVerbCloudRun<T>(verb: string, args?: object): Promise<T> {
  const token = getCloudRunToken();
  if (!token) {
    throw new AuthError(verb, 'Enter an MCP bearer token before calling workspace tools.');
  }

  let res: Response;
  try {
    res = await fetch(CLOUD_RUN_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: verb, arguments: args ?? {} },
      }),
    });
  } catch (err) {
    throw new NetworkError(verb, err instanceof Error ? redactSecretText(err.message) : 'The network request failed.');
  }

  // Always read the raw body as text first (never `res.json()` directly) so a
  // non-2xx or non-JSON response — the 502 case this transport replaces — still
  // has real text to report instead of silently discarding it on a parse failure.
  const bodyText = await res.text().catch(() => '');

  if (res.status === 401 || res.status === 403) {
    throw new AuthError(verb, `The Cloud Run MCP endpoint rejected the bearer token (HTTP ${res.status}): ${snippet(bodyText)}`);
  }
  if (!res.ok) {
    throw new NetworkError(verb, `Cloud Run MCP request failed with HTTP ${res.status}: ${snippet(bodyText)}`);
  }

  let payload: CloudRunJsonRpcResponse<T> | null = null;
  try {
    payload = bodyText ? (JSON.parse(bodyText) as CloudRunJsonRpcResponse<T>) : null;
  } catch {
    payload = null;
  }
  if (!payload) {
    throw new NetworkError(verb, `Cloud Run MCP response was not valid JSON (HTTP ${res.status}): ${snippet(bodyText)}`);
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

type Args = Record<string, unknown>;

function str(args: Args, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}
function optStr(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}
function optNum(args: Args, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

let mockIdCounter = 0;
function genId(prefix: string): string {
  mockIdCounter += 1;
  return `${prefix}_${Date.now()}_${mockIdCounter.toString(36)}`;
}

function schemaStub(nodeId: string, kind: 'input' | 'output'): Record<string, unknown> {
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
    description: `No live ${kind} schema captured for "${nodeId}" in the fixture set — placeholder schema.`,
  };
}

function toolsFor(node: adapters.RawWorkflowNode | undefined): adapters.RawToolDef[] {
  if (!node) return [];
  const all = mockStore.getTools();
  return node.allowedTools.map((id) => all.find((t) => t.toolId === id)).filter((t): t is adapters.RawToolDef => Boolean(t));
}
function skillsFor(node: adapters.RawWorkflowNode | undefined): Skill[] {
  if (!node) return [];
  const all = mockStore.getSkills();
  return node.assignedSkills
    .map((id) => all.find((s) => s.skillId === id))
    .filter((s): s is adapters.RawSkill => Boolean(s))
    .map((s) => adapters.toSkill(s, mockStore.assignedToFor(s.skillId)));
}

function graphFor(workflowId: string): { workflowId: string; nodes: Array<{ id: string; deps: string[] }>; edges: Array<{ from: string; to: string }> } {
  const wf = mockStore.getWorkflow(workflowId);
  if (!wf) return { workflowId, nodes: [], edges: [] };
  const order: string[] = wf.phases.flatMap(([, ids]) => ids);
  const edges: Array<{ from: string; to: string }> = [];
  for (let i = 1; i < order.length; i++) edges.push({ from: order[i - 1], to: order[i] });
  const nodes = order.map((id, i) => ({ id, deps: i === 0 ? [] : [order[i - 1]] }));
  return { workflowId, nodes, edges };
}

/** `err`/`done` — the same two counts toRun() itself derives from a raw
 *  run's `nodes[]`/`errors[]` — needed by a couple of mock handlers below
 *  that reason about run progress without going through the full adapter. */
function errCount(run: adapters.RawRun): number {
  return run.errors.length;
}
function doneCount(run: adapters.RawRun): number {
  return run.nodes.filter((n) => n.status === 'completed').length;
}

const MOCK_HANDLERS: Record<string, (args: Args) => unknown> = {
  // -- workspace / node reads --
  // workspace_get_graph / workspace_get_nodes take no args live and always
  // return everything — workflowId filtering happens client-side in
  // verbs.ts now, so the mock ignores any workflowId it's handed too.
  workspace_get_graph: (a) => graphFor(str(a, 'workflowId')),
  workspace_get_nodes: () => ({ nodes: mockStore.getNodes() }),
  workspace_get_node: (a) => ({ node: mockStore.getNode(str(a, 'id')) ?? null }),
  workspace_get_node_effective_config: (a) => {
    const node = mockStore.getNode(str(a, 'id'));
    return {
      config: {
        nodeId: str(a, 'id'),
        model: node?.modelConfig ? adapters.toModelConfig(node.modelConfig) : null,
        tools: node?.allowedTools ?? [],
        skills: node?.assignedSkills ?? [],
        prompt: node?.prompt ?? null,
        source: 'seed',
      },
    };
  },
  node_get_effective_prompt: (a) => {
    const node = mockStore.getNode(str(a, 'nodeId'));
    return { nodeId: str(a, 'nodeId'), prompt: node?.prompt ?? '', diverged: false, source: 'canonical' };
  },
  node_get_effective_skills: (a) => skillsFor(mockStore.getNode(str(a, 'nodeId'))),
  node_get_effective_tools: (a) => toolsFor(mockStore.getNode(str(a, 'nodeId'))).map(adapters.toToolDef),
  // Live nodes carry their own input/output JSON Schema (`inputSchema`/
  // `outputSchema`) — fall back to a labeled placeholder only for the rare
  // node this fixture set doesn't have one for.
  node_get_input_schema: (a) => {
    const node = mockStore.getNode(str(a, 'nodeId'));
    return node?.inputSchema ?? schemaStub(str(a, 'nodeId'), 'input');
  },
  node_get_output_schema: (a) => {
    const node = mockStore.getNode(str(a, 'nodeId'));
    return node?.outputSchema ?? schemaStub(str(a, 'nodeId'), 'output');
  },
  node_validate_input: (a) => {
    const hasInput = a.input !== undefined && a.input !== null;
    return { valid: hasInput, errors: hasInput ? [] : ['Missing input payload.'] };
  },
  node_list_executions: (a) => {
    const nodeId = str(a, 'nodeId');
    const runId = optStr(a, 'runId');
    if (runId) {
      const run = mockStore.getRun(runId);
      if (!run) return [];
      return [
        {
          id: `${runId}_${nodeId}`,
          runId,
          nodeId,
          status: run.currentNodeId === nodeId ? run.status : 'completed',
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      ];
    }
    const wfId = mockStore.getWorkflowIdForNode(nodeId);
    return mockStore
      .getRuns({ workflowId: wfId, limit: 5 })
      .map((run) => ({
        id: `${run.runId}_${nodeId}`,
        runId: run.runId,
        nodeId,
        status: run.currentNodeId === nodeId ? run.status : 'completed',
        startedAt: null,
        completedAt: null,
        durationMs: null,
      }));
  },

  // -- workflow / run reads --
  workflow_list_runs: (a) => {
    const runs = mockStore.getRuns({
      workflowId: optStr(a, 'workflowId'),
      projectId: optStr(a, 'projectId'),
      status: optStr(a, 'status'),
      limit: optNum(a, 'limit'),
    });
    return { runs, page: { limit: optNum(a, 'limit') ?? runs.length, matchedCount: runs.length, hasMore: false } };
  },
  // Live wraps `{ run, mode, stall }` — mode/stall are siblings of `run`,
  // not nested inside it (verbs.ts's workflowGetRun folds them back on
  // before adapting) — mirrored here rather than nesting them in `run`.
  workflow_get_run: (a) => {
    const run = mockStore.getRun(str(a, 'runId'));
    if (!run) return null;
    return { run, mode: { executionMode: run.mode?.executionMode ?? run.executionMode }, stall: run.stall ?? null };
  },
  workflow_get_run_context: (a) => {
    const run = mockStore.getRun(str(a, 'runId'));
    if (!run) return null;
    return {
      runId: run.runId,
      workflowId: run.workflowId,
      projectId: run.projectId,
      currentNodeId: run.currentNodeId ?? null,
      status: run.status,
      nodesCompleted: doneCount(run),
      nodesErrored: errCount(run),
      dryRun: run.dryRun,
      executionMode: run.mode?.executionMode ?? run.executionMode,
    };
  },
  // Live wraps `{ ledger, plan }` (LIVE-VERIFIED CORRECTION, workbench-verb-fixes
  // — see verbs.ts's workflowGetRunCost doc comment). `plan` carries no field
  // any adapter reads, so the mock returns `null` for it rather than
  // fabricating the resume/reuse recommendation live actually computes.
  workflow_get_run_cost: (a) => {
    const runId = str(a, 'runId');
    return { ledger: mockStore.getCostLedger(runId) ?? { runId, totalCostUsdEstimate: 0 }, plan: null };
  },
  // Added by WP-23 (gate panel readiness viewer). Every check below is
  // derived from fields this fixture set actually carries on the run record
  // (error count, progress, budget) — see PublishReadiness's doc comment in
  // ../types.ts. The operator-decision check is deliberately never reported
  // as a pass here: it is exactly the thing Approve/Decline records.
  workflow_publish_readiness: (a) => {
    const runId = str(a, 'runId');
    const run = mockStore.getRun(runId);
    if (!run) return { runId, nodeId: null, checks: [], overallGo: false, source: 'derived' };
    const wf = mockStore.getWorkflow(run.workflowId);
    const order: string[] = wf ? wf.phases.flatMap(([, ids]) => ids) : [];
    const cur = run.currentNodeId ?? null;
    const gateIdx = cur ? order.indexOf(cur) : -1;
    const done = doneCount(run);
    const err = errCount(run);
    const ledger = mockStore.getCostLedger(runId);
    const cost = ledger?.totalCostUsdEstimate ?? 0;
    const budget = ledger?.budget?.budgetUsd ?? run.budgetUsd ?? null;
    const checks = [
      {
        id: 'errors',
        label: 'No node errors recorded on this run',
        pass: err === 0,
        detail: `${err} error${err === 1 ? '' : 's'} recorded on this run.`,
      },
      {
        id: 'progress',
        label: 'Every upstream node has completed',
        pass: gateIdx < 0 || done >= gateIdx,
        detail: `${done}/${order.length} nodes completed before ${cur ?? 'this gate'}.`,
      },
      {
        id: 'budget',
        label: 'Run is within its budget cap',
        pass: !budget || cost <= budget,
        detail: budget
          ? `$${cost.toFixed(2)} spent of a $${budget} cap.`
          : `$${cost.toFixed(2)} spent — no budget cap set on this run.`,
      },
      {
        id: 'operator_decision',
        label: 'Durable operator publish decision recorded',
        pass: false,
        detail: 'Not yet recorded for this run — Approve below records "approved"; Decline records nothing and cancels the run.',
      },
    ];
    return { runId, nodeId: cur, checks, overallGo: checks.every((c) => c.pass === true), source: 'derived' };
  },
  // Real schema is `{stage?}` (stage == nodeId), returning full entries —
  // `{id, stage, value, createdAt}` — never a bare id list, and never keyed
  // by runId. verbs.ts's stageGetOutput composes on top of this list by
  // filtering for an id scoped to the requested run.
  stage_list_outputs: (a) => {
    const stage = optStr(a, 'stage');
    const outputs = mockStore
      .getRuns()
      .filter((run) => !stage || mockStore.getNodes(run.workflowId).some((n) => n.id === stage))
      .flatMap((run) =>
        mockStore
          .getNodes(run.workflowId)
          .slice(0, doneCount(run))
          .filter((n) => !stage || n.id === stage)
          .map((n) => ({
            id: `${run.runId}:${n.id}`,
            stage: n.id,
            value: { note: 'No live stage output captured for this fixture — placeholder.' },
            createdAt: run.startedAt,
          })),
      );
    return { outputs };
  },
  stage_get_output: (a) => ({
    output: { id: str(a, 'id'), value: { note: 'No live stage output captured for this fixture — placeholder.' } },
  }),

  // -- changes --
  // Real schema wraps in `{events}` (not a bare array) with eventId /
  // resultingRevisionId / target.id / actor / createdAt fields — this
  // fixture set records no change history, so an empty list is honest.
  changes_list: () => ({ events: [] }),
  changes_get: () => null,
  changes_compare: (a) => ({
    diff: {
      fromRevisionId: str(a, 'fromRevisionId'),
      toRevisionId: str(a, 'toRevisionId'),
      nodes: { added: [], removed: [], changed: [] },
      relationships: { added: [], removed: [], changedIds: [] },
    },
  }),

  // -- registry --
  project_list: () => ({ projects: mockStore.getProjects() }),
  project_test_connection: (a) => {
    const project = mockStore.getProject(str(a, 'projectId'));
    const ok = Boolean(project?.connection?.endpointConfigured && project?.connection?.tokenConfigured);
    return {
      projectId: str(a, 'projectId'),
      ok,
      latencyMs: ok ? 120 : null,
      message: ok ? 'Connection healthy.' : 'Endpoint unset or unreachable.',
    };
  },
  tool_list: () => ({ tools: mockStore.getTools() }),
  skill_list: () => ({ skills: mockStore.getSkills() }),
  skill_resolve_for_node: (a) => skillsFor(mockStore.getNode(str(a, 'nodeId'))),
  agent_list: () => ({ agents: mockStore.getAgents() }),
  repository_get_health: () => ({ ok: true, checkedAt: new Date().toISOString(), issues: [] }),

  // -- learning --
  // Real schema is `{includeArchived?}` — no node filter live; verbs.ts
  // fetches everything and filters client-side on the raw item's `nodeId`
  // field, which this fixture set's items already carry natively.
  learning_list_observations: () => ({ observations: mockStore.getObservations() }),
  playbook_get: (a) => ({
    nodeId: str(a, 'nodeId'),
    lessons: [],
    version: 0,
    note: 'No playbook captured in fixtures for this node yet.',
  }),

  // -- evaluation --
  evaluation_list_rubrics: () => ({ rubrics: mockStore.getRubrics() }),
  evaluation_list_results: (a) => {
    const nodeId = optStr(a, 'nodeId');
    return mockStore
      .getRegressionReports(nodeId)
      .map((r) => ({ nodeId: r.nodeId, score: r.summary?.meanScore ?? null, verdict: r.verdict }));
  },
  evaluation_list_regression_reports: (a) => ({ reports: mockStore.getRegressionReports(optStr(a, 'nodeId')) }),

  // -- optimizer --
  optimizer_status: (a) => ({ nodeId: optStr(a, 'nodeId') ?? null, proposals: [], lastTrial: null, state: 'idle' }),

  // -- dataset --
  dataset_list: () => ({ datasets: mockStore.getDatasets() }),
  dataset_finetune_readiness: () => ({ readiness: mockStore.getReadiness() }),

  // -- feedback --
  feedback_list: () => [],

  // -- usage --
  usage_get_summary: (a) => {
    const wfId = optStr(a, 'workflowId');
    if (!wfId) return mockStore.getUsageOverall();
    return mockStore.getUsageByWorkflow(wfId) ?? { totalCostUsdEstimate: 0 };
  },
  usage_get_budget_status: (a) => {
    const runId = optStr(a, 'runId');
    if (runId) {
      const ledger = mockStore.getCostLedger(runId);
      const spent = ledger?.totalCostUsdEstimate ?? 0;
      const budget = ledger?.budget?.budgetUsd ?? null;
      return { runId, spentUsd: spent, budgetUsd: budget, pctUsed: budget ? spent / budget : null };
    }
    const overall = mockStore.getUsageOverall();
    return { runId: null, spentUsd: overall.totalCostUsdEstimate ?? overall.costUsdEstimate ?? 0, budgetUsd: null, pctUsed: null };
  },

  // ==== mutating verbs (logged; mutate mockStore; return a plausible result) ====

  workflow_start_dry_run: (a) => {
    // `dry` defaults true (undefined/anything but literal `false`); mirrors
    // verbs.ts's workflowStartDryRun doc comment. Added by WP-22 so a live
    // launch from the start-run modal actually comes back live in mock mode
    // too, instead of silently reporting dry·mock regardless of the operator's
    // choice (HANDOFF §7.9 — nothing pretends).
    const dry = a.dry !== false;
    const execRaw = optStr(a, 'executionMode');
    const exec = execRaw === 'openai' ? 'openai' : 'mock';
    const run: adapters.RawRun = {
      runId: genId('run'),
      requestId: optStr(a, 'requestId'),
      workflowId: str(a, 'workflowId'),
      projectId: str(a, 'projectId'),
      status: 'queued',
      currentNodeId: null,
      startedAt: new Date().toISOString(),
      nodes: [],
      errors: [],
      dryRun: dry,
      executionMode: exec,
      budgetUsd: optNum(a, 'budgetUsd') ?? null,
      mode: { executionMode: exec },
    };
    return mockStore.addRun(run);
  },
  workflow_run_all: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'running' }) ?? null,
  workflow_run_next_node: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'running' }) ?? null,
  workflow_run_until: (a) =>
    mockStore.updateRunRaw(str(a, 'runId'), { status: 'running', currentNodeId: str(a, 'nodeId') }) ?? null,
  workflow_run_node: (a) =>
    mockStore.updateRunRaw(str(a, 'runId'), { status: 'running', currentNodeId: str(a, 'nodeId') }) ?? null,
  workflow_pause_run: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'paused' }) ?? null,
  workflow_resume_run: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'running' }) ?? null,
  workflow_cancel_run: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'cancelled' }) ?? null,
  workflow_reset_run: (a) =>
    mockStore.updateRunRaw(str(a, 'runId'), { status: 'queued', currentNodeId: null, nodes: [], errors: [] }) ?? null,
  workflow_retry_node: (a) =>
    mockStore.updateRunRaw(str(a, 'runId'), { status: 'running', currentNodeId: str(a, 'nodeId') }) ?? null,
  workflow_set_operator_publish_decision: (a) => {
    const decision = str(a, 'decision');
    return mockStore.updateRunRaw(str(a, 'runId'), { status: decision === 'approve' ? 'running' : 'cancelled' }) ?? null;
  },
  workflow_publish_run: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'completed' }) ?? null,

  workspace_update_node_prompt: (a) => mockStore.updateNode(str(a, 'nodeId'), { prompt: str(a, 'prompt') }) ?? null,
  workspace_update_node_tools: (a) =>
    mockStore.updateNode(str(a, 'nodeId'), { allowedTools: (a.tools as string[]) ?? [] }) ?? null,
  workspace_update_node_skills: (a) =>
    mockStore.updateNode(str(a, 'nodeId'), { assignedSkills: (a.skills as string[]) ?? [] }) ?? null,
  workspace_update_node_model_config: (a) =>
    mockStore.updateNode(str(a, 'nodeId'), { modelConfig: a.model as adapters.RawModelConfig }) ?? null,
  workspace_update_node_input_schema: (a) => ({ nodeId: str(a, 'nodeId'), schema: a.schema ?? null, applied: true }),
  workspace_update_node_output_schema: (a) => ({ nodeId: str(a, 'nodeId'), schema: a.schema ?? null, applied: true }),
  workspace_update_node_metadata: (a) => {
    const metadata = (a.metadata ?? {}) as Partial<Pick<adapters.RawWorkflowNode, 'name' | 'description' | 'kind' | 'riskLevel'>>;
    return mockStore.updateNode(str(a, 'nodeId'), metadata) ?? null;
  },
  workspace_validate_node: () => ({ valid: true, errors: [] }),

  changes_restore: (a) => ({ nodeId: str(a, 'nodeId'), changeId: str(a, 'revisionId'), restored: true }),

  skill_update: (a) => mockStore.updateSkill(str(a, 'skillId'), (a.patch as Partial<adapters.RawSkill>) ?? {}) ?? null,
  skill_assign: (a) => mockStore.assignSkill(str(a, 'nodeId'), str(a, 'skillId')) ?? null,
  skill_unassign: (a) => mockStore.unassignSkill(str(a, 'nodeId'), str(a, 'skillId')) ?? null,
  skill_restore_version: (a) => mockStore.updateSkill(str(a, 'skillId'), { version: str(a, 'version') }) ?? null,

  learning_record_observation: (a): adapters.RawObservation =>
    mockStore.addObservation({
      id: genId('learning'),
      observation: str(a, 'txt'),
      nodeId: optStr(a, 'nodeId') ?? null,
      runId: optStr(a, 'runId') ?? null,
      createdAt: new Date().toISOString(),
    }),
  learning_archive_observation: (a) => mockStore.archiveObservation(str(a, 'id')) ?? null,

  playbook_curate: (a) => ({ nodeId: str(a, 'nodeId'), lesson: a.lesson ?? null, applied: true }),
  playbook_apply_delta: (a) => ({ nodeId: str(a, 'nodeId'), delta: a.delta ?? null, applied: true }),
  playbook_migrate_observations: () => ({ migrated: 0 }),

  feedback_record: (a) => {
    mockStore.recordPreferencePair();
    return { id: genId('feedback'), ...a, recordedAt: new Date().toISOString() };
  },

  evaluation_create_rubric: (a): adapters.RawRubric | null => {
    const rubric: adapters.RawRubric = {
      nodeId: str(a, 'node'),
      criteria: [],
    };
    return mockStore.updateRubric(rubric.nodeId, rubric) ?? rubric;
  },
  evaluation_update_rubric: (a) =>
    mockStore.updateRubric(str(a, 'node'), (a.patch as Partial<adapters.RawRubric>) ?? {}) ?? null,
  evaluation_run: (a) => {
    const report = mockStore.getRegressionReports(str(a, 'node'))[0];
    return {
      node: str(a, 'node'),
      score: report?.summary?.meanScore ?? null,
      verdict: report?.verdict ?? 'pending',
      ranAt: new Date().toISOString(),
    };
  },
  evaluation_run_regression: (a) => {
    const report = mockStore.getRegressionReports(str(a, 'node'))[0];
    return {
      node: str(a, 'node'),
      score: report?.summary?.meanScore ?? null,
      verdict: report?.verdict ?? 'pending',
      baseline: report?.summary?.meanScore ?? null,
      ranAt: new Date().toISOString(),
    };
  },
  evaluation_restore_rubric_version: (a) => mockStore.getRubric(str(a, 'node')) ?? null,

  optimizer_analyze: (a) => ({ nodeId: str(a, 'nodeId'), findings: [], analyzedAt: new Date().toISOString() }),
  optimizer_propose: (a) => ({ nodeId: str(a, 'nodeId'), proposalId: genId('prop'), promptDiff: '', createdAt: new Date().toISOString() }),
  optimizer_run_trial: (a) => ({ proposalId: str(a, 'proposalId'), trialId: genId('trial'), score: null, status: 'queued' }),
  optimizer_promote: (a) => ({ proposalId: str(a, 'proposalId'), promoted: true, promotedAt: new Date().toISOString() }),
  optimizer_auto_promote: (a) => ({
    nodeId: str(a, 'nodeId'),
    autoPromoted: false,
    reason: 'Auto-promote thresholds not met in mock mode.',
  }),

  dataset_build: (a): adapters.RawDataset =>
    mockStore.addDataset({
      datasetId: genId('ds'),
      nodeId: str(a, 'node'),
      name: 'Built via dataset_build (mock).',
      cases: Array.from({ length: optNum(a, 'cases') ?? 0 }, (_, i) => ({ caseId: genId(`case_${i}`), nodeId: str(a, 'node') })),
      createdAt: new Date().toISOString(),
    }),
  dataset_export_sft: (a) => ({ datasetId: str(a, 'datasetId'), format: 'sft', ready: true, downloadUrl: null }),
  dataset_export_preferences: (a) => ({
    datasetId: str(a, 'datasetId'),
    format: 'preferences',
    ready: true,
    downloadUrl: null,
  }),
};

async function callVerbMock<T>(verb: string, args: Args): Promise<T> {
  await delay(MOCK_DELAY_MS);
  const handler = MOCK_HANDLERS[verb];
  if (!handler) {
    // eslint-disable-next-line no-console
    console.warn(`[api mock] no fixture handler for verb "${verb}" — returning null.`);
    return null as T;
  }
  if (MUTATING_VERBS.has(verb)) {
    // eslint-disable-next-line no-console
    console.log(`[api mock] ${verb}`, args);
  }
  return handler(args) as T;
}
