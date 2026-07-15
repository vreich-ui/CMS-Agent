import { effectiveToolPermission, type ProjectConnectionConfig, type ToolPermission } from "../projectTypes.js";

// Dr. Lurie external project MCP connection. The endpoint and token are provided via environment
// variables (DR_LURIE_MCP_ENDPOINT, DR_LURIE_MCP_TOKEN) and are never persisted.
//
// Dr. Lurie is a publishing house whose CMS-Agent is the full writer + reviewer and orders artifacts,
// so this connection runs with FULL access: defaultToolPolicy "allowed" means every Dr. Lurie tool —
// including publish/deploy and commerce — is callable via project.call_tool. The three-state Access
// page (allowed / needs approval / blocked) is how an operator narrows this per tool.
export const DR_LURIE_SAFE_READ_ONLY_TOOLS = ["ping", "registry_get", "object_inventory", "object_contract"] as const;

// Artifact + PDF capability, brokered BY Dr. Lurie (this is how CMS-Agent reaches "PDF-Tool": through
// Dr. Lurie's server, not a direct connection): obtain a short-lived pdf-tool storage grant,
// create/upload/store artifacts (PDFs, images), and read/search/manage the artifact index.
export const DR_LURIE_ARTIFACT_TOOLS = [
  "get_pdf_tool_storage_grant",
  "create_artifact_from_url",
  "create_artifact_upload_intent",
  "save_artifact",
  "get_artifact_metadata",
  "search_artifacts",
  "list_artifacts_for_request",
  "list_artifacts_by_request",
  "list_artifacts_by_kind",
  "restore_artifact",
  "soft_delete_artifact",
  "verify_article_images",
  "migrate_artifact_indexes",
  "reconcile_artifact_indexes"
] as const;

export const DR_LURIE_ALLOWED_TOOLS = [...DR_LURIE_SAFE_READ_ONLY_TOOLS, ...DR_LURIE_ARTIFACT_TOOLS] as const;

// Full access, with one safety valve: wipe_blob_stores irreversibly destroys ALL blob stores and is
// not a publishing operation, so it defaults to "needs approval" rather than auto-running. An
// operator can flip it to "allowed" (or tighten anything else) from the Access page.
export const DR_LURIE_DEFAULT_TOOL_POLICY: ToolPermission = "allowed";
export const DR_LURIE_TOOL_POLICIES: Record<string, ToolPermission> = {
  wipe_blob_stores: "needs_approval"
};

// Bumped 3 -> 4 when Dr. Lurie moved to full access (defaultToolPolicy "allowed"), so persisted stale
// configs re-seed from this definition (see defaultMigration.ts).
export const DR_LURIE_DEFINITION_VERSION = 4;

export const drLurieProjectConfig: ProjectConnectionConfig = {
  projectId: "dr-lurie",
  definitionVersion: DR_LURIE_DEFINITION_VERSION,
  name: "Dr. Lurie",
  mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "DR_LURIE_MCP_TOKEN",
  allowedTools: [...DR_LURIE_ALLOWED_TOOLS],
  defaultToolPolicy: DR_LURIE_DEFAULT_TOOL_POLICY,
  toolPolicies: { ...DR_LURIE_TOOL_POLICIES },
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

// Convenience: the effective permission for a Dr. Lurie tool under the current config.
export const drLurieToolPermission = (toolName: string): ToolPermission => effectiveToolPermission(drLurieProjectConfig, toolName);

// The default-projects seed list lives in ../defaultProjects.ts — this module defines ONLY the
// Dr. Lurie connection so the workspace core never has to import from a client-specific folder.
