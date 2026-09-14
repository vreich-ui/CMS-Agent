// A9/A10 — THE THING THAT WAS MISSING: the constructor that turns an editor's dispatched
// `image_template_revision` OPERATION INPUT (flat: tenantId / sourceAsset / templateRefs /
// placement / approve / batchSize — descriptors/imageTemplateRevision.ts) into the NESTED
// `imageTemplateRevisionBrief` that imageRevisionIntakeStep actually reads
// (imageTemplateRevisionEngine.ts). Until this module existed, NOBODY built it: the operation was
// bound to image_template_revision_studio with an EMPTY inputMapping, Platform sent the flat fields
// through workflow_start_dry_run, and the entry node refused every run by name
// (image_template_revision_brief_missing, cloneConductorRoutes.ts) — honest, and still a failure.
//
// WHY A BRIEF BUILDER AND NOT AN `operationExecutorBindings.ts` EXECUTOR. An executor there is a
// direct, in-process function with no run record and no node graph, reached through
// `operation.execute` — and `operation.execute` is READ-ONLY GATED (checkOperationIsReadOnly,
// operationTools.ts): image_template_revision declares a "write" effect (and its apply node carries
// riskLevel "publish"), so it is refused at that entrypoint by construction, before any executor
// could run. The work this operation does IS the four-node run graph; what was missing was never a
// second implementation of it, only the translation from the operation's own vocabulary into the
// brief that graph reads. So this composes WITH the workflow binding (operationWorkflowBindings.ts's
// `initialInputBuilder`) instead of replacing it, and the mutual-exclusivity assertion in
// operationExecutorBindings.ts stays exactly as it is — no operation is registered in both tables.
//
// TOTAL AND REFUSING, NEVER COERCING. Every rejection below is a named code + reason returned as
// data (the caller — workflowInitialInput.ts, applied inside startDryRun BEFORE a run record
// exists — turns it into a WorkspaceToolError, so nothing is minted and nothing is spent). Three
// refusals are load-bearing rather than cosmetic:
//   * a templateRef naming a DIFFERENT tenant than the operation's own tenantId is refused, never
//     silently accepted. Platform forces the operation's top-level `tenantId` to the caller's own
//     project (tools.ts's resolveCatalogOperation, applied last) but it does NOT reach inside
//     `templateRefs[]`, whose items carry their own required `tenantId` in this operation's schema —
//     a model-authored ref could therefore name another tenant's template. This is not the only
//     refusal on that path (operationPreflight.ts's own typed-reference validation reports
//     `reference_tenant_mismatch` for the same input, before dispatch), and it matters BECAUSE the
//     lookup downstream is NOT tenant-scoped: fetchTargetTemplateVersionStep reads
//     TemplateLibraryStore by `templateId` alone and never uses `ref.tenantId`, so a ref that got
//     through would read another project's template recipe into this run. The write half is
//     separately contained (deriveRequestedIdFromTemplateId rejects a templateId not prefixed with
//     the run's own project), but the READ is not, which is why this refuses rather than relies on
//     the engine noticing.
//   * a `version` that is not a positive integer is refused, never coerced to "latest". The
//     descriptor declared it as a STRING while FetchedTemplateVersion/TargetTemplateRef have always
//     been numeric (imageTemplateRevisionEngine.ts) — a numeric string is normalized here, anything
//     else refuses rather than silently dropping the pin and revising whatever is newest.
//   * more templateRefs than `batchSize` is refused, never truncated: the engine has no paging, so
//     truncation would drop named templates from a run whose terminal report claims to name every
//     templateRef it attempted. A `batchSize` that is present but not a positive integer is refused
//     too, rather than quietly leaving the bound unenforced.
//   * a DUPLICATE templateRef (same surface+tenant+templateId) is refused. The engine keys its
//     per-item ledger by that triple and apply's own per-template maps by the derived requestedId,
//     so two identical refs both read back the SAME published record and BOTH land as "verified" —
//     a terminal report claiming two successes for one mint, which is the very class of
//     false-complete reading #337/D4 exists to prevent.
import type { ImagePlacementSpec, ImageTemplateRevisionBrief, SourceAssetRef, TargetTemplateRef } from "./imageTemplateRevisionEngine.js";

export const IMAGE_TEMPLATE_REVISION_BRIEF_BUILDER_ID = "image_template_revision_brief_builder.v1";

// The initialInput key this builder constructs — the SAME key imageRevisionIntakeStep and
// cloneConductorRoutes.ts's image_revision_* cases read. Exported so the binding's declared
// `providesInitialInputFields` and bindingInputContract.ts's guarantee are the same string as the
// one actually written, never two copies that can drift.
export const IMAGE_TEMPLATE_REVISION_BRIEF_KEY = "imageTemplateRevisionBrief";

// The operation fields this builder cannot construct a brief without. Declared (and checked against
// the operation descriptor's own guaranteed field set — required ∪ defaults — by
// bindingInputContract.ts) rather than merely assumed: that check is what makes "the binding
// guarantees the entry node its input" a verified statement instead of a hopeful one.
export const IMAGE_TEMPLATE_REVISION_BRIEF_REQUIRED_OPERATION_FIELDS = ["tenantId", "templateRefs", "sourceAsset"] as const;

