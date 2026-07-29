import { effectiveToolPermission, type ProjectConnectionConfig, type ProjectObjectDialect, type ToolPermission } from "../projectTypes.js";

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

// The RETIRED legacy dialect. Dr. Lurie's pre-object-model pipeline — the save_json_blob_* article
// verbs and the five-agent per-stage output tools — is frozen: zero new writes, its markdown post
// collection was wiped, and the ratified alignment doc (vreich-ui/platform,
// docs/agents/cms-agent-contract-alignment.md) states plainly that save_json_blob_* is NOT to be
// allowlisted for the dr-lurie project.
//
// This client runs with defaultToolPolicy "allowed", so silence would mean ALLOWED: removing these
// names from the config is expressed as an explicit "blocked" entry, the highest-precedence rule in
// effectiveToolPermission. executablePolicy.ts blocks the same families by pattern at call_tool
// time, so a legacy verb this list does not happen to name is still refused.
export const DR_LURIE_RETIRED_PUBLISH_DIALECT_TOOLS = [
  "save_json_blob_create_request",
  "save_json_blob_create_article_draft",
  "save_json_blob_checkout_request",
  "save_json_blob_patch_canonical_input",
  "save_json_blob_publish_by_time",
  "save_json_blob_checkin_request"
] as const;

// The five-agent pipeline's per-stage output tools, whose markdown terminus is a dead end.
export const DR_LURIE_RETIRED_STAGE_TOOLS = [
  "reader_insight_update_output",
  "reader_insight_mark_complete",
  "research_update_output",
  "research_mark_complete",
  "angle_update_output",
  "angle_mark_complete",
  "draft_update_output",
  "draft_mark_complete",
  "final_article_update_output",
  "final_article_mark_complete"
] as const;

export const DR_LURIE_RETIRED_LEGACY_TOOLS = [...DR_LURIE_RETIRED_PUBLISH_DIALECT_TOOLS, ...DR_LURIE_RETIRED_STAGE_TOOLS] as const;

// Full access, with two carve-outs:
//   - wipe_blob_stores irreversibly destroys ALL blob stores and is not a publishing operation, so
//     it defaults to "needs approval" rather than auto-running;
//   - every retired legacy-dialect tool is hard-blocked (above).
// An operator can tighten anything else from the Access page.
export const DR_LURIE_DEFAULT_TOOL_POLICY: ToolPermission = "allowed";
export const DR_LURIE_TOOL_POLICIES: Record<string, ToolPermission> = {
  wipe_blob_stores: "needs_approval",
  ...Object.fromEntries(DR_LURIE_RETIRED_LEGACY_TOOLS.map((tool) => [tool, "blocked" as ToolPermission]))
};

// Per-site parameters of the object-native publish dialect (see ProjectObjectDialect). These are
// configuration precisely so the publish hook carries no site-specific literals.
export const DR_LURIE_OBJECT_DIALECT: ProjectObjectDialect = {
  // The owning site object id, passed as `site` on object_create — object_contract(content_item)
  // lists it under auxiliary_inputs. Confirm against object_list {object_type:"site"} on this
  // client's server during enablement; publishing is gated off until an operator does.
  siteObjectId: "site_drlurie",
  // Taxonomy category/tags resolve against this registry; unknown terms are write blockers. The
  // registry is a curated, agent-editable vocabulary — extend it rather than dropping a term.
  taxonomyRegistryObjectId: "tax_drlurie",
  // Unlike platform (server-minted ids), this client's content_item KEEPS the article request-id
  // shape as its object id, so the caller-supplied request id is sent as requested_id on create.
  objectIdSource: "request_id",
  // req_<flow>_<topic>_<yyyymmdd>_<nn>, lowercase snake_case, caller-supplied and never generated.
  // A malformed id is accepted at create but hard-400s every later artifact operation with no
  // recovery, which is why the publisher rejects it before the first call.
  requestIdPattern: "^req_[a-z0-9_]+_\\d{8}_\\d{2}$"
};

// Bumped 3 -> 4 when Dr. Lurie moved to full access (defaultToolPolicy "allowed"), and 4 -> 5 when
// the legacy save_json_blob_*/per-stage dialect was retired and the object-dialect parameters were
// added, so persisted stale configs re-seed from this definition (see defaultMigration.ts).
export const DR_LURIE_DEFINITION_VERSION = 5;

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
  objectDialect: { ...DR_LURIE_OBJECT_DIALECT },
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
