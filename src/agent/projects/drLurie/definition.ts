import type { ProjectConnectionConfig } from "../projectTypes.js";

// Dr. Lurie external project MCP connection. The endpoint and token are provided via environment
// variables (DR_LURIE_MCP_ENDPOINT, DR_LURIE_MCP_TOKEN) and are never persisted. Publishing stays
// disabled until a future explicit PUBLISH gate is implemented.
export const DR_LURIE_SAFE_READ_ONLY_TOOLS = ["ping", "registry_get", "object_inventory", "object_contract"] as const;
export const DR_LURIE_DEFINITION_VERSION = 2;

export const drLurieProjectConfig: ProjectConnectionConfig = {
  projectId: "dr-lurie",
  definitionVersion: DR_LURIE_DEFINITION_VERSION,
  name: "Dr. Lurie",
  mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "DR_LURIE_MCP_TOKEN",
  allowedTools: [...DR_LURIE_SAFE_READ_ONLY_TOOLS],
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

// The default-projects seed list lives in ../defaultProjects.ts — this module defines ONLY the
// Dr. Lurie connection so the workspace core never has to import from a client-specific folder.
