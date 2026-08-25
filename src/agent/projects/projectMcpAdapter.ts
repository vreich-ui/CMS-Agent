// Generic adapter for ANY registered project MCP connection. This module is project-agnostic by
// contract: it operates purely on ProjectConnectionConfig and must never grow per-project logic —
// project-specific policy (e.g. Dr. Lurie's artifact rules) belongs in that project's own folder.
// It previously lived under projects/drLurie/, which made every generic caller appear coupled to
// one client; projects/drLurie/adapter.ts remains as a deprecated re-export.
import { effectiveToolPermission, toToolPolicyMap, type ProjectConnectionConfig, type ProjectConnectionState, type ToolPermission } from "./projectTypes.js";
import { accessSecretValue, type SecretAccessDeps } from "./secretManager.js";
import { McpClientError, isMcpAuthFailure, mcpCallTool, mcpInitialize, mcpListResources, mcpListTools, type McpClientOptions, type McpTransport } from "./mcpClient.js";

// Resolve the MCP endpoint and bearer token for a project. The TOKEN always comes from an
// environment variable and is never persisted, returned to callers, or logged.
//
// The ENDPOINT resolves ENV-FIRST, registry-second:
//   1. env[mcpEndpointEnvVar] — whenever it is populated it wins, so every project registered
//      before ProjectConnectionConfig.mcpEndpoint existed resolves byte-identically to before, and
//      an operator retains a deployment-only override that needs no registry write.
//   2. config.mcpEndpoint — the credential-free endpoint stored on the record (validated at write
//      time by projectAdmin's registryEndpointSchema), so minting a tenant no longer requires
//      hand-adding a <CLIENT>_MCP_ENDPOINT variable to this deployment.
export type EndpointSource = "env" | "registry" | "unset";
export type TokenSource = "env" | "secret" | "unset";
export type ResolvedConnection = { endpointConfigured: boolean; tokenConfigured: boolean; endpoint?: string; endpointSource: EndpointSource; token?: string; tokenSource: TokenSource; tokenError?: string };

// SYNCHRONOUS resolution: the endpoint in full, and the token ONLY from the environment. Kept sync
// and side-effect-free because two callers (driverEnvPreflight, the executor's dispatch stamp) ask
// only "is this project reachable?" and must not perform a privileged Secret Manager read to answer
// it. When the record carries a tokenSecretRef, tokenConfigured is still true here — the token IS
// configured, it just has to be fetched — and resolveProjectConnectionWithSecrets does the fetching.
export function resolveProjectConnection(config: ProjectConnectionConfig, env: NodeJS.ProcessEnv = process.env): ResolvedConnection {
  const fromEnv = env[config.mcpEndpointEnvVar]?.trim() || undefined;
  const fromRegistry = config.mcpEndpoint?.trim() || undefined;
  const endpoint = fromEnv ?? fromRegistry;
  const endpointSource: EndpointSource = fromEnv ? "env" : fromRegistry ? "registry" : "unset";
  const token = config.tokenEnvVar ? (env[config.tokenEnvVar]?.trim() || undefined) : undefined;
  const secretRef = config.tokenSecretRef?.trim() || undefined;
  const tokenSource: TokenSource = token ? "env" : secretRef ? "secret" : "unset";
  return { endpointConfigured: Boolean(endpoint), tokenConfigured: Boolean(token || secretRef), endpoint, endpointSource, token, tokenSource };
}

// ASYNC resolution — the one the transport actually uses. ENV FIRST, RECORD SECOND, exactly as the
// endpoint resolves (T12.20): a populated token env var still wins on every plane that has one, so
// nothing about an existing project changes, and the Secret Manager read happens only when it is
// the answer. A failed read is reported as `tokenError` rather than thrown, so the caller can name
// the misconfiguration instead of surfacing a bare 401 from the tenant later.
export async function resolveProjectConnectionWithSecrets(
  config: ProjectConnectionConfig,
  env: NodeJS.ProcessEnv = process.env,
  deps: SecretAccessDeps = {}
): Promise<ResolvedConnection> {
  const base = resolveProjectConnection(config, env);
  if (base.token || !config.tokenSecretRef) return base;
  const secret = await accessSecretValue(config.tokenSecretRef, deps);
  if (!secret.ok) return { ...base, tokenError: secret.error };
  return { ...base, token: secret.value, tokenConfigured: true, tokenSource: "secret" };
}

