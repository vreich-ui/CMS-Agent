import type { McpServerConfig, ProjectProfile } from "../runtime/types.js";

export type RuntimeMcpServer = McpServerConfig & { url: string };

export function buildMcpServers(project: ProjectProfile): RuntimeMcpServer[] {
  return project.mcpServers
    .map((server) => ({
      ...server,
      url: server.url ?? ""
    }))
    .filter((server) => server.url.length > 0);
}
