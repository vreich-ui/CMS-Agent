// Capability readiness derivation (R1). deriveTenantCapabilityAvailability() answers, for every
// capability in the vocabulary (capabilityVocabulary.ts), whether a specific tenant genuinely has it
// — derived from TRUSTED, ALREADY-LOADED FACTS about that tenant, never from a caller's own claim.
//
// THE DEFECT THIS CLOSES. operationPreflight.ts used to diff an operation's requiredCapabilities
// against `request.configuredCapabilities` — a plain array of strings a CALLER supplies, including a
// model turn reaching operation.preflight over MCP. Nothing checked the claim against anything real,
// so `configuredCapabilities: ["pdf_render", "asset_search", ...]` made every capability gap for those
// ids vanish regardless of whether the tenant could do any of it. This module is the fix: it computes
// availability from facts about the tenant's own project record — never from what a caller asserts —
// and operationPreflight.ts now uses the caller's array only to NARROW the derived result, never to
// widen it (see that module's own header for the exact rule).
//
// PURE, BY THE SAME DISCIPLINE operationPreflight.ts HOLDS ITSELF TO: no repository, no network
// client, no clock, no randomness. `TenantCapabilityFacts` below carries only plain, already-resolved
// values — this module never fetches a project record, never calls a tenant, and never probes a live
// MCP server to see whether a tool name actually works. Loading those facts (an async repository read)
// is the CALLER's job (e.g. operationTools.ts's operation.preflight, wired in this task) — this module
// only turns facts already in hand into a verdict. Same zero-I/O guarantee as operationPreflight.ts,
// for the same reason: a "just try the call and see" path here would be exactly the kind of probe that
// module's header says preflight must never perform.
//
// A NOTE ON WHAT "GENUINELY REGISTERED" MEANS FOR registeredToolNames. This is NOT a live discovery
// call (project.list_tools) — that would violate the zero-I/O guarantee and would be per-request
// network access this module can never have. It is the tenant's own PROJECT RECORD's tool policy
// (`effectiveToolPermission`, projectTypes.ts), evaluated by the caller for the fixed, small set of
// tool names this module's derivation cares about (CAPABILITY_EVIDENCE_TOOL_NAMES, exported below so
// the caller building TenantCapabilityFacts never has to guess which names matter). That is a REAL,
// already-persisted fact about the tenant — declared policy, not a caller's runtime claim — even
// though it does not itself prove the remote server implements the verb; the same posture the rest of
// the engine already takes toward `effectiveToolPermission` (nowhere in this codebase does declaring a
// tool "allowed" on a project record get verified against a live tools/list call before use).
import { listCapabilityIds } from "./capabilityVocabulary.js";

// Trusted facts about ONE tenant, loaded by the caller before calling preflightOperation — never
// fetched by this module. `registeredToolNames` is deliberately narrow: only the tool names this
// module's own REQUIREMENTS table below consults (CAPABILITY_EVIDENCE_TOOL_NAMES), not an attempt to
// enumerate every tool a tenant's remote server might expose.
export type TenantCapabilityFacts = {
  tenantId: string;
  // From the project record's own `status` field (projectTypes.ts's ProjectStatus). A disabled
  // project makes every capability unavailable with reason "unavailable" — configured, but the
  // tenant is currently switched off — rather than "not_configured", because re-enabling it (not
  // reconfiguring anything) is what would close the gap.
  projectStatus: "active" | "disabled" | "provisioning";
  // Whether the project record carries an `objectDialect` (ProjectObjectDialect, projectTypes.ts) —
  // i.e. whether this tenant's object substrate has an addressable home for governed objects at all.
  // Required by any capability that reads or writes a governed object (visual_identity_read/propose).
  objectDialectConfigured: boolean;
  // The subset of CAPABILITY_EVIDENCE_TOOL_NAMES that resolve to "allowed" under this tenant's own
  // effectiveToolPermission precedence (toolPolicies > allowedTools > defaultToolPolicy > "blocked").
  // Order-independent; membership is all that is read.
  registeredToolNames: readonly string[];
};

export type CapabilityAvailability =
  | { available: true; evidence: Record<string, unknown> }
  | { available: false; reason: "not_configured" | "not_supported" | "unavailable"; evidence: Record<string, unknown> };

// How one capability's availability is decided. "tool": needs one named tool allowed. "tool_and_dialect":
// needs that tool allowed AND an object dialect configured (the capability reads/writes a governed
// object). "unsupported": no tenant, however configured, can satisfy this today — nothing in the
// codebase implements a verb for it.
//
// A10 — NO capability claims `unsupported` any more: image_template_write was the last one, and its
// claim was stale (see its own entry below). The kind is KEPT, deliberately, because it is the
// honest derivation for a capability some descriptor requires and nothing implements — the
// alternative is naming a tool nobody calls, which reads as available. capabilityReadiness.test.ts
// asserts that no capability claims it today, so claiming it again is a visible choice.
type CapabilityRequirement =
  | { kind: "tool"; toolName: string }
  | { kind: "tool_and_dialect"; toolName: string }
  | { kind: "unsupported"; note: string };