// Safe, caller-facing connection view: booleans, env var names, which source answered, and the
// stored (credential-free) endpoint when there is one — never the env var's VALUE and never the token.
export function toConnectionState(config: ProjectConnectionConfig, env: NodeJS.ProcessEnv = process.env): ProjectConnectionState {
  const resolved = resolveProjectConnection(config, env);
  return {
    endpointConfigured: resolved.endpointConfigured,
    tokenConfigured: resolved.tokenConfigured,
    mcpEndpointEnvVar: config.mcpEndpointEnvVar,
    tokenEnvVar: config.tokenEnvVar,
    endpointSource: resolved.endpointSource,
    tokenSource: resolved.tokenSource,
    ...(config.mcpEndpoint ? { mcpEndpoint: config.mcpEndpoint } : {}),
    ...(config.tokenSecretRef ? { tokenSecretRef: config.tokenSecretRef } : {})
  };
}

// McpClientError messages are our own safe constants; any other error (network/DNS/URL) is collapsed
// so an endpoint that embeds credentials can never leak through an error string. The collapse keeps
// the error's NAME (#95 H2's fail-by-name standard — an error class name never contains a URL or
// token): "client_unreachable (TypeError)" tells a caller it was transport, not policy, and what kind,
// where the old single generic string made DNS failure, TLS failure, and timeout indistinguishable.
const sanitizeError = (error: unknown): string => {
  if (error instanceof McpClientError) return error.message;
  const name = error instanceof Error ? error.name : typeof error;
  return `client_unreachable (${name}): failed to reach the project MCP endpoint. The endpoint/token environment variables may be unset in this deployment, the client server may be down, or the network path blocked — project.test_connection isolates which.`;
};

// T1/T2: a client that answered 401/403 is a DIFFERENT fact from a client that could not be reached,
// and the two used to arrive at callers as the same opaque `error` string. An auth failure is the
// deployment's fault (a token this plane cannot see, or a stale one), it will not clear by itself,
// and it must never be absorbed into a "degraded but continue" path — so it is carried out of the
// adapter as a flag rather than left to be pattern-matched out of prose.
export const isProjectAuthFailure = isMcpAuthFailure;

const describeFailure = (error: unknown): { error: string; authFailed?: true; httpStatus?: number } => {
  const message = sanitizeError(error);
  if (!(error instanceof McpClientError)) return { error: message };
  if (!isMcpAuthFailure(error)) return { error: message, ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}) };
  return { error: message, authFailed: true, httpStatus: error.httpStatus };
};

export type ProjectAdapterDeps = { env?: NodeJS.ProcessEnv; transport?: McpTransport; secrets?: SecretAccessDeps };
export type SafeToolInfo = { name: string; description?: string };
export type ConnectionTestResult = { ok: boolean; projectId: string; connection: ProjectConnectionState; server?: { name?: string; version?: string; protocolVersion?: string }; error?: string; authFailed?: true; httpStatus?: number };
export type ListToolsResult = { ok: boolean; projectId: string; connection: ProjectConnectionState; tools: SafeToolInfo[]; allowedTools: string[]; defaultToolPolicy: ToolPermission; toolPolicies: Record<string, ToolPermission>; error?: string };
export type ContractDiscoveryResult = { ok: boolean; available: boolean; schemaTools?: string[]; resources?: string[]; error?: string };
export type DryValidateResult = { ok: boolean; available: boolean; toolName?: string; result?: unknown; error?: string };
export type CallToolResult = { ok: boolean; projectId: string; connection: ProjectConnectionState; tool: string; permission?: ToolPermission; requiresApproval?: boolean; result?: unknown; error?: string; authFailed?: true; httpStatus?: number };

