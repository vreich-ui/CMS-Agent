import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createWorkspaceTools, toolError, type WorkspaceTool, type WorkspaceToolContext } from "./tools.js";
import { toolErrorSummary } from "./toolKit.js";
import { canonicalToolName } from "./toolKit.js";
import { repositoryManager } from "../../runtime/repositories.js";
import { clearReadMemo, isMemoizableRead, withReadMemo } from "./readVerbMemo.js";

// Optional catalog scoping for connectors. The full workspace catalog is 100+ tools, which is a
// heavy context load for MCP clients; MCP_EXPOSED_TOOL_PREFIXES (comma-separated namespace list,
// e.g. "workspace,node,project") trims what tools/list advertises AND what tools/call will
// execute. Unset or empty means everything is exposed — existing deployments are unaffected.
// Prefixes match the tool namespace (the segment before the first "." / "_" group), so "node"
// exposes node.* without accidentally exposing nothing or everything.
const exposedToolPrefixes = (env: NodeJS.ProcessEnv = process.env): string[] | null => {
  const raw = (env.MCP_EXPOSED_TOOL_PREFIXES ?? "").trim();
  if (!raw) return null;
  const prefixes = raw.split(",").map((prefix) => prefix.trim().toLowerCase()).filter(Boolean);
  return prefixes.length ? prefixes : null;
};

export const isToolExposed = (dottedName: string, env: NodeJS.ProcessEnv = process.env): boolean => {
  const prefixes = exposedToolPrefixes(env);
  if (!prefixes) return true;
  const namespace = dottedName.split(".")[0].toLowerCase();
  return prefixes.includes(namespace);
};

// Deprecated tool aliases: old names that duplicated another tool one-to-one. Aliases resolve on
// tools/call (both dotted and underscore spellings) but are NOT advertised by tools/list, shrinking
// the catalog without breaking existing callers. An alias is callable when the ALIAS name passes
// the exposure allowlist — the operator scopes by the names callers actually use.
export const DEPRECATED_TOOL_ALIASES: Record<string, string> = {
  "node.list": "workspace.get_nodes",
  "node.get_execution": "node.list_executions",
  "workspace.update_node_schema": "workspace.update_node_output_schema"
};

// Wire-facing tool listing and lookup. tools/list serves ONLY canonical (underscore) names — the
// dotted internal names violate the Anthropic tool-name pattern and made claude.ai reject the
// connector's entire tool list. tools/call resolves the canonical name and, for backward
// compatibility, the legacy dotted spelling. Both listing and lookup honor the exposure allowlist:
// an unexposed tool is neither advertised nor callable (it reads as unknown).
const isAllowedForContext = (tool: WorkspaceTool, context: WorkspaceToolContext): boolean =>
  !context.allowedToolNames || context.allowedToolNames.includes(canonicalToolName(tool.name));

const listedTools = (tools: WorkspaceTool[], context: WorkspaceToolContext) =>
  tools
    .filter((tool) => isToolExposed(tool.name) && isAllowedForContext(tool, context))
    .map((tool) => ({ name: canonicalToolName(tool.name), description: tool.description, inputSchema: tool.inputSchema }));

const indexToolsByName = (tools: WorkspaceTool[], context: WorkspaceToolContext): Map<string, WorkspaceTool> => {
  const all = new Map<string, WorkspaceTool>();
  for (const tool of tools) all.set(tool.name, tool);

  const byName = new Map<string, WorkspaceTool>();
  for (const tool of tools) {
    if (!isToolExposed(tool.name) || !isAllowedForContext(tool, context)) continue;
    byName.set(canonicalToolName(tool.name), tool);
    byName.set(tool.name, tool);
  }
  for (const [alias, target] of Object.entries(DEPRECATED_TOOL_ALIASES)) {
    const tool = all.get(target);
    if (!tool || !isToolExposed(alias) || !isAllowedForContext(tool, context)) continue;
    byName.set(alias, tool);
    byName.set(canonicalToolName(alias), tool);
  }
  return byName;
};

export const MCP_SERVER_NAME = "publishing-workspace-mcp";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "0.1.0";

export function createWorkspaceMcpServer(context: WorkspaceToolContext = {}) {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} } }
  );
  const tools = createWorkspaceTools(context);
  const byName = indexToolsByName(tools, context);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools(tools, context) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    const structuredContent = await tool.execute(request.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  });

  return server;
}

export type HandleMcpOptions = {
  // Protocol version negotiated by the transport for this initialize handshake. Defaults to the
  // server's canonical version so existing stateless callers are unaffected.
  protocolVersion?: string;
  // Session id assigned by the transport, surfaced in the initialize result for clients that read
  // it from the body as well as the Mcp-Session-Id response header.
  sessionId?: string;
};

