import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createWorkspaceTools, toolError } from "./tools.js";
import { workspaceStore, type WorkspaceStore } from "./store.js";

export const MCP_SERVER_NAME = "publishing-workspace-mcp";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "0.1.0";

export function createWorkspaceMcpServer(store: WorkspaceStore = workspaceStore) {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} } }
  );
  const tools = createWorkspaceTools(store);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    const structuredContent = await tool.execute(request.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  });

  return server;
}

export async function handleMcpJsonRpc(message: unknown, store: WorkspaceStore = workspaceStore) {
  const request = message as { id?: string | number | null; method?: string; params?: Record<string, unknown> };
  const id = request.id ?? null;
  const tools = createWorkspaceTools(store);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  try {
    switch (request.method) {
      case "initialize":
        createWorkspaceMcpServer(store);
        return { jsonrpc: "2.0", id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: MCP_SERVER_NAME, version: SERVER_VERSION }, instructions: "Stateless Netlify JSON-RPC MCP endpoint. Use tools/list and tools/call." } };
      case "notifications/initialized":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } };
      case "tools/call": {
        const name = String(request.params?.name ?? "");
        const tool = byName.get(name);
        if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        const result = await tool.execute(request.params?.arguments ?? {});
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } };
      }
      case "prompts/list":
        return { jsonrpc: "2.0", id, result: { prompts: (await store.getNodes()).map((node) => ({ name: node.id, description: node.name, arguments: [] })) } };
      case "resources/list":
        return { jsonrpc: "2.0", id, result: { resources: [{ uri: "workspace://export", name: "Workspace export", mimeType: "application/json" }] } };
      case "resources/read": {
        const uri = String(request.params?.uri ?? "");
        if (uri !== "workspace://export") return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown resource: ${uri}` } };
        return { jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(await store.exportWorkspace()) }] } };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
  } catch (error) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: "Tool execution failed", data: toolError(error) } };
  }
}