export type ImageTemplateRevisionBriefBuildResult =
  | { ok: true; brief: ImageTemplateRevisionBrief }
  | { ok: false; code: string; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const SURFACES = new Set(["web", "pdf"]);

// A positive integer, from a number or a numeric string; undefined when absent; null when present
// and not one (the caller refuses on null — never coerces, see this module's header).
const readVersion = (value: unknown): number | undefined | null => {
  if (value === undefined || value === null) return undefined;
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 1) return null;
  return numeric;
};

const readSourceAsset = (value: unknown): SourceAssetRef | null => {
  if (!isRecord(value)) return null;
  const ref: SourceAssetRef = {};
  if (nonEmptyString(value.tag)) ref.tag = value.tag.trim();
  if (nonEmptyString(value.checksum)) ref.checksum = value.checksum.trim();
  if (nonEmptyString(value.captureRequestId)) ref.captureRequestId = value.captureRequestId.trim();
  return ref.tag || ref.checksum || ref.captureRequestId ? ref : null;
};

const readApprove = (value: unknown): boolean | string[] | undefined | null => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (!value.every((entry) => nonEmptyString(entry))) return null;
    return (value as string[]).map((entry) => entry.trim());
  }
  return null;
};

/**
 * Builds the brief from ONE dispatched operation input. Pure: no clock, no store, no network, no
 * model — the same discipline every step in imageTemplateRevisionEngine.ts holds itself to.
 *
 * `input` is the operation's own merged input (defaults already applied by
 * operationPreflight/Platform), under the operation's OWN field names. This never reads a field
 * under any other name and never invents one that was not supplied.
 */