// EVIDENCE SOURCE FOR EACH TOOL NAME, on the record — not invented for this task:
//   object_inventory — DR_LURIE_SAFE_READ_ONLY_TOOLS (drLurie/definition.ts) and
//     GENESIS_TENANT_TOOL_POLICIES (genesisTenantProfile.ts) both name it "allowed"; it is the
//     inventory read site_inventory's own descriptor (siteInventory.ts) describes.
//   object_get — same two sources; the verb visualStandardMaterialization.ts already reads a
//     visual_identity_standard object through (object_get({object_type: VISUAL_STANDARD_OBJECT_TYPE, ...})).
//   object_create — GENESIS_TENANT_TOOL_POLICIES names it "allowed"; it is the verb a new draft
//     object (a filed visual-identity proposal) is created through on the object substrate.
//   search_artifacts — DR_LURIE_ARTIFACT_TOOLS and GENESIS_TENANT_TOOL_POLICIES both name it
//     "allowed"; it is asset_lookup_adopt's own declared `search_assets` effect's real verb.
//   search_images — GENESIS_TENANT_TOOL_POLICIES names it "allowed"; image_template_revision's own
//     declared effect searches for candidate images.
//   create_pdf_template / publish_pdf_template — GENESIS_TENANT_TOOL_POLICIES names both "allowed";
//     pdf_template_family's own two declared effects (design, then publish) are exactly these verbs.
//   annotate_image — T3 (2026-09-16 annotate-bridge plan). NOT named in any allowlist constant in
//     this repo, and deliberately not claimed to be: it is a PDF-Tool verb reached through the
//     per-tenant bridge, and the tenants it was live-verified on today (dr-lurie, platform) carry
//     defaultToolPolicy "allowed" (drLurie/definition.ts, platform/definition.ts), under which
//     effectiveToolPermission resolves it "allowed" without an explicit row — the same already-
//     persisted declared-policy fact this module reads for every other tool name here (see the
//     module header's own note on what "genuinely registered" means). A tenant that narrows its
//     policy therefore reports an honest not_configured gap naming annotate_image, which is exactly
//     the record operation_list_capability_gaps could never hold while this operation had no id.
//   document_render — GENESIS_TENANT_TOOL_POLICIES v3 names it "allowed" (genesisTenantProfile.ts);
//     it is Platform's owner-based render verb (packages/core/server/lib/mcp-tool-definitions.ts:
//     `document_render`, shipped in Platform #752) whose input — an owned document named by its
//     object, rendered through the site's own template — is the shape document_render's OWN
//     descriptor declares (`documentRef {objectType, objectId}`, descriptors/documentRender.ts).
//     WAS `render_article_pdf` under a comment claiming no tenant had ever been granted it; that was
//     already false for every defaultToolPolicy "allowed" record (dr-lurie, platform), and
//     `render_article_pdf` is the article-only shortcut, not the generic contract. Still A8: the
//     verb is gated here, and nothing implements the operation yet (operationWorkflowBindings.ts's
//     UNBOUND_OPERATION_IMPLEMENTING_TASK) — preflight reports that gap by name, separately.
const REQUIREMENTS: Readonly<Record<string, CapabilityRequirement>> = {
  site_inventory_read: { kind: "tool", toolName: "object_inventory" },
  visual_identity_read: { kind: "tool_and_dialect", toolName: "object_get" },
  visual_identity_propose: { kind: "tool_and_dialect", toolName: "object_create" },
  asset_search: { kind: "tool", toolName: "search_artifacts" },
  pdf_render: { kind: "tool", toolName: "document_render" },
  pdf_template_write: { kind: "tool", toolName: "create_pdf_template" },
  pdf_template_publish: { kind: "tool", toolName: "publish_pdf_template" },
  image_search: { kind: "tool", toolName: "search_images" },
  // T3 — the WRITE half of image_annotation's declared pair. analyze_image_layout (its read half)
  // gates nothing on its own: it writes nothing, and a tenant that can annotate can analyze. Same
  // posture as image_template_write below, which gates on create_pdf_template and not on the reads
  // its own run performs first.
  image_annotate: { kind: "tool", toolName: "annotate_image" },
  // A10 — WAS `{ kind: "unsupported" }`, on the stated grounds that "image_template_revision, A9, is
  // unimplemented". A9 SHIPPED: the operation is bound to image_template_revision_studio and its
  // apply stage (cloneConductorRoutes.ts's "image_revision_apply" -> runImageRevisionApplyBatch)
  // performs the revision by reusing pdfTemplateEngine.ts's OWN mint/publish stages — whose real
  // verbs are create_pdf_template and publish_pdf_template, both named "allowed" in
  // GENESIS_TENANT_TOOL_POLICIES (genesisTenantProfile.ts), exactly like pdf_template_write below.
  // Leaving this "unsupported" was no longer an honest systemic gap but a stale one, and it was
  // load-bearing: an "unsupported" gap is reason "not_supported", which Platform's own
  // resolveCatalogOperation treats as a hard refusal (`notSupportedGaps.length > 0` =>
  // operation_not_ready) for EVERY tenant, however provisioned — so this single stale line refused
  // every chat-dispatched image_template_revision request no matter what else was wired.
  // create_pdf_template (the WRITE verb) is what this capability gates; the publish half is gated
  // separately by the run's own publish-risk gate on image_revision_apply plus the project's
  // publishEnabled kill switch (cloneConductorRoutes.ts's image_revision_publish_disabled), not by a
  // preflight capability. The engine's "web" surface remains a named PER-ITEM capability gap
  // reported by the run itself (image_revision_surface_unsupported), which is a property of the
  // request's targets, not of the tenant's configuration.
  image_template_write: { kind: "tool", toolName: "create_pdf_template" }
};

