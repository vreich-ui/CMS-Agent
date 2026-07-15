import type { ProjectConnectionConfig } from "../projectTypes.js";

// Monetizer external MCP connection. Affiliate/monetization intelligence across networks (offers,
// demand signals, performance, decisioning). The endpoint and token are provided via environment
// variables (MONETIZER_MCP_ENDPOINT, MONETIZER_MCP_TOKEN) and are never persisted. Only safe,
// read-only tools are allow-listed; tenant/connection/credential registration, ingest, pauses,
// collection runs, and rebuild triggers stay off until explicitly allowed.
export const MONETIZER_SAFE_READ_ONLY_TOOLS = [
  "list_sources",
  "list_connections",
  "search_offers",
  "performance",
  "demand_signals",
  "explain_decision"
] as const;
export const MONETIZER_DEFINITION_VERSION = 1;

export const monetizerProjectConfig: ProjectConnectionConfig = {
  projectId: "monetizer",
  definitionVersion: MONETIZER_DEFINITION_VERSION,
  name: "Monetizer",
  mcpEndpointEnvVar: "MONETIZER_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "MONETIZER_MCP_TOKEN",
  allowedTools: [...MONETIZER_SAFE_READ_ONLY_TOOLS],
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