export function buildImageTemplateRevisionBrief(input: unknown): ImageTemplateRevisionBriefBuildResult {
  const source = isRecord(input) ? input : {};
  const refuse = (code: string, reason: string): ImageTemplateRevisionBriefBuildResult => ({ ok: false, code, reason });

  const tenantId = nonEmptyString(source.tenantId) ? source.tenantId.trim() : undefined;
  if (!tenantId) {
    return refuse("image_revision_brief_tenant_missing", "image_template_revision was dispatched with no tenantId; every asset and template lookup this operation performs is tenant-scoped, so a brief cannot be built without one.");
  }

  const sourceAsset = readSourceAsset(source.sourceAsset);
  if (!sourceAsset) {
    return refuse(
      "image_revision_source_ref_missing",
      "image_template_revision was dispatched with no usable sourceAsset: supply sourceAsset with at least one of tag, checksum, or captureRequestId so the image being placed is a trusted, already-catalogued asset. An image is never resolved by description."
    );
  }

  const rawRefs = Array.isArray(source.templateRefs) ? source.templateRefs : [];
  if (rawRefs.length === 0) {
    return refuse("image_revision_brief_template_refs_missing", "image_template_revision was dispatched with no templateRefs; there is nothing to revise. Name every template the image should be placed on.");
  }

  // A batchSize that is PRESENT but not a positive integer is refused, not ignored: ignoring it
  // leaves the bound below unenforced, which is neither the refusal nor the truncation this module
  // promises. (The operation's own schema already types it `integer`; this covers the operator
  // surface, where workflow_start_dry_run is called directly.)
  let batchSize: number | undefined;
  if (source.batchSize !== undefined && source.batchSize !== null) {
    if (typeof source.batchSize !== "number" || !Number.isInteger(source.batchSize) || source.batchSize < 1) {
      return refuse("image_revision_batch_size_invalid", `batchSize is "${String(source.batchSize)}"; it must be a positive integer (the maximum number of templates one run may revise).`);
    }
    batchSize = source.batchSize;
  }
  if (batchSize !== undefined && rawRefs.length > batchSize) {
    return refuse(
      "image_revision_batch_size_exceeded",
      `image_template_revision was dispatched with ${rawRefs.length} templateRefs but a batchSize of ${batchSize}${batchSize === 10 ? " (the operation's own default — name a larger batchSize explicitly to raise it)" : ""}. This run is refused rather than truncated: the terminal report names every templateRef the run attempted, so silently dropping ${rawRefs.length - batchSize} of them would produce a report that reads complete while templates the editor named were never touched. Raise batchSize or split the request.`
    );
  }

  const templateRefs: TargetTemplateRef[] = [];
  const seenRefKeys = new Set<string>();
  for (const [index, raw] of rawRefs.entries()) {
    if (!isRecord(raw)) return refuse("image_revision_template_ref_invalid", `templateRefs[${index}] is not an object; each ref must name surface, templateId and tenantId.`);
    const surface = nonEmptyString(raw.surface) ? raw.surface.trim() : "";
    if (!SURFACES.has(surface)) {
      return refuse("image_revision_template_ref_invalid", `templateRefs[${index}].surface is "${String(raw.surface)}"; it must be "pdf" or "web" ("web" is a named capability gap the run reports per item, not a value this builder guesses at).`);
    }
    const templateId = nonEmptyString(raw.templateId) ? raw.templateId.trim() : "";
    if (!templateId) return refuse("image_revision_template_ref_invalid", `templateRefs[${index}].templateId is missing or empty.`);
    const refTenantId: string = nonEmptyString(raw.tenantId) ? raw.tenantId.trim() : tenantId;
    if (refTenantId !== tenantId) {
      return refuse(
        "image_revision_template_ref_tenant_mismatch",
        `templateRefs[${index}].tenantId ("${refTenantId}") is not this operation's own tenant ("${tenantId}"). A dispatched operation is scoped to one tenant, and the template library it reads is cross-tenant and keyed by templateId alone — so a ref naming another tenant is refused here, before a run exists, rather than read into this run's record per item.`
      );
    }
    const version = readVersion(raw.version);
    if (version === null) {
      return refuse(
        "image_revision_template_ref_version_invalid",
        `templateRefs[${index}].version is "${String(raw.version)}"; a target version must be a positive integer (the template library's own version numbering). Omit it to revise the template's current version — an unreadable pin is never silently dropped in favour of "latest".`
      );
    }
    // The same triple the engine's own per-item ledger is keyed by (refKey,
    // imageTemplateRevisionEngine.ts). A duplicate is refused, never de-duplicated silently: the
    // editor named a template twice and the honest answer is to say so, not to guess which one to
    // drop — and letting both through makes one mint report as two successes.
    const refKey = `${surface}:${refTenantId}:${templateId}`;
    if (seenRefKeys.has(refKey)) {
      return refuse(
        "image_revision_template_ref_duplicate",
        `templateRefs[${index}] repeats "${templateId}" (surface "${surface}"), which an earlier entry already names. Each template may appear once: two entries for the same template would both read back the same published version and both be reported as a success, so one revision would read as two.`
      );
    }
    seenRefKeys.add(refKey);
    templateRefs.push({ surface: surface as "web" | "pdf", templateId, tenantId: refTenantId, ...(version !== undefined ? { version } : {}) });
  }

  // PLACEMENT IS VALIDATED, NOT PASSED THROUGH. computeTopRightImageBox spreads the brief's
  // placement over DEFAULT_IMAGE_PLACEMENT, so an unrecognised key — `widthMm` for `widthPt`, a
  // plausible unit slip — would be silently ignored and the image rendered at the default size:
  // the editor's stated dimension dropped with no refusal anywhere. Only ImagePlacementSpec's own
  // five keys are accepted, each at its own type; anything else refuses by name. (Out-of-range
  // numbers are still the engine's own per-item image_revision_geometry_invalid, which reports
  // against the actual page size this builder cannot see.)
  const PLACEMENT_NUMERIC_KEYS = ["widthPt", "heightPt", "marginPt", "headerReservePt"] as const;
  let placement: ImagePlacementSpec | undefined;
  if (source.placement !== undefined && source.placement !== null) {
    if (!isRecord(source.placement)) return refuse("image_revision_placement_invalid", `placement must be an object naming any of position, ${PLACEMENT_NUMERIC_KEYS.join(", ")}.`);
    const candidate: ImagePlacementSpec = {};
    for (const [key, value] of Object.entries(source.placement)) {
      if (key === "position") {
        if (value !== "top-right") {
          return refuse("image_revision_placement_invalid", `placement.position is "${String(value)}"; the only placement this engine implements today is "top-right" (a recurring header band on every page). Any other position is a named gap, not a value to approximate.`);
        }
        candidate.position = "top-right";
        continue;
      }
      if (!(PLACEMENT_NUMERIC_KEYS as readonly string[]).includes(key)) {
        return refuse("image_revision_placement_invalid", `placement.${key} is not a placement field. Accepted: position, ${PLACEMENT_NUMERIC_KEYS.join(", ")} — all dimensions in POINTS. An unrecognised key is refused rather than ignored, because ignoring it would render at the default size while the request said otherwise.`);
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return refuse("image_revision_placement_invalid", `placement.${key} is "${String(value)}"; every placement dimension must be a positive number of points.`);
      }
      candidate[key as (typeof PLACEMENT_NUMERIC_KEYS)[number]] = value;
    }
    placement = candidate;
  }
  const approve = readApprove(source.approve);
  if (approve === null) {
    return refuse("image_revision_approve_invalid", "approve must be true/false or an array of templateId strings naming exactly which previewed items may be applied.");
  }

  return {
    ok: true,
    // `approve` is carried through EXACTLY as dispatched, including absent: an absent approve leaves
    // every previewed item at "not_approved" in the apply stage's own ledger, which the terminal
    // report counts as a non-success (#337/D4). Defaulting it to true here would turn "the editor
    // asked to see it" into "the editor approved a publish", which is the one thing this pipeline's
    // gates exist to prevent.
    brief: { tenantId, sourceAsset, templateRefs, ...(placement ? { placement } : {}), ...(approve !== undefined ? { approve } : {}) }
  };
}
