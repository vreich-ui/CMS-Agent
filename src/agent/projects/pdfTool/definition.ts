import type { ProjectConnectionConfig } from "../projectTypes.js";

// PDF-Tool external MCP connection. Server-side artifact generation (images, PDFs, pdfme templates,
// image search/import). The endpoint and token are provided via environment variables
// (PDF_TOOL_MCP_ENDPOINT, PDF_TOOL_MCP_TOKEN) and are never persisted. Only safe, read-only tools are
// allow-listed; artifact/template/image mutations and publishes stay off until explicitly allowed.
export const PDF_TOOL_SAFE_READ_ONLY_TOOLS = [
  "list_pdf_templates",
  "get_pdf_template",
  "get_agent_artifact_job_status",
  "get_agent_artifact_by_filename",
  "get_agent_artifact_by_slot",
  "get_image_search_policy",
  "get_image_search_bank",
  "get_image_search_job_status"
] as const;
// Bumped 1 -> 2 when R-23 removed contentContract.canonicalArticleBody (every definition declared
// the identical value; the article_body node's own produces const is the single source) so persisted
// stale configs re-seed without it.
export const PDF_TOOL_DEFINITION_VERSION = 3;

export const pdfToolProjectConfig: ProjectConnectionConfig = {
  projectId: "pdf-tool",
  definitionVersion: PDF_TOOL_DEFINITION_VERSION,
  name: "PDF Tool",
  mcpEndpointEnvVar: "PDF_TOOL_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "PDF_TOOL_MCP_TOKEN",
  allowedTools: [...PDF_TOOL_SAFE_READ_ONLY_TOOLS],
  contentContract: {
    contentContract: "content_source.v1"
  },
  publishingPolicy: {
    publishEnabled: true,
    requiresExplicitPublish: false,
    description: "Publishing is enabled (go-live 2026-07-31, operator decision). Set the per-project *_PUBLISH_ENABLED=false env flag to force publishing off."
  },
  status: "active"
};
