import type { ProjectConnectionConfig } from "../projectTypes.js";

// Dr. Lurie external project MCP connection. The endpoint and token are provided via environment
// variables (DR_LURIE_MCP_ENDPOINT, DR_LURIE_MCP_TOKEN) and are never persisted. Publishing stays
// disabled until a future explicit PUBLISH gate is implemented.
export const drLurieProjectConfig: ProjectConnectionConfig = {
  projectId: "dr-lurie",
  name: "Dr. Lurie",
  mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "DR_LURIE_MCP_TOKEN",
  allowedTools: ["initialize", "tools/list"],
  contentContract: {
    contentContract: "content_source.v1",
    canonicalArticleBody: "article_body.v1"
  },
  publishingPolicy: {
    publishEnabled: false,
    requiresExplicitPublish: true,
    description: "Publishing is disabled. Enable only behind a future explicit PUBLISH approval gate."
  },
  status: "active"
};

// Code-defined default project connections. Repositories seed themselves from this list, so the
// persisted registry (memory/blobs) always contains at least the known projects without hardcoding
// them at the tool/runtime layer.
export const defaultProjectConnections: ProjectConnectionConfig[] = [drLurieProjectConfig];
