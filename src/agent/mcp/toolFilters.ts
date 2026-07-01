import type { McpServerConfig } from "../runtime/types.js";

export function isToolAllowed(toolName: string, server: McpServerConfig): boolean {
  if (server.blockedTools?.includes(toolName)) return false;
  if (server.allowedTools?.length) return server.allowedTools.includes(toolName);
  return true;
}
