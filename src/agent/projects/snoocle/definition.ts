import type { ProjectConnectionConfig } from "../projectTypes.js";

// Snoocle external MCP connection. Audio-to-song-data foundry with Firestore-backed, content-versioned
// persistence. The endpoint and token are provided via environment variables (SNOOCLE_MCP_ENDPOINT,
// SNOOCLE_MCP_TOKEN) and are never persisted. Only safe, read-only inspection tools are allow-listed;
// acquisition, analysis-and-store, save, reconcile, and the destructive audio utilities stay off until
// explicitly allowed.
export const SNOOCLE_SAFE_READ_ONLY_TOOLS = [
  "server_status",
  "list_songs",
  "get_song",
  "get_song_schema",
  "list_song_versions",
  "diff_song_versions",
  "probe_audio"
] as const;
export const SNOOCLE_DEFINITION_VERSION = 1;

export const snoocleProjectConfig: ProjectConnectionConfig = {
  projectId: "snoocle",
  definitionVersion: SNOOCLE_DEFINITION_VERSION,
  name: "Snoocle",
  mcpEndpointEnvVar: "SNOOCLE_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "SNOOCLE_MCP_TOKEN",
  allowedTools: [...SNOOCLE_SAFE_READ_ONLY_TOOLS],
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
