// G5 — the one profile every genesis-minted tenant is born with and migrated against.
//
// THE BUG THIS CLOSES. `migrateDefaultProjectConfig` looks a project up in `defaultProjectsById`,
// which is built only from `defaultProjectConnections` — five code-defined ids. A minted tenant is
// never a key there, so the migration returned `changed: false` for it no matter how far its record
// had drifted. Genesis wrote `defaultToolPolicy: "allowed"` with an empty `toolPolicies`, and live
// zilberman was later hand-tuned to `blocked` with an explicit 32-verb map. Nothing reconciled the
// two, and nothing ever would have: the drift was structurally invisible.
//
// WHY `blocked` AND NOT `allowed`. `allowed` with an empty map means every remote verb the tenant
// exposes is permitted by default on a brand-new site — including ones added to the tenant surface
// long after birth, which is the part that does not age well. The comment on genesis's `"allowed"`
// argued the emission stage needs its verbs and that publish/release are refused pre-transport
// anyway (FORBIDDEN_PROJECT_VERBS, forbiddenProjectVerbs.ts). Both halves are true and neither
// requires a deny-nothing default: name the verbs instead.
//
// HOW THE LIST WAS DERIVED, and why it is not hand-authored. A short allowlist recreates exactly the
// "minted tenant cannot publish" class of bug this whole change exists to remove, so the set is the
// UNION of two sources, both mechanical:
//   1. zilberman's LIVE toolPolicies — a tenant that publishes today, so its map is proof-by-running
//      rather than proof-by-reasoning.
//   2. every verb the capture/clone emission stages actually speak: cloneEngine names object_checkin,
//      object_checkout, object_create, object_get, object_inventory, object_patch, registry_get and
//      site_apply_theme; captureEngine names create_capture_job, get_capture_job_status and
//      get_capture_snapshot.
// (2) turned out to be a strict subset of (1), so the union IS zilberman's live set — which is the
// reassuring outcome, not a reason to skip the check: it says the operator's hand-tuning already
// covered emission, and it is why migrating zilberman produces an empty policy diff.
//
// object_publish and release_to_production stay "allowed" here deliberately. They are the verbs
// publish_executor and release_executor exist to speak, and every OTHER node is refused them
// pre-transport by FORBIDDEN_PROJECT_VERBS regardless of what this map says. Removing them would not
// harden anything; it would only break the two nodes that are already gated three ways.
import type { ProjectConnectionConfig, ToolPermission } from "./projectTypes.js";

/** Bump when the profile below changes in a way every minted tenant should inherit. */
export const GENESIS_TENANT_DEFINITION_VERSION = 1;

/**
 * The remote verbs a genesis-minted tenant may speak. Ordered as the live record orders them
 * (contract/registry, objects, capture, artifacts, site, publish, media, deploy) so a diff against
 * `project_get` output reads cleanly.
 */
export const GENESIS_TENANT_TOOL_POLICIES: Readonly<Record<string, ToolPermission>> = Object.freeze({
  ping: "allowed",
  registry_get: "allowed",
  object_contract: "allowed",
  object_inventory: "allowed",
  object_get: "allowed",
  object_list: "allowed",
  object_validate: "allowed",
  object_checkout: "allowed",
  object_checkin: "allowed",
  object_refresh_lock: "allowed",
  object_patch: "allowed",
  object_create: "allowed",
  object_discard: "allowed",
  create_capture_job: "allowed",
  get_capture_job_status: "allowed",
  get_capture_snapshot: "allowed",
  create_artifact_from_url: "allowed",
  create_artifact_upload_intent: "allowed",
  save_artifact: "allowed",
  get_artifact_metadata: "allowed",
  search_artifacts: "allowed",
  list_artifacts_for_request: "allowed",
  list_artifacts_by_request: "allowed",
  list_artifacts_by_kind: "allowed",
  site_apply_theme: "allowed",
  object_publish: "allowed",
  release_to_production: "allowed",
  publish_pdf_template: "allowed",
  search_images: "allowed",
  deploy_status: "allowed",
  list_pdf_templates: "allowed",
  get_image_model_policy: "allowed"
});

/**
 * The verbs the capture and clone emission stages speak. Kept explicit so a future edit to the map
 * above cannot quietly drop one — `genesisTenantProfile.test.ts` asserts containment, which is the
 * whole safety property: a minted tenant that cannot emit is the bug this profile exists to prevent.
 */
export const GENESIS_EMISSION_VERBS: readonly string[] = Object.freeze([
  "object_checkout",
  "object_checkin",
  "object_create",
  "object_patch",
  "object_get",
  "object_inventory",
  "registry_get",
  "site_apply_theme",
  "create_capture_job",
  "get_capture_job_status",
  "get_capture_snapshot"
]);

/**
 * The profile fields a minted tenant is born with and migrated against.
 *
 * DELIBERATELY NARROW. This governs tool policy and nothing else. A tenant's endpoint, token
 * references, object dialect, capture policy, publishing policy and site binding are its IDENTITY or
 * an operator's per-tenant decision — a profile that replaced those would turn one drift bug into a
 * much worse one, because `migrateDefaultProjectConfig` replaces the WHOLE record for the five code
 * projects and that shape must never be applied to a minted tenant. platform's own first migration
 * was additive-only for the same reason (see defaultProjects.ts).
 */
export type GenesisTenantProfile = Pick<ProjectConnectionConfig, "definitionVersion" | "defaultToolPolicy" | "toolPolicies">;

export const genesisTenantProfile = (): GenesisTenantProfile => ({
  definitionVersion: GENESIS_TENANT_DEFINITION_VERSION,
  defaultToolPolicy: "blocked",
  toolPolicies: { ...GENESIS_TENANT_TOOL_POLICIES }
});

/**
 * Is this record a genesis-born tenant? `clientSiteBinding` is the marker: it is set by
 * `runSiteGenesis` at birth, by the credential reconciler, and by `project.update` — but is
 * deliberately NOT accepted on `project.create`'s public schema, so an MCP caller cannot self-mark a
 * record as a generated client site in order to inherit this profile.
 */
export const isGenesisMintedProject = (config: ProjectConnectionConfig): boolean =>
  Boolean(config.clientSiteBinding);