// project.call_tool covers BOTH read-only contract discovery (object_contract, registry_get, ...)
// AND external writes (publishing), and is approval-gated because of the write half — correctly.
// That also blocked the read half, which every content-building node needs on every run: T-2
// (run_1785340011864_qpyjr0) proved the engine works end-to-end in live mode, but
// contract_intelligence could not fetch the platform content_item contract, because
// project.call_tool's requiresApproval:true meant the node runner's effective-tools filter dropped
// it whenever a run carried no approved tool ids. The node correctly refused to fabricate a contract
// rather than proceed on nothing.
//
// This is the fixed, server-side allowlist for the read-only split (project.call_read_tool) — never
// caller-supplied, so a caller cannot widen it by asking for a different tool name. It mirrors the
// boundary the clients already draw themselves: on both Dr. Lurie and Platform these operations are
// "allowed" while every mutating verb is "needs_approval" (see object_contract's publish_policy /
// creation_policy and the live toolPolicies on both project records).
//
// W5 (2026-08-12): the object-substrate names above (object_contract, registry_get, ...) were the
// only entries, so the monetizer project's own read-only tool names (see
// projects/monetizer/definition.ts's MONETIZER_SAFE_READ_ONLY_TOOLS — list_sources, list_connections,
// search_offers, performance, demand_signals, explain_decision) were refused with
// read_tool_operation_not_permitted even when MONETIZER_MCP_ENDPOINT/_TOKEN were configured and the
// project's own toolPolicies allowed them: this gate runs first and named only the object-substrate
// vocabulary. This module stays project-agnostic by NOT importing the monetizer definition — the
// names are added here as plain strings, same as every other entry, so a project-specific constant
// never becomes a dependency of this generic adapter.
export const READ_TOOL_ALLOWLIST = [
  "object_contract", "registry_get", "object_inventory", "object_get", "object_list", "object_validate", "ping",
  "list_sources", "list_connections", "search_offers", "performance", "demand_signals", "explain_decision"
] as const;
export type ReadToolOperation = typeof READ_TOOL_ALLOWLIST[number];
const isReadToolOperation = (name: string): name is ReadToolOperation => (READ_TOOL_ALLOWLIST as readonly string[]).includes(name);

export type ReadToolCallResult = CallToolResult & { code?: "read_tool_operation_not_permitted" };

