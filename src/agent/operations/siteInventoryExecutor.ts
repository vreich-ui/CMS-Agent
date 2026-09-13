// site_inventory — THE EXECUTOR (A4). siteInventory.ts (the descriptor) is a CONTRACT ONLY; this
// module actually runs it, composed entirely from siteContext.ts's snapshot machinery
// (captureSiteSnapshot + the injected SiteContextSource, production-bound by
// siteContextSourceAdapter.ts) — never a second way to enumerate a tenant's objects, per that
// descriptor's own header instruction.
//
// PURE READ. This module never imports anything capable of writing to a tenant (no ProjectMcpAdapter,
// no tenantAdapterFor, no tool name at all) — every tenant call it causes happens inside the injected
// `siteContextSource`, which `operation_execute` (the caller) constructs from
// siteContextSourceAdapter.ts, itself proven read-only (see that module's own header and its test).
//
// COMPLETION IS PROJECTED FROM EVIDENCE ACTUALLY PRODUCED, NEVER ASSERTED. `projectCompletion` below
// looks at siteInventoryOperationV1's OWN registered `completion` array (fetched via getOperation —
// this module never hardcodes the check's id/description) and marks an entry satisfied ONLY when
// this run's real evidenceKind matches what that entry names. A completion check this executor did
// not actually produce evidence for is reported unsatisfied, never silently dropped and never assumed
// true because "this is the only executor that ever runs".
//
// WHAT "LIST EVERY TYPE" MEANS WHEN objectType IS OMITTED. The operation's own descriptor says
// "omit to list every type", but there is no live discovery call in this codebase that enumerates an
// ARBITRARY tenant's object-type vocabulary — captureSiteSnapshot (siteContext.ts) itself requires an
// explicit `objectTypes: string[]` array, by design (see that module's own header: it is a snapshot
// of NAMED types, not an open-ended crawl). So "every type" here means every type in
// DEFAULT_INVENTORY_OBJECT_TYPES below — a closed, EVIDENCED list (see its own comment for exactly
// where each entry came from), not a live probe and not necessarily complete for a tenant whose
// object-type vocabulary this codebase has never captured. That bound is stated here, honestly,
// rather than silently under- or over-claiming what an unscoped request returns; a caller that needs
// a type outside this list names it explicitly via `objectType`.
//
// HISTORY (`since`) IS ACCEPTED, NEVER FABRICATED. siteInventoryOperationV1's own descriptor comment
// reserves the change-event history read to "a later task's own change-event read" — this executor
// does not invent one. `since` is validated and echoed back on the result's `history` field with
// `supported: false` and an empty `events` array, rather than being silently dropped (a caller who
// passed `since` can tell, from the response itself, that it was received and not yet actionable) or
// answered with fabricated events.
import { captureSiteSnapshot, type SiteContextSource } from "./siteContext.js";
import { getOperation } from "./operationCatalog.js";
import type { OperationBlocker, OperationCompletionCheck } from "./operationTypes.js";

export const SITE_INVENTORY_EXECUTOR_ID = "site_inventory_executor";

// The input schema THIS EXECUTOR declares it accepts — copied field-for-field from
// siteInventoryOperationV1.inputSchema (descriptors/siteInventory.ts), under the SAME names (no
// rename table — see operationExecutorBindings.ts's own header for why an executor has none). Kept
// as its own literal, not a re-export of the descriptor's inputSchema, so a future change to either
// one is a deliberate, visible edit in both places rather than an invisible shared reference.
export const SITE_INVENTORY_EXECUTOR_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["tenantId"],
  properties: {
    tenantId: { type: "string", minLength: 1 },
    objectType: { type: "string", minLength: 1 },
    includeRetired: { type: "boolean" },
    since: { type: "string", format: "date-time" }
  }
};

// EVIDENCED, CLOSED, NOT A LIVE DISCOVERY CALL — see module header. Sourced from two places:
//   - the platform's own CMS object-type vocabulary, captured VERBATIM from a live platform
//     tools/list schema (tests/agent/capture/fixtures/platformToolSchemas.ts's object_get /
//     object_checkout / object_patch / object_inventory `object_type` enum, captured 2026-08-24);
//   - this codebase's own visual-identity-domain object types, named by siteContext.ts's own
//     SiteRegistries / the visual_identity_review_change operation's declared targetType / the
//     in-memory test fixture's VISUAL_STANDARD_CONTRACT and LORA_MODEL_CONFIG_CONTRACT — not present
//     in the platform capture above because that capture covers only the object-substrate verbs
//     cloneEngine.ts calls, not every object type a tenant's contract can name.
// A tenant whose object-type vocabulary includes something outside this list is under-enumerated by
// an unscoped ("every type") request — not silently, since objectTypesScanned on the result names
// exactly what was asked for either way.
export const DEFAULT_INVENTORY_OBJECT_TYPES: readonly string[] = [
  "page", "section", "navigation", "taxonomy", "site", "template", "section_template", "theme",
  "product", "content_item", "tracking_config", "editorial_voice",
  "visual_standard", "image_model_config"
];

export type SiteInventoryObjectRow = {
  objectId: string;
  objectType: string;
  status: string;
  version: number;
  contentRevision: number;
  publishedTime: string | null;
  updatedAt: string;
};

