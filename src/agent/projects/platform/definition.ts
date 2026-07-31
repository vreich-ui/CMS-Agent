import type { ProjectConnectionConfig, ProjectObjectDialect } from "../projectTypes.js";

// Platform (client 0) external project MCP connection. The endpoint and token are provided via
// environment variables (PLATFORM_MCP_ENDPOINT, PLATFORM_MCP_TOKEN) and are never persisted.
//
// Unlike dr-lurie/pdf-tool/monetizer, platform was never seeded here — it was registered live via
// project.create (CHANGE-PLAN W-1) and, being absent from defaultProjectConnections, never once
// passed through migrateDefaultProjectConfig: a project not in this list is a guaranteed no-op for
// that function (defaultProjectsById.get returns undefined), so platform is the one active project a
// code-defined config bump can never reach. That is precisely how it went a full definitionVersion
// behind dr-lurie on the object-dialect parameters — a defect in itself, fixed by this file existing
// at all (see defaultProjects.ts).
//
// The full config below (name, tool policies, contentContract, status) is a faithful mirror of
// platform's live record (captured via project.get 2026-07-30) — deliberately NOT a fresh/smaller
// policy — so this first migration is additive only (the new objectDialect below) and changes
// nothing else about the live-tuned tool permissions.
export const PLATFORM_DEFAULT_TOOL_POLICY = "allowed" as const;
export const PLATFORM_TOOL_POLICIES: ProjectConnectionConfig["toolPolicies"] = {
  ping: "allowed",
  registry_get: "allowed",
  object_contract: "allowed",
  object_inventory: "allowed",
  object_get: "allowed",
  object_list: "allowed",
  object_validate: "allowed",
  deploy_status: "allowed",
  trigger_netlify_build: "allowed",
  get_pdf_tool_storage_grant: "allowed",
  create_artifact_from_url: "allowed",
  create_artifact_upload_intent: "allowed",
  save_artifact: "allowed",
  get_artifact_metadata: "allowed",
  search_artifacts: "allowed",
  list_artifacts_for_request: "allowed",
  list_artifacts_by_request: "allowed",
  list_artifacts_by_kind: "allowed",
  restore_artifact: "allowed",
  soft_delete_artifact: "allowed",
  object_checkout: "allowed",
  object_checkin: "allowed",
  object_refresh_lock: "allowed",
  object_patch: "allowed",
  object_create: "allowed",
  object_discard: "allowed",
  object_create_variant: "allowed",
  object_submit_review: "allowed",
  object_publish: "allowed",
  release_to_production: "allowed",
  object_retire: "needs_approval",
  object_review_decide: "needs_approval",
  site_apply_theme: "needs_approval",
  object_instantiate_template: "needs_approval",
  object_instantiate_section_template: "needs_approval",
  wipe_blob_stores: "needs_approval"
};

// Per-site parameters of the object-native publish dialect (see ProjectObjectDialect). Sourced from
// the live incident evidence (run_1785405350649_9u5mjz): project_get(platform).knowledge names
// tax_platform as the taxonomy registry and content_item as the article object type; the requestId
// req_article_kugel_lifecycle_20260730_01 that same run produced matches the shared
// req_<flow>_<topic>_<yyyymmdd>_<nn> convention dr-lurie also declares.
export const PLATFORM_OBJECT_DIALECT: ProjectObjectDialect = {
  // The owning site object id, passed as `site` on object_create.
  siteObjectId: "site_platform",
  // Taxonomy category/tags resolve against this registry; unknown terms are write blockers.
  taxonomyRegistryObjectId: "tax_platform",
  // Unlike dr-lurie (caller-supplied request id IS the object id), platform mints its own object ids
  // server-side on object_create and the request id stays run-correlation only.
  objectIdSource: "server_minted",
  // req_<flow>_<topic>_<yyyymmdd>_<nn>, lowercase snake_case — same shape as dr-lurie's, confirmed by
  // req_article_kugel_lifecycle_20260730_01 in the live T-2 re-run.
  requestIdPattern: "^req_[a-z0-9_]+_\\d{8}_\\d{2}$",
  // F1 (T-2, run_1785352838155_l544ye / run_1785405350649_9u5mjz): object_contract's object_type
  // argument for this client's governed article type. Absent until now, which is exactly what made
  // F1's conductor-level prefetch silently no-op for platform (see contractPrefetch.ts's
  // prefetch_object_type_unresolved) and pushed contract_intelligence's own cost UP ($2.57 -> $3.79)
  // instead of down.
  defaultObjectType: "content_item"
};

// Version 1 was platform's FIRST definitionVersion, not a bump — the project had never been seeded
// here before; any live record with no definitionVersion (undefined) re-seeded once that shipped,
// which was safe because the rest of this config is a faithful mirror of that same live record (see
// header). Bumped 1 -> 2 when R-23 removed contentContract.canonicalArticleBody (every definition
// declared the identical value; the article_body node's own produces const is the single source) so
// persisted stale configs re-seed without it.
export const PLATFORM_DEFINITION_VERSION = 2;

export const platformProjectConfig: ProjectConnectionConfig = {
  projectId: "platform",
  definitionVersion: PLATFORM_DEFINITION_VERSION,
  name: "Platform",
  mcpEndpointEnvVar: "PLATFORM_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "PLATFORM_MCP_TOKEN",
  allowedTools: [],
  defaultToolPolicy: PLATFORM_DEFAULT_TOOL_POLICY,
  toolPolicies: { ...PLATFORM_TOOL_POLICIES },
  contentContract: {
    contentContract: "content_source.v1"
  },
  objectDialect: { ...PLATFORM_OBJECT_DIALECT },
  publishingPolicy: {
    publishEnabled: false,
    requiresExplicitPublish: true,
    description: "Publishing is disabled. Enable only behind a future explicit PUBLISH approval gate."
  },
  status: "active"
};

// The default-projects seed list lives in ../defaultProjects.ts — this module defines ONLY the
// platform connection so the workspace core never has to import from a client-specific folder.
