import type { ProjectConnectionConfig, ProjectConnectionState } from "../projectTypes.js";
import { McpClientError, mcpCallTool, mcpInitialize, mcpListResources, mcpListTools, type McpClientOptions, type McpTransport } from "../mcpClient.js";

// Resolve the MCP endpoint and bearer token from environment variables. Values are used only to make
// requests and are never persisted, returned to callers, or logged.
export type ResolvedConnection = { endpointConfigured: boolean; tokenConfigured: boolean; endpoint?: string; token?: string };

export function resolveProjectConnection(config: ProjectConnectionConfig, env: NodeJS.ProcessEnv = process.env): ResolvedConnection {
  const endpoint = env[config.mcpEndpointEnvVar]?.trim() || undefined;
  const token = config.tokenEnvVar ? (env[config.tokenEnvVar]?.trim() || undefined) : undefined;
  return { endpointConfigured: Boolean(endpoint), tokenConfigured: Boolean(token), endpoint, token };
}

// Safe, caller-facing connection view: booleans plus env var names only — never the endpoint value or token.
export function toConnectionState(config: ProjectConnectionConfig, env: NodeJS.ProcessEnv = process.env): ProjectConnectionState {
  const resolved = resolveProjectConnection(config, env);
  return { endpointConfigured: resolved.endpointConfigured, tokenConfigured: resolved.tokenConfigured, mcpEndpointEnvVar: config.mcpEndpointEnvVar, tokenEnvVar: config.tokenEnvVar };
}

// McpClientError messages are our own safe constants; any other error (network/DNS/URL) is collapsed
// to a generic message so an endpoint that embeds credentials can never leak through an error string.
const sanitizeError = (error: unknown): string =>
  error instanceof McpClientError ? error.message : "Failed to reach the project MCP endpoint.";

export type ProjectAdapterDeps = { env?: NodeJS.ProcessEnv; transport?: McpTransport };
export type SafeToolInfo = { name: string; description?: string };
export type ConnectionTestResult = { ok: boolean; projectId: string; connection: ProjectConnectionState; server?: { name?: string; version?: string; protocolVersion?: string }; error?: string };
export type ListToolsResult = { ok: boolean; projectId: string; connection: ProjectConnectionState; tools: SafeToolInfo[]; allowedTools: string[]; error?: string };
export type ContractDiscoveryResult = { ok: boolean; available: boolean; schemaTools?: string[]; resources?: string[]; error?: string };
export type DryValidateResult = { ok: boolean; available: boolean; toolName?: string; result?: unknown; error?: string };
export type CallToolResult = { ok: boolean; projectId: string; connection: ProjectConnectionState; tool: string; result?: unknown; error?: string };

// Adapter that performs primitive, guarded MCP calls against a project's external server. It never
// executes publishing; it only initializes, lists tools, discovers contract/schema surfaces, and
// performs dry validation when the remote exposes it.
export class ProjectMcpAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport?: McpTransport;

  constructor(private readonly config: ProjectConnectionConfig, deps: ProjectAdapterDeps = {}) {
    this.env = deps.env ?? process.env;
    this.transport = deps.transport;
  }

  connectionState(): ProjectConnectionState {
    return toConnectionState(this.config, this.env);
  }

  private clientOptions(resolved: ResolvedConnection): McpClientOptions {
    return { endpoint: resolved.endpoint!, token: resolved.token, transport: this.transport };
  }

  private requireConnection(): ResolvedConnection | { error: string } {
    if (this.config.status === "disabled") return { error: "Project connection is disabled." };
    const resolved = resolveProjectConnection(this.config, this.env);
    if (!resolved.endpoint) return { error: `Project MCP endpoint is not configured (${this.config.mcpEndpointEnvVar}).` };
    return resolved;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const connection = this.connectionState();
    const resolved = this.requireConnection();
    if ("error" in resolved) return { ok: false, projectId: this.config.projectId, connection, error: resolved.error };
    try {
      const init = await mcpInitialize(this.clientOptions(resolved));
      return { ok: true, projectId: this.config.projectId, connection, server: { name: init.serverInfo?.name, version: init.serverInfo?.version, protocolVersion: init.protocolVersion } };
    } catch (error) {
      return { ok: false, projectId: this.config.projectId, connection, error: sanitizeError(error) };
    }
  }

  async listTools(): Promise<ListToolsResult> {
    const connection = this.connectionState();
    const allowedTools = [...this.config.allowedTools];
    const resolved = this.requireConnection();
    if ("error" in resolved) return { ok: false, projectId: this.config.projectId, connection, tools: [], allowedTools, error: resolved.error };
    try {
      const { tools } = await mcpListTools(this.clientOptions(resolved));
      const safe = (tools ?? []).filter((tool) => typeof tool?.name === "string").map((tool) => ({ name: tool.name, description: tool.description }));
      return { ok: true, projectId: this.config.projectId, connection, tools: safe, allowedTools };
    } catch (error) {
      return { ok: false, projectId: this.config.projectId, connection, tools: [], allowedTools, error: sanitizeError(error) };
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const connection = this.connectionState();
    if (!this.config.allowedTools.includes(name)) {
      return { ok: false, projectId: this.config.projectId, connection, tool: name, error: `Tool is not allowed for project: ${name}` };
    }
    const resolved = this.requireConnection();
    if ("error" in resolved) return { ok: false, projectId: this.config.projectId, connection, tool: name, error: resolved.error };
    try {
      const result = await mcpCallTool(this.clientOptions(resolved), name, args);
      return { ok: true, projectId: this.config.projectId, connection, tool: name, result };
    } catch (error) {
      return { ok: false, projectId: this.config.projectId, connection, tool: name, error: sanitizeError(error) };
    }
  }

  // Schema/contract discovery, if the remote exposes it: schema/contract-named tools and resources.
  async discoverContract(): Promise<ContractDiscoveryResult> {
    const resolved = this.requireConnection();
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
    const resolved = this.requireConnection();
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