// VALIDATED AT IMPORT TIME, same discipline operationWorkflowBindings.ts's assertBindingIsSound()
// already holds itself to: every vocabulary id must have exactly one derivation rule here, and no
// rule may name a capability the vocabulary does not know. A future capability added to
// capabilityVocabulary.ts with no matching entry here — or vice versa — fails loudly at import
// instead of silently deriving nothing (or deriving something for an id no descriptor can require).
for (const capabilityId of listCapabilityIds()) {
  if (!(capabilityId in REQUIREMENTS)) {
    throw new Error(`capabilityReadiness: capability "${capabilityId}" is registered in capabilityVocabulary.ts but has no derivation rule in REQUIREMENTS.`);
  }
}
for (const capabilityId of Object.keys(REQUIREMENTS)) {
  if (!listCapabilityIds().includes(capabilityId)) {
    throw new Error(`capabilityReadiness: REQUIREMENTS names capability "${capabilityId}", which capabilityVocabulary.ts does not register.`);
  }
}

// The fixed, small set of tool names this module's derivation ever consults. Exported so a caller
// building TenantCapabilityFacts (operationTools.ts) knows exactly which names to resolve
// effectiveToolPermission against — never a live discovery call, and never a guess at the full set of
// tools a tenant's remote server might expose. Sorted, deterministic.
export const CAPABILITY_EVIDENCE_TOOL_NAMES: readonly string[] = [
  ...new Set(Object.values(REQUIREMENTS).flatMap((requirement) => (requirement.kind === "unsupported" ? [] : [requirement.toolName])))
].sort((left, right) => left.localeCompare(right));

function deriveOne(capabilityId: string, requirement: CapabilityRequirement, facts: TenantCapabilityFacts): CapabilityAvailability {
  if (requirement.kind === "unsupported") {
    return { available: false, reason: "not_supported", evidence: { capability: capabilityId, note: requirement.note } };
  }
  // A2.2: both non-active states make capabilities unavailable, but for different reasons — the
  // `reason` below stays "unavailable" either way, and the evidence names which state it is.
  if (facts.projectStatus !== "active") {
    return {
      available: false,
      reason: "unavailable",
      evidence: { capability: capabilityId, tenantId: facts.tenantId, projectStatus: facts.projectStatus }
    };
  }
  if (requirement.kind === "tool_and_dialect" && !facts.objectDialectConfigured) {
    return {
      available: false,
      reason: "not_configured",
      evidence: { capability: capabilityId, tenantId: facts.tenantId, objectDialectConfigured: false }
    };
  }
  if (!facts.registeredToolNames.includes(requirement.toolName)) {
    return {
      available: false,
      reason: "not_configured",
      evidence: {
        capability: capabilityId,
        tenantId: facts.tenantId,
        requiredToolName: requirement.toolName,
        registeredToolNames: [...facts.registeredToolNames]
      }
    };
  }
  return {
    available: true,
    evidence: {
      capability: capabilityId,
      tenantId: facts.tenantId,
      requiredToolName: requirement.toolName,
      ...(requirement.kind === "tool_and_dialect" ? { objectDialectConfigured: true } : {})
    }
  };
}

// Derive availability for EVERY vocabulary capability from one tenant's trusted facts. Total and
// pure: same facts in always yields the same map out, for every registered capability id — a caller
// never has to guess which ids are covered (listCapabilityIds() is the exhaustive key set, enforced
// above at import time).
export function deriveTenantCapabilityAvailability(facts: TenantCapabilityFacts): Record<string, CapabilityAvailability> {
  const result: Record<string, CapabilityAvailability> = {};
  for (const capabilityId of listCapabilityIds()) {
    result[capabilityId] = deriveOne(capabilityId, REQUIREMENTS[capabilityId], facts);
  }
  return result;
}
