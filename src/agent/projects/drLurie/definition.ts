import type { ProjectConnectionConfig } from "../projectTypes.js";

// Dr. Lurie external project MCP connection. The endpoint and token are provided via environment
// variables (DR_LURIE_MCP_ENDPOINT, DR_LURIE_MCP_TOKEN) and are never persisted. Publishing stays
// disabled until a future explicit PUBLISH gate is implemented.
export const DR_LURIE_SAFE_READ_ONLY_TOOLS = ["ping", "registry_get", "object_inventory", "object_contract"] as const;

// Artifact + PDF capability, brokered BY Dr. Lurie (this is how CMS-Agent reaches "PDF-Tool": through
// Dr. Lurie's server, not a direct connection). These let an agent obtain a short-lived pdf-tool
// storage grant, create/upload/store artifacts (PDFs, images), and read/search/manage the artifact
// index. They mutate artifact storage but do NOT publish. Deliberately excluded and still blocked by
// deny-all — they only leave the allowlist behind a future explicit PUBLISH gate:
//   • publish/deploy: object_publish, release_to_production, save_json_blob_publish_by_time,
//     trigger_netlify_build, site_apply_theme
//   • commerce:       product_set_price, commerce_orders, order_reissue
//   • destructive:    wipe_blob_stores
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
// Bumped 2 -> 3 when the artifact/PDF tools were added to the allowlist, so persisted stale configs
// re-seed from this definition (see defaultMigration.ts).
export const DR_LURIE_DEFINITION_VERSION = 3;

export const drLurieProjectConfig: ProjectConnectionConfig = {
  projectId: "dr-lurie",
  definitionVersion: DR_LURIE_DEFINITION_VERSION,
  name: "Dr. Lurie",
  mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "DR_LURIE_MCP_TOKEN",
  allowedTools: [...DR_LURIE_ALLOWED_TOOLS],
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