export type SiteInventoryResult = {
  tenantId: string;
  capturedAtISO: string;
  digest: string;
  objectTypesScanned: string[];
  requested: { objectType: string | null; includeRetired: boolean; since: string | null };
  objects: SiteInventoryObjectRow[];
  // See module header ("HISTORY"). `supported: false` is a literal, not computed — never claim a
  // guarantee this executor does not enforce.
  history: { since: string | null; supported: false; events: [] };
};

export type InventorySnapshotEvidence = {
  evidenceKind: "inventory_snapshot";
  tenantId: string;
  capturedAtISO: string;
  digest: string;
  objectTypesScanned: string[];
  totalObjects: number;
};

export type ProjectedCompletionCheck = OperationCompletionCheck & { satisfied: boolean; evidence: InventorySnapshotEvidence | null };

function projectCompletion(checks: readonly OperationCompletionCheck[], evidence: InventorySnapshotEvidence): ProjectedCompletionCheck[] {
  return checks.map((check) => (check.evidenceKind === evidence.evidenceKind ? { ...check, satisfied: true, evidence } : { ...check, satisfied: false, evidence: null }));
}

// The general run-signature shape this task wires exactly one executor to
// (operationExecutorBindings.ts's BINDINGS table). Kept here (not a shared kernel module) because
// there is exactly one caller and exactly one implementer today — extracting a shared
// operationExecutorKernel.ts is a later task's job once a second executor exists, not a
// speculative abstraction built ahead of its second use.
export type OperationExecutorDeps = {
  siteContextSource?: SiteContextSource;
};

export type OperationExecutorRunResult =
  | { ok: true; data: unknown; completion: ProjectedCompletionCheck[] }
  | { ok: false; blockers: OperationBlocker[] };

export type OperationExecutorFn = (params: { tenantId: string; input: Record<string, unknown>; deps: OperationExecutorDeps }) => Promise<OperationExecutorRunResult>;

export const runSiteInventoryExecutor: OperationExecutorFn = async ({ tenantId, input, deps }) => {
  if (!deps.siteContextSource) {
    return {
      ok: false,
      blockers: [{
        code: "site_context_source_not_configured",
        message: "site_inventory_executor was invoked with no siteContextSource dependency.",
        remedy: "The caller (operation_execute) must construct a SiteContextSource (siteContextSourceAdapter.ts in production) and pass it as deps.siteContextSource.",
        blocking: true
      }]
    };
  }

  const objectType = typeof input.objectType === "string" && input.objectType.length ? input.objectType : undefined;
  const includeRetired = input.includeRetired === true;
  const since = typeof input.since === "string" && input.since.length ? input.since : undefined;
  const objectTypes = objectType ? [objectType] : [...DEFAULT_INVENTORY_OBJECT_TYPES];

  let snapshot;
  try {
    snapshot = await captureSiteSnapshot(deps.siteContextSource, { tenantId, objectTypes });
  } catch (error) {
    // See siteContextSourceAdapter.ts's own header: a real tenant read failure surfaces here as a
    // thrown, typed error — never a silently empty snapshot. Reported structurally, never re-thrown
    // across the operation_execute boundary, matching this task's own "returns a structured result"
    // requirement.
    const name = error instanceof Error ? error.name : "unknown_error";
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      blockers: [{
        code: "tenant_read_failed",
        message: `site_inventory could not read tenant "${tenantId}": ${message}`,
        remedy: "Confirm the tenant's project record is active and its object_inventory tool policy is \"allowed\", then retry.",
        blocking: true,
        evidence: { errorName: name, tenantId, objectTypes }
      }]
    };
  }

  // "retired" maps to the tenant's own "archived" status — the one lifecycle value this codebase has
  // confirmed on the wire (object_inventory's own `status` query-filter enum:
  // platformToolSchemas.ts's object_inventory schema, "active"/"archived"). A row whose status this
  // adapter could not determine ("unknown" — see siteContextSourceAdapter.ts's own comment) is never
  // filtered out by includeRetired:false, since "unknown" is not evidence the object IS retired.
  const objects: SiteInventoryObjectRow[] = objectTypes
    .flatMap((type) => snapshot!.objects.byType[type] ?? [])
    .filter((object) => includeRetired || object.status !== "archived")
    .map((object) => ({
      objectId: object.objectId,
      objectType: object.objectType,
      status: object.status,
      version: object.version,
      contentRevision: object.contentRevision,
      publishedTime: object.publishedTime,
      updatedAt: object.updatedAt
    }));

  const evidence: InventorySnapshotEvidence = {
    evidenceKind: "inventory_snapshot",
    tenantId,
    capturedAtISO: snapshot.capturedAtISO,
    digest: snapshot.digest,
    objectTypesScanned: objectTypes,
    totalObjects: objects.length
  };

  const data: SiteInventoryResult = {
    tenantId,
    capturedAtISO: snapshot.capturedAtISO,
    digest: snapshot.digest,
    objectTypesScanned: objectTypes,
    requested: { objectType: objectType ?? null, includeRetired, since: since ?? null },
    objects,
    history: { since: since ?? null, supported: false, events: [] }
  };

  // Looked up from the CATALOG's own registered descriptor, never hardcoded — a future edit to
  // siteInventoryOperationV1.completion is reflected here without touching this file.
  const lookup = getOperation("site_inventory");
  const completionChecks = lookup.found ? lookup.descriptor.completion : [];
  return { ok: true, data, completion: projectCompletion(completionChecks, evidence) };
};
