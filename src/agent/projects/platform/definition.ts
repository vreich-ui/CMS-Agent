import type { ProjectCapturePolicy, ProjectConnectionConfig, ProjectObjectDialect } from "../projectTypes.js";

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
  // C1 (BRIEF §3.7): sitePrefetch.ts's PDF-template and image-model-policy reads — pure reads, same
  // "allowed" tier as the object_* rows above. Declarative only: defaultToolPolicy "allowed" already
  // covered both, this is what the Access page shows as this project's declared surface.
  list_pdf_templates: "allowed",
  get_image_model_policy: "allowed",
  deploy_status: "allowed",
  trigger_netlify_build: "allowed",
  // FLAGGED, NOT CHANGED (T12.13, 2026-08-17): this row is STALE POLICY, not a capability. Platform
  // core DELETED the `get_pdf_tool_storage_grant` RPC on 2026-08-02 (commit 7d1640ce) and replaced it
  // with a server-side artifact bridge that mints the grant internally and never returns it —
  // `grep -rn get_pdf_tool_storage_grant packages/core/server/` in the platform repo returns nothing.
  // Allow-listing a tool no deployment implements only makes a caller's failure look like a permission
  // question. Nothing reads it any more: capture stopped needing a grant entirely under Wolf's
  // 2026-08-14 "option A" ruling. Retiring the row is a policy edit (definitionVersion bump + re-seed
  // of the live record), which this task deliberately does not do from code — see the T12.13 brief's
  // "precise asks".
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
  // REVIEW (BRIEF §3.3/R6) — the brand-imagery wave's privileged apply verb, declared with the SAME
  // posture as its own stated recipe one row above. It was left undeclared, and this project's
  // defaultToolPolicy is "allowed", so effectiveToolPermission(config, "site_apply_brand_imagery")
  // answered "allowed" — which is exactly the answer visual_standard_materializer's second gate
  // (visualStandardMaterialization.ts) tests for before it runs the verb's dry run and then the
  // apply. Both of that node's "two independent gates" would therefore have reduced to one — the
  // run's own `apply: true` — and a visual_identity run could put a freshly written look on the live
  // site with no approval anywhere. §3.3 says the opposite in as many words: "agents per project
  // policy (needs_approval default on platform)". A row, not a code change: the gate itself was
  // right, the policy it reads was silent.
  site_apply_brand_imagery: "needs_approval",
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
export const PLATFORM_CAPTURE_POLICY: ProjectCapturePolicy = {
  maxPages: 20,
  allowedCrawlOrigins: ["https://www.zilbermanfilmfoundation.com"],
  allowedPathPrefixes: ["/"],
  sameOriginOnly: true,
  respectRobots: true,
  concurrency: 1,
  delayMs: 1500,
  authenticatedAccess: "prohibited",
  rights: { content: "retain_allowed_origin_content", media: "retain_referenced_allowed_origin_media" },
  designReferences: [{
    origin: "https://prconsulting.net",
    purpose: "design_inspiration_only",
    crawlAllowed: false,
    contentReuse: "prohibited",
    mediaReuse: "prohibited"
  }],
  fidelity: {
    mode: "design_inspired",
    sourceDesignTreatment: "source_content_with_design_inspiration_only"
  }
};

// Bumped 3 -> 4 to migrate the platform record to its explicit Zilberman capture policy, 4 -> 5 (C1,
// BRIEF §3.7) to declare list_pdf_templates/get_image_model_policy in PLATFORM_TOOL_POLICIES —
// sitePrefetch.ts's PDF-template and image-policy reads (declarative only; defaultToolPolicy
// "allowed" already covered both). 5 -> 6 (REVIEW, BRIEF §3.3) to declare
// site_apply_brand_imagery as needs_approval — NOT declarative: this one changes the effective
// permission from "allowed" (the client-wide default) to "needs_approval", which is what makes
// visual_standard_materializer's policy gate mean something on this project.
export const PLATFORM_DEFINITION_VERSION = 6;

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
  capturePolicy: structuredClone(PLATFORM_CAPTURE_POLICY),
  objectDialect: { ...PLATFORM_OBJECT_DIALECT },
  publishingPolicy: {
    publishEnabled: true,
    requiresExplicitPublish: false,
    description: "Publishing is enabled (go-live 2026-07-31, operator decision). Set the per-project *_PUBLISH_ENABLED=false env flag to force publishing off."
  },
  status: "active"
};

// The default-projects seed list lives in ../defaultProjects.ts — this module defines ONLY the
// platform connection so the workspace core never has to import from a client-specific folder.
