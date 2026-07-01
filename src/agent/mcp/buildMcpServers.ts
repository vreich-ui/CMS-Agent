import type { McpServerConfig, ProjectProfile } from "../runtime/types.js";

export type RuntimeMcpServer = McpServerConfig & { url: string; authorization?: string };

export function buildMcpServers(project: ProjectProfile): RuntimeMcpServer[] {
  return project.mcpServers
    .map((server) => ({
      ...server,
      url: process.env[server.urlEnv] ?? "",
      authorization: server.authorizationEnv ? process.env[server.authorizationEnv] : undefined
    }))
    .filter((server) => server.url.length > 0);
}