// Adapter that performs primitive, guarded MCP calls against a project's external server. It never
// executes publishing; it only initializes, lists tools, discovers contract/schema surfaces, and
// performs dry validation when the remote exposes it.
export class ProjectMcpAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport?: McpTransport;
  private readonly secrets: SecretAccessDeps;

  constructor(private readonly config: ProjectConnectionConfig, deps: ProjectAdapterDeps = {}) {
    this.env = deps.env ?? process.env;
    this.transport = deps.transport;
    this.secrets = deps.secrets ?? {};
  }

  connectionState(): ProjectConnectionState {
    return toConnectionState(this.config, this.env);
  }

  private clientOptions(resolved: ResolvedConnection, signal?: AbortSignal): McpClientOptions {
    return { endpoint: resolved.endpoint!, token: resolved.token, transport: this.transport, signal };
  }

  private async requireConnection(): Promise<ResolvedConnection | { error: string }> {
    if (this.config.status === "disabled") return { error: "Project connection is disabled." };
    const resolved = await resolveProjectConnectionWithSecrets(this.config, this.env, this.secrets);
    if (!resolved.endpoint) return { error: `Project MCP endpoint is not configured: neither the ${this.config.mcpEndpointEnvVar} env var on this deployment nor an mcpEndpoint on the project record resolves one (set either — project.update {mcpEndpoint} needs no deploy change).` };
    // A record that NAMES a secret but cannot produce one is a misconfiguration, and saying so here
    // is the whole point: the alternative is a 401 from the tenant several layers later, which reads
    // as "the token is wrong" when the truth is "this plane may not read it".
    if (resolved.tokenError) return { error: `Project MCP token could not be resolved from ${this.config.tokenSecretRef}: ${resolved.tokenError}` };
    return resolved;
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const connection = this.connectionState();
    const resolved = await this.requireConnection();
    if ("error" in resolved) return { ok: false, projectId: this.config.projectId, connection, error: resolved.error };
    try {
      const init = await mcpInitialize(this.clientOptions(resolved, signal));
      return { ok: true, projectId: this.config.projectId, connection, server: { name: init.serverInfo?.name, version: init.serverInfo?.version, protocolVersion: init.protocolVersion } };
    } catch (error) {
      return { ok: false, projectId: this.config.projectId, connection, ...describeFailure(error) };
    }
  }

  async listTools(signal?: AbortSignal): Promise<ListToolsResult> {
    const connection = this.connectionState();
    const allowedTools = [...this.config.allowedTools];
    const defaultToolPolicy = this.config.defaultToolPolicy ?? "blocked";
    const toolPolicies = toToolPolicyMap(this.config);
    const resolved = await this.requireConnection();
    if ("error" in resolved) return { ok: false, projectId: this.config.projectId, connection, tools: [], allowedTools, defaultToolPolicy, toolPolicies, error: resolved.error };
    try {
      const { tools } = await mcpListTools(this.clientOptions(resolved, signal));
      const safe = (tools ?? []).filter((tool) => typeof tool?.name === "string").map((tool) => ({ name: tool.name, description: tool.description }));
      return { ok: true, projectId: this.config.projectId, connection, tools: safe, allowedTools, defaultToolPolicy, toolPolicies };
    } catch (error) {
      return { ok: false, projectId: this.config.projectId, connection, tools: [], allowedTools, defaultToolPolicy, toolPolicies, error: sanitizeError(error) };
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<CallToolResult> {
    const connection = this.connectionState();
    const permission = effectiveToolPermission(this.config, name);
    if (permission === "blocked") {
      return { ok: false, projectId: this.config.projectId, connection, tool: name, permission, error: `Tool is not allowed for project: ${name}` };
    }
    if (permission === "needs_approval") {
      // Held, not forwarded. A human must approve this tool for the project (flip it to "allowed" in
      // the Access page) before the call can run — no transport happens here.
      return { ok: false, projectId: this.config.projectId, connection, tool: name, permission, requiresApproval: true, error: `Tool requires approval before it can run: ${name}` };
    }
    const resolved = await this.requireConnection();
    if ("error" in resolved) return { ok: false, projectId: this.config.projectId, connection, tool: name, permission, error: resolved.error };
    try {
      const result = await mcpCallTool(this.clientOptions(resolved, signal), name, args);
      return { ok: true, projectId: this.config.projectId, connection, tool: name, permission, result };
    } catch (error) {
      return { ok: false, projectId: this.config.projectId, connection, tool: name, permission, ...describeFailure(error) };
    }
  }

  // Read-only counterpart to callTool: no requiresApproval gate, because contract discovery is not a
  // write. The boundary is enforced HERE, first, against the fixed allowlist above — before any
  // transport and before the project's own permission model runs — so a caller cannot reach a
  // mutating verb by calling this method with a different tool name. Once an operation clears the
  // allowlist it goes through callTool completely UNCHANGED: per-project toolPolicies /
  // defaultToolPolicy (a client can still block or hold a read op) and the connection/auth path are
  // honored exactly as they are for a write call. project.call_tool itself is untouched by this
  // method's existence — it stays riskLevel write / requiresApproval true, the only path to an
  // external write.
  async callReadTool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ReadToolCallResult> {
    if (!isReadToolOperation(name)) {
      return {
        ok: false,
        projectId: this.config.projectId,
        connection: this.connectionState(),
        tool: name,
        code: "read_tool_operation_not_permitted",
        error: `"${name}" is not a permitted read-only operation; project.call_read_tool only allows: ${READ_TOOL_ALLOWLIST.join(", ")}. Use project.call_tool for writes.`
      };
    }
    return this.callTool(name, args, signal);
  }

  // Schema/contract discovery, if the remote exposes it: schema/contract-named tools and resources.
  async discoverContract(): Promise<ContractDiscoveryResult> {
    const resolved = await this.requireConnection();
    if ("error" in resolved) return { ok: false, available: false, error: resolved.error };
    try {
      const [toolsResult, resourcesResult] = await Promise.allSettled([
        mcpListTools(this.clientOptions(resolved)),
        mcpListResources(this.clientOptions(resolved))
      ]);
      const schemaTools = toolsResult.status === "fulfilled" ? toolsResult.value.tools.filter((tool) => /schema|contract/i.test(tool.name)).map((tool) => tool.name) : [];
      const resources = resourcesResult.status === "fulfilled" ? resourcesResult.value.resources.map((resource) => resource.uri) : [];
      return { ok: true, available: schemaTools.length > 0 || resources.length > 0, schemaTools, resources };
    } catch (error) {
      return { ok: false, available: false, error: sanitizeError(error) };
    }
  }

  // Dry validation call, if the remote exposes a validate tool. Always sends dryRun: true; never publishes.
  async dryValidate(payload: Record<string, unknown>): Promise<DryValidateResult> {
    const resolved = await this.requireConnection();
    if ("error" in resolved) return { ok: false, available: false, error: resolved.error };
    try {
      const { tools } = await mcpListTools(this.clientOptions(resolved));
      const validateTool = tools.find((tool) => /validate/i.test(tool.name));
      if (!validateTool) return { ok: true, available: false };
      const result = await mcpCallTool(this.clientOptions(resolved), validateTool.name, { ...payload, dryRun: true });
      return { ok: true, available: true, toolName: validateTool.name, result };
    } catch (error) {
      return { ok: false, available: false, error: sanitizeError(error) };
    }
  }
}

export const createProjectAdapter = (config: ProjectConnectionConfig, deps: ProjectAdapterDeps = {}): ProjectMcpAdapter => new ProjectMcpAdapter(config, deps);