// One log name for every tool dispatch, so a log-based latency breakdown is a single filter.
export const MCP_TOOL_LOG = "mcp.tool_call";

// On by default — this line is the whole point of W1's observability half, and Cloud Run's request
// log cannot name the verb. Off under vitest and for any caller that sets MCP_TOOL_LOG=off (the
// drift checker dispatches hundreds of tools and wants its own output readable).
const toolLoggingEnabled = (): boolean => (process.env.MCP_TOOL_LOG ?? (process.env.VITEST ? "off" : "on")) !== "off";
const logToolCall = (fields: Record<string, unknown>): void => { if (toolLoggingEnabled()) console.info(MCP_TOOL_LOG, JSON.stringify(fields)); };

export async function handleMcpJsonRpc(message: unknown, context: WorkspaceToolContext = {}, options: HandleMcpOptions = {}) {
  const request = message as { id?: string | number | null; method?: string; params?: Record<string, unknown> };
  const id = request.id ?? null;
  const tools = createWorkspaceTools(context);
  const byName = indexToolsByName(tools, context);

  try {
    switch (request.method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: { protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION, capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: MCP_SERVER_NAME, version: SERVER_VERSION }, ...(options.sessionId ? { sessionId: options.sessionId } : {}), instructions: "Session-aware Netlify Streamable-HTTP MCP endpoint. On initialize the server issues an Mcp-Session-Id header; send it on every subsequent request and DELETE it to end the session. Use tools/list and tools/call to program the workspace. CONTENT PATH NOTICE — This surface is for programming the workspace (agents, nodes, prompts, schemas, tools, projects, evaluations). Content production and publishing for a site are meant to go through that site's ADMIN CHAT (platform admin-agent-chat → client_manager), which owns approval, learning mode and the human record. Calling workflow.* / publish tools here directly is allowed for operators and tests, but if you are acting as an editor or producing content you are probably on the wrong surface." } };
      case "notifications/initialized":
        return { jsonrpc: "2.0", id, result: {} };
      case "ping":
        // Spec: any receiver MUST answer ping promptly. Clients use it as a liveness/keepalive
        // probe; answering "Method not found" reads as a dead server and can drop the connection.
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: listedTools(tools, context) } };
      case "tools/call": {
        const name = String(request.params?.name ?? "");
        const tool = byName.get(name);
        if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        const args = request.params?.arguments ?? {};
        // Anything that is not a known read may have changed what the reads answer. Dropping the
        // memo around it keeps read-after-write honest — see clearReadMemo's own comment.
        if (!isMemoizableRead(name)) clearReadMemo();
        // W1 — one line per dispatch, naming the TOOL and its duration. Cloud Run's request log
        // knows only that something POSTed /mcp, so "which verb is slow" was unanswerable from
        // production telemetry; every latency claim about this service had to be made from a
        // browser's network panel. Never logs arguments or results — those carry tenant content.
        const startedAt = Date.now();
        try {
          const { result, memoized } = await withReadMemo(name, args, context, () => tool.execute(args));
          if (!isMemoizableRead(name)) clearReadMemo();
          const bytes = JSON.stringify(result)?.length ?? 0;
          logToolCall({ tool: name, ms: Date.now() - startedAt, bytes, memoized, ok: true, ...(context.requestId ? { requestId: context.requestId } : {}) });
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } };
        } catch (error) {
          if (!isMemoizableRead(name)) clearReadMemo();
          logToolCall({ tool: name, ms: Date.now() - startedAt, ok: false, ...(context.requestId ? { requestId: context.requestId } : {}) });
          throw error;
        }
      }
      case "prompts/list":
        return { jsonrpc: "2.0", id, result: { prompts: (await repositoryManager.getWorkspaceRepository().getNodes()).map((node) => ({ name: node.id, description: node.name, arguments: [] })) } };
      case "resources/list":
        return { jsonrpc: "2.0", id, result: { resources: [{ uri: "workspace://export", name: "Workspace export", mimeType: "application/json" }] } };
      case "resources/read": {
        const uri = String(request.params?.uri ?? "");
        if (uri !== "workspace://export") return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown resource: ${uri}` } };
        return { jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(await repositoryManager.getWorkspaceRepository().exportWorkspace()) }] } };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
  } catch (error) {
    // R-4: report WHAT failed, not just THAT something did. Every failure used to come back as the
    // same "Tool execution failed" sentence with the real cause in `data`, which MCP clients do not
    // show — so a correct, deliberate refusal (default_project_protected, version_conflict) was
    // indistinguishable from a crash. The structured envelope still travels in `data`; the message
    // now leads with the machine-readable code.
    const envelope = toolError(error);
    return { jsonrpc: "2.0", id, error: { code: -32603, message: toolErrorSummary(envelope), data: envelope } };
  }
}
