import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createWorkspaceTools, toolError, type WorkspaceTool, type WorkspaceToolContext } from "./tools.js";
import { canonicalToolName } from "./toolKit.js";
import { repositoryManager } from "../../runtime/repositories.js";

// Wire-facing tool listing and lookup. tools/list serves ONLY canonical (underscore) names — the
// dotted internal names violate the Anthropic tool-name pattern and made claude.ai reject the
// connector's entire tool list. tools/call resolves the canonical name and, for backward
// compatibility, the legacy dotted spelling.
const listedTools = (tools: WorkspaceTool[]) =>
  tools.map((tool) => ({ name: canonicalToolName(tool.name), description: tool.description, inputSchema: tool.inputSchema }));

const indexToolsByName = (tools: WorkspaceTool[]): Map<string, WorkspaceTool> => {
  const byName = new Map<string, WorkspaceTool>();
  for (const tool of tools) {
    byName.set(canonicalToolName(tool.name), tool);
    byName.set(tool.name, tool);
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
  const byName = indexToolsByName(tools);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools(tools) }));

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

export async function handleMcpJsonRpc(message: unknown, context: WorkspaceToolContext = {}, options: HandleMcpOptions = {}) {
  const request = message as { id?: string | number | null; method?: string; params?: Record<string, unknown> };
  const id = request.id ?? null;
  const tools = createWorkspaceTools(context);
  const byName = indexToolsByName(tools);

  try {
    switch (request.method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: { protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION, capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: MCP_SERVER_NAME, version: SERVER_VERSION }, ...(options.sessionId ? { sessionId: options.sessionId } : {}), instructions: "Session-aware Netlify Streamable-HTTP MCP endpoint. On initialize the server issues an Mcp-Session-Id header; send it on every subsequent request and DELETE it to end the session. Use tools/list and tools/call to program the workspace." } };
      case "notifications/initialized":
        return { jsonrpc: "2.0", id, result: {} };
      case "ping":
        // Spec: any receiver MUST answer ping promptly. Clients use it as a liveness/keepalive
        // probe; answering "Method not found" reads as a dead server and can drop the connection.
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: listedTools(tools) } };
      case "tools/call": {
        const name = String(request.params?.name ?? "");
        const tool = byName.get(name);
        if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        const result = await tool.execute(request.params?.arguments ?? {});
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } };
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
    return { jsonrpc: "2.0", id, error: { code: -32603, message: "Tool execution failed", data: toolError(error) } };
  }
}
