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
// (2) turned out to be a strict subset of (1), so the union IS zilberman's live set — which read at
// the time as the reassuring outcome.
//
// W4.3 CORRECTION (2026-09-09): it was not reassuring, it was the defect. Deriving the profile from
// one live tenant's map copied that tenant's GAPS into every tenant minted afterwards, and the
// containment check that was supposed to catch this only covered (2) — the capture/clone EMISSION
// verbs. Emission is not the whole engine. The route manifests (routeRegistry.ts, complete since
// W3.2.0) declare four more route families, and three of them needed verbs neither source had:
//
//   clone_stage:pdf_mint          create_pdf_template, validate_pdf_template,
//                                 get_pdf_template_validation — while publish_pdf_template WAS
//                                 permitted. A tenant allowed to publish a template it may not
//                                 create; the pdf branch failed at mint and never reached the
//                                 publish it was entitled to perform. Found live on zilberman and
//                                 on genesis-lab-2, which is what proves it came from here.
//   artifact_materializer         get_agent_artifact_by_slot, create_agent_artifact_job,
//                                 get_agent_artifact_job_status — so every PDF and image slot on
//                                 every run for a minted tenant reported blocked. Exactly the
//                                 "minted tenant cannot do its job" class this profile exists to
//                                 prevent, one node over.
//   visual_standard_materializer  site_apply_brand_imagery — deliberately still withheld, see
//                                 GENESIS_WITHHELD_ROUTE_VERBS below.
//
// The containment check now walks the route manifests instead of a hand-kept emission list, so the
// next route that starts speaking a new verb fails a test here rather than stalling a tenant.
//
// object_publish and release_to_production stay "allowed" here deliberately. They are the verbs
// publish_executor and release_executor exist to speak, and every OTHER node is refused them
// pre-transport by FORBIDDEN_PROJECT_VERBS regardless of what this map says. Removing them would not
// harden anything; it would only break the two nodes that are already gated three ways.
import type { ProjectConnectionConfig, ToolPermission } from "./projectTypes.js";

/** Bump when the profile below changes in a way every minted tenant should inherit.
 *  v2 (W4.3): the pdf-template mint verbs and the agent-artifact job verbs. */
export const GENESIS_TENANT_DEFINITION_VERSION = 2;

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
  get_agent_artifact_by_slot: "allowed",
  create_agent_artifact_job: "allowed",
  get_agent_artifact_job_status: "allowed",
  site_apply_theme: "allowed",
  object_publish: "allowed",
  release_to_production: "allowed",
  create_pdf_template: "allowed",
  validate_pdf_template: "allowed",
  get_pdf_template_validation: "allowed",
  publish_pdf_template: "allowed",
  search_images: "allowed",
  deploy_status: "allowed",
  list_pdf_templates: "allowed",
  get_image_model_policy: "allowed"
});

/**
 * Route verbs this profile deliberately does NOT grant a newborn tenant. The list is the point: with
 * it, the containment test can demand that the profile cover every verb the route manifests declare,
 * and any NEW gap fails that test — so a future gap has to be either granted or written down here as
 * a decision. Without it, a gap and a decision look identical, which is how the pdf-template one
 * survived for months.
 *
 * `site_apply_brand_imagery` restyles an entire site in one call. A tenant minted an hour ago has no
 * brand standard worth applying site-wide and no operator has looked at it yet, so
 * `visual_standard_materializer` is an operator-enabled node on a new tenant rather than a birthright.
 * Granting it is a one-line policy change through `project.update` when that operator decides.
 */
export const GENESIS_WITHHELD_ROUTE_VERBS: readonly string[] = Object.freeze([
  "site_apply_brand_imagery"
]);

/**
 * The verbs the capture and clone emission stages speak. Kept explicit so a future edit to the map
 * above cannot quietly drop one — `genesisTenantProfile.test.ts` asserts containment, which is the
 * whole safety property: a minted tenant that cannot emit is the bug this profile exists to prevent.
 * Superseded in scope by the route-manifest containment check (emission is a subset of it), kept
 * because it names the verbs that must never be dropped even if a manifest is edited.
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
