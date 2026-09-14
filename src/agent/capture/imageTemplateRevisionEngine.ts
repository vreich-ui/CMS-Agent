// A9 — the image-on-every-page batch operation: image_template_revision.
//
// PIPELINE (task's own words): resolve source -> fetch target versions -> compile recurring-header
// image edit -> preview all variants -> approved per-version updates -> verify. This module is the
// deterministic engine; imageTemplateRevisionNodes.ts/imageTemplateRevisionWorkflow.ts compose it into
// a standalone workflow, dispatched through cloneConductorRoutes.ts's generic
// metadata.cloneStageDeterministic route exactly as A7's pdf_family_* stages are (see that module's
// own header) — zero change to executor.ts.
//
// REUSE, NOT REBUILD. The "approved per-version update" step below is pdfTemplateEngine.ts's OWN
// pdfTemplateMintStep / pdfTemplatePublishStep / depositPublishedPdfTemplatesStep, imported and
// called UNCHANGED — the identical functions A7 also composes. This module supplies them a
// deterministically-produced pdf_template_intake.v1 envelope and a synthetic "design" envelope of the
// SAME shape pdf_template_designer would produce; there is no creative judgment in "reserve a header
// band and place an image top-right, preserving aspect ratio" (the cost policy's own target: 0
// specialist LLM calls for a mechanical resize/placement), so no AI node exists in this workflow at
// all.
//
// WHY REVISION NEVER OVERWRITES. depositPublishedPdfTemplatesStep deposits into the cross-tenant
// TemplateLibraryStore (#207) under a templateId reconstructed as
// `${sourceProjectId}::pdf_template::${requestedId}`. This module sets `requestedId` to the EXACT
// suffix already present on the target templateRef's own templateId (deriveRequestedIdFromTemplateId,
// below) — so a revision reconstructs the SAME library templateId the caller named, and
// TemplateLibraryStore.publish()'s own content-hash versioning (never touched by this task) mints the
// NEXT immutable version rather than a new family member. Every earlier version stays reachable via
// getVersion(templateId, N); pdf-tool's own create_pdf_template always mints a fresh pdf-tool-side
// template underneath — this module never asks it to overwrite anything, and never touches the source
// image asset at all (resolveSourceImageStep is read-only).
//
// CHECKPOINTING. Both runImageRevisionCompilePreviewBatch and runImageRevisionApplyBatch accept an
// optional `priorItems` — the SAME node's own previous-attempt output, which
// imageTemplateRevisionRoutes-dispatch (cloneConductorRoutes.ts) reads back via
// run.stageOutputs[nodeId] before calling in. An item already at a terminal SUCCESS outcome, with an
// UNCHANGED input digest (contentDigest of the fields that could change its result), is carried
// forward verbatim — never recompiled, never re-previewed, never re-applied. Only new items or items
// that previously failed are (re)processed. This is what makes "one item fails" never force a
// re-render of the others on retry.
//
// ERRORS NEVER BECOME "ALL DONE". Every item's outcome is one of a fixed, named vocabulary
// (ImageRevisionItemOutcome, below); buildImageTemplateRevisionReportStep computes `partial`/
// `allFailed` FROM that ledger alone, the same discipline pdfTemplateFamilyEngine.ts's
// buildPdfTemplateFamilyReportStep already holds itself to — never asserted independently of it.
import { createHash } from "node:crypto";
import {
  pdfTemplateMintStep,
  pdfTemplatePublishStep,
  depositPublishedPdfTemplatesStep,
  PDF_TEMPLATE_ARTIFACTS,
  type PdfTemplateIntakeEntry,
  type PdfTemplateIntakeEnvelope,
  type PdfTemplateMintEnvelope,
  type PdfTemplatePublishEnvelope
} from "./pdfTemplateEngine.js";
import { TemplateLibraryStore } from "../library/templateLibraryStore.js";
import type { CloneDeps, LibraryDepositLedger } from "./cloneEngine.js";

export const IMAGE_REVISION_ARTIFACTS = {
  intake: "image_revision_intake.v1",
  compilePreview: "image_revision_compile_preview.v1",
  apply: "image_revision_apply.v1",
  report: "image_revision_report.v1"
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// A pure, order-independent digest of whatever fields could change an item's outcome — used ONLY to
// decide whether a checkpointed prior result is still valid to reuse, never persisted as an identity.
export function contentDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (isRecord(input)) {
      return Object.keys(input).sort().reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonical(input[key]);
        return acc;
      }, {});
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Geometry — pure, total, deterministic. No wire call, no tenant call, no model call.

export type PageSize = { widthPt: number; heightPt: number };
export const DEFAULT_PAGE_SIZE: PageSize = { widthPt: 595.28, heightPt: 841.89 }; // A4 portrait

export type SourceImageDimensions = { widthPx: number; heightPx: number };

export type ImagePlacementSpec = {
  position?: "top-right";
  widthPt?: number;
  heightPt?: number;
  marginPt?: number;
  headerReservePt?: number;
};

export const DEFAULT_IMAGE_PLACEMENT: Required<ImagePlacementSpec> = {
  position: "top-right",
  widthPt: 120,
  heightPt: 120,
  marginPt: 24,
  headerReservePt: 96
};

export type ComputedImageBox = { x: number; y: number; width: number; height: number };

// Scales `source` to fit inside `maxBox` without exceeding either dimension, preserving the source's
// own aspect ratio exactly (never stretched, never cropped).
export function computeAspectFitBox(source: SourceImageDimensions, maxBox: { width: number; height: number }): { width: number; height: number } {
  if (!(source.widthPx > 0) || !(source.heightPx > 0)) {
    throw new Error("computeAspectFitBox: source image dimensions must be positive.");
  }
  if (!(maxBox.width > 0) || !(maxBox.height > 0)) {
    throw new Error("computeAspectFitBox: placement box dimensions must be positive.");
  }
  const sourceAspect = source.widthPx / source.heightPx;
  const boxAspect = maxBox.width / maxBox.height;
  if (sourceAspect >= boxAspect) {
    const width = maxBox.width;
    return { width, height: width / sourceAspect };
  }
  const height = maxBox.height;
  return { width: height * sourceAspect, height };
}

export function computeTopRightImageBox(input: { pageSize: PageSize; source: SourceImageDimensions; placement?: ImagePlacementSpec }): {
  box: ComputedImageBox;
  headerReservePt: number;
  marginPt: number;
  maxWidthPt: number;
  maxHeightPt: number;
} {
  const spec = { ...DEFAULT_IMAGE_PLACEMENT, ...input.placement };
  const fitted = computeAspectFitBox(input.source, { width: spec.widthPt, height: spec.heightPt });
  const x = input.pageSize.widthPt - spec.marginPt - fitted.width;
  const y = spec.marginPt;
  return { box: { x, y, width: fitted.width, height: fitted.height }, headerReservePt: spec.headerReservePt, marginPt: spec.marginPt, maxWidthPt: spec.widthPt, maxHeightPt: spec.heightPt };
}

export type CompiledPageManifestEntry = { pageIndex: number; imagePlaced: true; imageBox: ComputedImageBox; shiftedFieldNames: string[] };

export type CompiledTemplateEdit = {
  templateJson: Record<string, unknown>;
  pages: CompiledPageManifestEntry[];
  imageFieldNamePrefix: string;
  headerReservePt: number;
};

export type CompileEditFailure = { ok: false; code: string; reason: string };
export type CompileEditResult = { ok: true; edit: CompiledTemplateEdit } | CompileEditFailure;

// Places `sourceImageRef` top-right on EVERY page of a pdfme `schemas` array, reserving a header band
// (headerReservePt) across every page by shifting any existing field whose y falls inside that band
// down by exactly headerReservePt — so reserving the header never collides with what was already
// there. Never mutates `templateJson`; always returns a fresh object/array tree.
export function compileRecurringHeaderImageEdit(input: {
  templateJson: unknown;
  pageSize: PageSize;
  source: SourceImageDimensions;
  sourceImageRef: string;
  placement?: ImagePlacementSpec;
  imageFieldNamePrefix?: string;
}): CompileEditResult {
  const templateJson = isRecord(input.templateJson) ? input.templateJson : undefined;
  const schemas = templateJson && Array.isArray(templateJson.schemas) ? (templateJson.schemas as unknown[]) : undefined;
  if (!templateJson || !schemas) {
    return { ok: false, code: "image_revision_unsupported_renderer", reason: "This operation places images only on pdfme templates (a \"schemas\" array); the target template's stored recipe carries none." };
  }
  if (schemas.length === 0) {
    return { ok: false, code: "image_revision_no_pages", reason: "The target template's schemas array has zero pages; there is nowhere to place a recurring image." };
  }
  let geometry: ReturnType<typeof computeTopRightImageBox>;
  try {
    geometry = computeTopRightImageBox({ pageSize: input.pageSize, source: input.source, placement: input.placement });
  } catch (error) {
    return { ok: false, code: "image_revision_geometry_invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  const { box, headerReservePt } = geometry;
  const imageFieldNamePrefix = input.imageFieldNamePrefix ?? "image_revision_header";
  const pages: CompiledPageManifestEntry[] = [];
  const newSchemas = schemas.map((rawPage, pageIndex) => {
    const page = Array.isArray(rawPage) ? rawPage : [];
    const shiftedFieldNames: string[] = [];
    const shiftedFields = page.map((rawField, fieldIndex) => {
      if (!isRecord(rawField) || !isRecord(rawField.position) || typeof rawField.position.y !== "number") return rawField;
      const y = rawField.position.y;
      if (y >= headerReservePt) return rawField;
      const name = nonEmptyString(rawField.name) ? rawField.name : `field_${pageIndex}_${fieldIndex}`;
      shiftedFieldNames.push(name);
      return { ...rawField, position: { ...rawField.position, y: y + headerReservePt } };
    });
    const imageField = {
      name: `${imageFieldNamePrefix}_p${pageIndex + 1}`,
      type: "image",
      content: input.sourceImageRef,
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height
    };
    pages.push({ pageIndex, imagePlaced: true, imageBox: box, shiftedFieldNames });
    return [...shiftedFields, imageField];
  });
  return { ok: true, edit: { templateJson: { ...templateJson, schemas: newSchemas }, pages, imageFieldNamePrefix, headerReservePt } };
}

// ---------------------------------------------------------------------------------------------
// Source resolution. Never guesses: multiple/zero matches on a tag is a named blocker, never a
// silent pick. A captureRequestId is used strictly as PROVENANCE to resolve an asset — never mapped
// to an article or any content_item (A5's own discipline, restated here because this module cannot
// depend on A5's own executor, which does not exist yet — see this task's report for that gap).

export type SourceAssetRef = { tag?: string; checksum?: string; captureRequestId?: string };

export type ResolvedSourceAsset = {
  assetId: string;
  checksum: string;
  tags: string[];
  widthPx: number;
  heightPx: number;
  reference: string;
  provenance: { captureRequestId?: string | null };
};

export type AssetCatalogSource = {
  resolveByTag: (tenantId: string, tag: string) => Promise<ResolvedSourceAsset[]>;
  resolveByChecksum: (tenantId: string, checksum: string) => Promise<ResolvedSourceAsset | undefined>;
  resolveByCaptureRequestId: (tenantId: string, captureRequestId: string) => Promise<ResolvedSourceAsset | undefined>;
};

export type ResolveSourceImageResult = { ok: true; asset: ResolvedSourceAsset } | { ok: false; code: string; reason: string };

export async function resolveSourceImageStep(input: { tenantId: string; ref: SourceAssetRef }, deps: { assetCatalog: AssetCatalogSource }): Promise<ResolveSourceImageResult> {
  const { tenantId, ref } = input;
  if (!nonEmptyString(ref.tag) && !nonEmptyString(ref.checksum) && !nonEmptyString(ref.captureRequestId)) {
    return { ok: false, code: "image_revision_source_ref_missing", reason: "sourceAsset must supply at least one of tag, checksum, or captureRequestId to resolve a trusted image." };
  }
  if (nonEmptyString(ref.checksum)) {
    const found = await deps.assetCatalog.resolveByChecksum(tenantId, ref.checksum);
    if (!found) return { ok: false, code: "image_revision_source_checksum_not_found", reason: `No asset with checksum "${ref.checksum}" found for tenant "${tenantId}".` };
    return { ok: true, asset: found };
  }
  if (nonEmptyString(ref.tag)) {
    const matches = await deps.assetCatalog.resolveByTag(tenantId, ref.tag);
    if (matches.length === 0) return { ok: false, code: "image_revision_source_tag_not_found", reason: `No asset tagged "${ref.tag}" found for tenant "${tenantId}".` };
    if (matches.length > 1) {
      return {
        ok: false,
        code: "image_revision_source_tag_ambiguous",
        reason: `${matches.length} assets are tagged "${ref.tag}" for tenant "${tenantId}"; supply a checksum (or a capture request id) to disambiguate rather than guessing.`
      };
    }
    return { ok: true, asset: matches[0] };
  }
  const found = await deps.assetCatalog.resolveByCaptureRequestId(tenantId, ref.captureRequestId!);
  if (!found) return { ok: false, code: "image_revision_source_capture_request_not_found", reason: `No asset with capture request "${ref.captureRequestId}" found for tenant "${tenantId}"; a capture request is provenance for an asset, never a content item.` };
  return { ok: true, asset: found };
}

// ---------------------------------------------------------------------------------------------
// Target template versions. "pdf" surface only today — see this module's report for why "web" is a
// named, honest capability gap rather than a silent mis-handling.

export type TargetTemplateRef = { surface: "web" | "pdf"; templateId: string; tenantId: string; version?: number };

export type FetchedTemplateVersion = { templateId: string; version: number; objectType: string; recipe: Record<string, unknown>; pageSize: PageSize; pageCount: number; sourceUrl?: string | null };

export type FetchTargetResult = { ok: true; template: FetchedTemplateVersion } | { ok: false; code: string; reason: string };

function resolvePageSizeFromRecipe(recipe: Record<string, unknown>): PageSize {
  const pageSize = isRecord(recipe.pageSize) ? recipe.pageSize : undefined;
  if (pageSize && typeof pageSize.widthPt === "number" && typeof pageSize.heightPt === "number") {
    return { widthPt: pageSize.widthPt, heightPt: pageSize.heightPt };
  }
  return DEFAULT_PAGE_SIZE;
}

export async function fetchTargetTemplateVersionStep(ref: TargetTemplateRef, deps: { templateLibraryStore: TemplateLibraryStore }): Promise<FetchTargetResult> {
  if (ref.surface !== "pdf") {
    return {
      ok: false,
      code: "image_revision_surface_unsupported",
      reason: `Surface "${ref.surface}" is not yet implemented by image_template_revision; only "pdf" targets are supported today (A9). This is a named capability gap, not a silent skip.`
    };
  }
  const record = ref.version ? await deps.templateLibraryStore.getVersion(ref.templateId, ref.version) : await deps.templateLibraryStore.getLatest(ref.templateId);
  if (!record) {
    return { ok: false, code: "image_revision_template_not_found", reason: `No ${ref.version ? `version ${ref.version} of ` : ""}template "${ref.templateId}" found in the template library for tenant "${ref.tenantId}".` };
  }
  const pageSize = resolvePageSizeFromRecipe(record.recipe);
  const pageCount = Array.isArray(record.recipe.schemas) ? (record.recipe.schemas as unknown[]).length : 0;
  // The revision's own mint/publish/deposit reuses pdfTemplateEngine.ts's stages UNCHANGED, and
  // depositPublishedPdfTemplatesStep refuses (never coerces) a "demand"-driven deposit with no
  // sourceUrl (templateProvenance.ts's own rule, ADR §4.1 — "a template whose provenance cannot be
  // stated is not publishable"). A revision is not a new document — it inherits the SAME provenance
  // the target template's own current library record already states, carried through here so
  // runImageRevisionApplyBatch can state it on the synthetic intake entry it builds. Without this, a
  // revision's own library deposit would be silently refused every time, and the "next immutable
  // version" this module's header promises would never actually land in the cross-tenant library —
  // named here explicitly rather than left to be discovered as a gap during acceptance testing.
  return { ok: true, template: { templateId: record.templateId, version: record.version, objectType: record.objectType, recipe: record.recipe, pageSize, pageCount, sourceUrl: record.provenance?.sourceUrl ?? null } };
}

// The templateId a library record carries is `${sourceProjectId}::pdf_template::${requestedId}`
// (pdfTemplateEngine.ts's buildPdfTemplateId, mirrored here read-only — never re-implemented as a
// write path). Deriving requestedId by stripping that exact prefix is what makes a revision
// reconstruct the SAME library templateId rather than minting an unrelated one.
export function deriveRequestedIdFromTemplateId(templateId: string, sourceProjectId: string): string | undefined {
  const prefix = `${sourceProjectId}::pdf_template::`;
  return templateId.startsWith(prefix) ? templateId.slice(prefix.length) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Injected preview/verify — production wires these to Platform's A8 template-preview /
// document-content-check path over the trusted bridge (packages/core/lib/pdf/template-preview.ts,
// document-render.ts — PR #752). Never implemented in this module; a request that needs one without
// it supplied is a named blocker, never a silent skip — the same discipline
// visualIdentityReviewChangeExecutor.ts holds for proposeVisualIdentity/materializeVisualStandard.

export type PreviewTemplateVariantFn = (input: {
  templateId: string;
  beforeVersion: number;
  beforeTemplateJson: Record<string, unknown>;
  afterTemplateJson: Record<string, unknown>;
  pageCount: number;
}) => Promise<{ beforeRef: string; afterRef: string }>;

export type VerifyImagePresenceFn = (input: { templateId: string; version: number; pageCount: number; imageFieldNamePrefix: string }) => Promise<{ pagesWithImage: number[]; pagesMissingImage: number[] }>;

// ---------------------------------------------------------------------------------------------
// Per-item ledger — the fixed outcome vocabulary. Never any other string, so a caller (and
// buildImageTemplateRevisionReportStep) pattern-matches this exhaustively.
export type ImageRevisionItemOutcome =
  | "source_resolve_failed"
  | "target_fetch_failed"
  | "compile_failed"
  | "preview_failed"
  | "previewed"
  | "not_approved"
  | "mint_rejected"
  | "publish_failed"
  | "verify_failed"
  | "verified";

const FAILURE_OUTCOMES: ReadonlySet<ImageRevisionItemOutcome> = new Set(["source_resolve_failed", "target_fetch_failed", "compile_failed", "preview_failed", "mint_rejected", "publish_failed", "verify_failed"]);
const SUCCESS_OUTCOMES: ReadonlySet<ImageRevisionItemOutcome> = new Set(["previewed", "not_approved", "verified"]);

export type ImageRevisionItemLedgerEntry = {
  templateRef: TargetTemplateRef;
  outcome: ImageRevisionItemOutcome;
  detail?: string;
  inputDigest: string;
  beforeVersion?: number;
  afterVersion?: number;
  pageCount?: number;
  pages?: CompiledPageManifestEntry[];
  beforeRef?: string;
  afterRef?: string;
  pagesMissingImage?: number[];
};

const refKey = (ref: TargetTemplateRef): string => `${ref.surface}:${ref.tenantId}:${ref.templateId}${ref.version ? `@${ref.version}` : ""}`;

// ---------------------------------------------------------------------------------------------
// Stage 1 — intake: resolve the source image once, then fetch every target's CURRENT version. Named,
// per-item errors never abort the batch: an item whose target cannot be fetched is still named in
// the ledger, at "target_fetch_failed", not silently dropped.

export type ImageRevisionIntakeItem = { templateRef: TargetTemplateRef; current?: FetchedTemplateVersion; error?: { code: string; reason: string } };

export type ImageRevisionIntakeEnvelope = {
  artifact: typeof IMAGE_REVISION_ARTIFACTS.intake;
  summary: string;
  tenantId: string | null;
  sourceAsset: ResolvedSourceAsset | null;
  sourceAssetError: { code: string; reason: string } | null;
  placement: ImagePlacementSpec;
  items: ImageRevisionIntakeItem[];
};

export type ImageTemplateRevisionBrief = {
  tenantId?: string;
  sourceAsset?: SourceAssetRef;
  templateRefs?: TargetTemplateRef[];
  placement?: ImagePlacementSpec;
  approve?: boolean | string[];
};

export async function imageRevisionIntakeStep(
  input: { initialInput: unknown },
  deps: { assetCatalog: AssetCatalogSource; templateLibraryStore?: TemplateLibraryStore }
): Promise<ImageRevisionIntakeEnvelope> {
  const initial = isRecord(input.initialInput) ? input.initialInput : {};
  const brief = isRecord(initial.imageTemplateRevisionBrief) ? (initial.imageTemplateRevisionBrief as ImageTemplateRevisionBrief) : undefined;
  const empty = (summary: string, tenantId: string | null = null): ImageRevisionIntakeEnvelope => ({
    artifact: IMAGE_REVISION_ARTIFACTS.intake,
    summary,
    tenantId,
    sourceAsset: null,
    sourceAssetError: null,
    placement: {},
    items: []
  });
  if (!brief) return empty("No imageTemplateRevisionBrief on this run's initialInput; there is no image-template-revision work for this run.");

  const tenantId = nonEmptyString(brief.tenantId) ? brief.tenantId.trim() : undefined;
  if (!tenantId) return empty("imageTemplateRevisionBrief.tenantId is missing or empty; every asset/template lookup is tenant-scoped.");

  const templateRefs = Array.isArray(brief.templateRefs) ? brief.templateRefs : [];
  if (templateRefs.length === 0) return empty("imageTemplateRevisionBrief.templateRefs is empty; nothing to revise.", tenantId);

  const sourceResolution = await resolveSourceImageStep({ tenantId, ref: brief.sourceAsset ?? {} }, deps);
  const sourceAsset = sourceResolution.ok ? sourceResolution.asset : null;
  const sourceAssetError = sourceResolution.ok ? null : { code: sourceResolution.code, reason: sourceResolution.reason };

  const store = deps.templateLibraryStore ?? new TemplateLibraryStore();
  const items: ImageRevisionIntakeItem[] = [];
  for (const templateRef of templateRefs) {
    const fetched = await fetchTargetTemplateVersionStep(templateRef, { templateLibraryStore: store });
    if (fetched.ok) items.push({ templateRef, current: fetched.template });
    else items.push({ templateRef, error: { code: fetched.code, reason: fetched.reason } });
  }

  return {
    artifact: IMAGE_REVISION_ARTIFACTS.intake,
    summary: `image_template_revision intake for tenant "${tenantId}": source asset ${sourceAsset ? `resolved (assetId "${sourceAsset.assetId}")` : `NOT resolved (${sourceAssetError?.code})`}; ${items.filter((item) => item.current).length}/${items.length} target template(s) fetched.`,
    tenantId,
    sourceAsset,
    sourceAssetError,
    placement: brief.placement ?? {},
    items
  };
}

// ---------------------------------------------------------------------------------------------
// Stage 2 — compile + preview, per item, checkpointed against `priorItems`.

export type ImageRevisionCompilePreviewEnvelope = {
  artifact: typeof IMAGE_REVISION_ARTIFACTS.compilePreview;
  summary: string;
  items: ImageRevisionItemLedgerEntry[];
};

function carryForward(prior: ImageRevisionItemLedgerEntry | undefined, digest: string): ImageRevisionItemLedgerEntry | undefined {
  if (!prior) return undefined;
  if (prior.inputDigest !== digest) return undefined; // stale — the source/target/placement changed since the prior attempt
  if (!SUCCESS_OUTCOMES.has(prior.outcome) && prior.outcome !== "previewed") return undefined;
  return prior;
}

export async function runImageRevisionCompilePreviewBatch(
  intake: ImageRevisionIntakeEnvelope,
  deps: { previewTemplateVariant?: PreviewTemplateVariantFn },
  priorItems: ImageRevisionItemLedgerEntry[] = []
): Promise<ImageRevisionCompilePreviewEnvelope> {
  const priorByKey = new Map(priorItems.map((entry) => [refKey(entry.templateRef), entry]));
  const items: ImageRevisionItemLedgerEntry[] = [];

  for (const item of intake.items) {
    const digest = contentDigest({ sourceAsset: intake.sourceAsset, ref: item.templateRef, placement: intake.placement, currentVersion: item.current?.version });
    const carried = carryForward(priorByKey.get(refKey(item.templateRef)), digest);
    if (carried && carried.outcome === "previewed") {
      items.push(carried); // checkpoint: a successful preview is never re-rendered on retry.
      continue;
    }

    if (item.error) {
      items.push({ templateRef: item.templateRef, outcome: "target_fetch_failed", detail: item.error.reason, inputDigest: digest });
      continue;
    }
    if (!intake.sourceAsset) {
      items.push({ templateRef: item.templateRef, outcome: "source_resolve_failed", detail: intake.sourceAssetError?.reason ?? "Source image was not resolved.", inputDigest: digest });
      continue;
    }
    const current = item.current!;
    const compiled = compileRecurringHeaderImageEdit({
      templateJson: current.recipe,
      pageSize: current.pageSize,
      source: { widthPx: intake.sourceAsset.widthPx, heightPx: intake.sourceAsset.heightPx },
      sourceImageRef: intake.sourceAsset.reference,
      placement: intake.placement
    });
    if (!compiled.ok) {
      items.push({ templateRef: item.templateRef, outcome: "compile_failed", detail: compiled.reason, inputDigest: digest, beforeVersion: current.version, pageCount: current.pageCount });
      continue;
    }
    if (!deps.previewTemplateVariant) {
      items.push({
        templateRef: item.templateRef,
        outcome: "preview_failed",
        detail: "No previewTemplateVariant dependency was supplied; production wires this to Platform's A8 template-preview path (packages/core/lib/pdf/template-preview.ts). Never rendered without it.",
        inputDigest: digest,
        beforeVersion: current.version,
        pageCount: current.pageCount,
        pages: compiled.edit.pages
      });
      continue;
    }
    try {
      const preview = await deps.previewTemplateVariant({
        templateId: current.templateId,
        beforeVersion: current.version,
        beforeTemplateJson: current.recipe,
        afterTemplateJson: compiled.edit.templateJson,
        pageCount: current.pageCount
      });
      items.push({
        templateRef: item.templateRef,
        outcome: "previewed",
        inputDigest: digest,
        beforeVersion: current.version,
        pageCount: current.pageCount,
        pages: compiled.edit.pages,
        beforeRef: preview.beforeRef,
        afterRef: preview.afterRef
      });
    } catch (error) {
      items.push({
        templateRef: item.templateRef,
        outcome: "preview_failed",
        detail: error instanceof Error ? error.message : String(error),
        inputDigest: digest,
        beforeVersion: current.version,
        pageCount: current.pageCount,
        pages: compiled.edit.pages
      });
    }
  }

  const previewed = items.filter((entry) => entry.outcome === "previewed").length;
  return { artifact: IMAGE_REVISION_ARTIFACTS.compilePreview, summary: `image_template_revision compile+preview: ${previewed}/${items.length} item(s) previewed.`, items };
}

// ---------------------------------------------------------------------------------------------
// Stage 3 — approved per-version update + verify, per item, checkpointed against `priorItems`.
// Reuses pdfTemplateMintStep/pdfTemplatePublishStep/depositPublishedPdfTemplatesStep UNCHANGED — see
// this module's header.

const isApproved = (approve: boolean | string[] | undefined, templateId: string): boolean => (approve === true ? true : Array.isArray(approve) ? approve.includes(templateId) : false);

export type ImageRevisionApplyEnvelope = {
  artifact: typeof IMAGE_REVISION_ARTIFACTS.apply;
  summary: string;
  items: ImageRevisionItemLedgerEntry[];
  library?: LibraryDepositLedger;
};

export async function runImageRevisionApplyBatch(
  input: { targetProjectId: string; intake: ImageRevisionIntakeEnvelope; compiled: ImageRevisionCompilePreviewEnvelope; approve?: boolean | string[] },
  deps: CloneDeps & { verifyImagePresence?: VerifyImagePresenceFn; templateLibraryStore?: TemplateLibraryStore },
  priorItems: ImageRevisionItemLedgerEntry[] = []
): Promise<ImageRevisionApplyEnvelope> {
  const priorByKey = new Map(priorItems.map((entry) => [refKey(entry.templateRef), entry]));
  const currentByKey = new Map(input.intake.items.map((item) => [refKey(item.templateRef), item]));
  const items: ImageRevisionItemLedgerEntry[] = [];
  const toApply: Array<{ compiled: ImageRevisionItemLedgerEntry; requestedId: string; templateJson: Record<string, unknown>; imageFieldNamePrefix: string; sourceUrl?: string | null }> = [];

  for (const entry of input.compiled.items) {
    const digest = contentDigest({ entry, approve: input.approve });
    const carried = carryForward(priorByKey.get(refKey(entry.templateRef)), digest);
    if (carried && carried.outcome === "verified") {
      items.push(carried); // checkpoint: a verified item is never re-applied on retry.
      continue;
    }
    if (entry.outcome !== "previewed") {
      items.push({ ...entry, inputDigest: digest }); // carry the upstream failure through, unchanged outcome.
      continue;
    }
    if (!isApproved(input.approve, entry.templateRef.templateId)) {
      items.push({ ...entry, outcome: "not_approved", detail: "Previewed but not named in this run's approve list; nothing was applied.", inputDigest: digest });
      continue;
    }
    const requestedId = deriveRequestedIdFromTemplateId(entry.templateRef.templateId, input.targetProjectId);
    if (!requestedId) {
      items.push({ ...entry, outcome: "mint_rejected", detail: `templateId "${entry.templateRef.templateId}" is not shaped as "${input.targetProjectId}::pdf_template::<id>"; cannot derive a revision request for it.`, inputDigest: digest });
      continue;
    }
    const item = currentByKey.get(refKey(entry.templateRef));
    const compiledEdit = item?.current
      ? compileRecurringHeaderImageEdit({
          templateJson: item.current.recipe,
          pageSize: item.current.pageSize,
          source: input.intake.sourceAsset ? { widthPx: input.intake.sourceAsset.widthPx, heightPx: input.intake.sourceAsset.heightPx } : { widthPx: 1, heightPx: 1 },
          sourceImageRef: input.intake.sourceAsset?.reference ?? "",
          placement: input.intake.placement
        })
      : undefined;
    if (!compiledEdit || !compiledEdit.ok) {
      items.push({ ...entry, outcome: "compile_failed", detail: compiledEdit && !compiledEdit.ok ? compiledEdit.reason : "Could not recompile the approved edit for apply.", inputDigest: digest });
      continue;
    }
    toApply.push({ compiled: entry, requestedId, templateJson: compiledEdit.edit.templateJson, imageFieldNamePrefix: compiledEdit.edit.imageFieldNamePrefix, sourceUrl: item?.current?.sourceUrl ?? undefined });
  }

  if (toApply.length === 0) {
    return { artifact: IMAGE_REVISION_ARTIFACTS.apply, summary: `image_template_revision apply: 0 item(s) to mint (0 approved-and-previewed).`, items };
  }

  const siteId = input.intake.tenantId;
  const intakeEnvelope: PdfTemplateIntakeEnvelope = {
    artifact: PDF_TEMPLATE_ARTIFACTS.intake,
    summary: `Synthetic intake for image_template_revision's approved updates.`,
    siteId,
    entries: toApply.map(
      (entry): PdfTemplateIntakeEntry => ({ requestedId: entry.requestedId, name: entry.requestedId, renderer: "pdfme", tags: [], sourceUrl: entry.sourceUrl ?? undefined, purpose: "image_template_revision" })
    ),
    rejectedEntries: []
  };
  const designEnvelope = { designs: toApply.map((entry) => ({ requestedId: entry.requestedId, name: entry.requestedId, renderer: "pdfme", templateJson: entry.templateJson })) };

  const mint: PdfTemplateMintEnvelope = await pdfTemplateMintStep({ targetProjectId: input.targetProjectId, intake: intakeEnvelope, design: designEnvelope }, deps);
  const publish: PdfTemplatePublishEnvelope = await pdfTemplatePublishStep({ targetProjectId: input.targetProjectId, mint }, deps);
  const library = publish.published.length > 0 ? await depositPublishedPdfTemplatesStep({ sourceProjectId: input.targetProjectId, mint, published: publish.published }, deps) : undefined;

  const mintRejectedById = new Map(mint.rejected.map((entry) => [entry.requestedId, entry]));
  const publishedById = new Map(publish.published.map((entry) => [entry.requestedId, entry]));
  const publishFailedById = new Map(publish.failed.map((entry) => [entry.requestedId, entry]));

  for (const attempt of toApply) {
    const digest = contentDigest({ entry: attempt.compiled, approve: input.approve });
    const rejection = mintRejectedById.get(attempt.requestedId);
    if (rejection) {
      items.push({ ...attempt.compiled, outcome: "mint_rejected", detail: rejection.reason, inputDigest: digest });
      continue;
    }
    const published = publishedById.get(attempt.requestedId);
    if (!published) {
      const failure = publishFailedById.get(attempt.requestedId);
      items.push({ ...attempt.compiled, outcome: "publish_failed", detail: failure?.reason ?? "No publish outcome recorded for this variant.", inputDigest: digest });
      continue;
    }
    if (!deps.verifyImagePresence) {
      items.push({
        ...attempt.compiled,
        outcome: "verify_failed",
        detail: "No verifyImagePresence dependency was supplied; production wires this to Platform's A8 document-content-check path. Never verified without it.",
        inputDigest: digest,
        afterVersion: published.version
      });
      continue;
    }
    try {
      const verification = await deps.verifyImagePresence({ templateId: published.templateId, version: published.version, pageCount: attempt.compiled.pageCount ?? 0, imageFieldNamePrefix: attempt.imageFieldNamePrefix });
      if (verification.pagesMissingImage.length > 0) {
        items.push({
          ...attempt.compiled,
          outcome: "verify_failed",
          detail: `Image missing on page(s) ${verification.pagesMissingImage.join(", ")} of "${published.templateId}" v${published.version}.`,
          inputDigest: digest,
          afterVersion: published.version,
          pagesMissingImage: verification.pagesMissingImage
        });
        continue;
      }
      items.push({ ...attempt.compiled, outcome: "verified", inputDigest: digest, afterVersion: published.version, pagesMissingImage: [] });
    } catch (error) {
      items.push({ ...attempt.compiled, outcome: "verify_failed", detail: error instanceof Error ? error.message : String(error), inputDigest: digest, afterVersion: published.version });
    }
  }

  const verified = items.filter((entry) => entry.outcome === "verified").length;
  return { artifact: IMAGE_REVISION_ARTIFACTS.apply, summary: `image_template_revision apply: ${verified}/${toApply.length} approved item(s) verified.`, items, library };
}

// ---------------------------------------------------------------------------------------------
// Stage 4 — terminal report. Every templateRef this run named, exactly once, with its FINAL
// outcome (apply's, when it reached apply; else compile+preview's; else intake's own fetch error) —
// never dropped, never duplicated, never merged into a false "all done".

export type ImageTemplateRevisionReport = {
  artifact: typeof IMAGE_REVISION_ARTIFACTS.report;
  summary: string;
  tenantId: string | null;
  sourceAsset: ResolvedSourceAsset | null;
  items: ImageRevisionItemLedgerEntry[];
  library?: LibraryDepositLedger;
  partial: boolean;
  allFailed: boolean;
};

export function buildImageTemplateRevisionReportStep(input: { intake: ImageRevisionIntakeEnvelope; compiled?: ImageRevisionCompilePreviewEnvelope; applied?: ImageRevisionApplyEnvelope }): ImageTemplateRevisionReport {
  const appliedByKey = new Map((input.applied?.items ?? []).map((entry) => [refKey(entry.templateRef), entry]));
  const compiledByKey = new Map((input.compiled?.items ?? []).map((entry) => [refKey(entry.templateRef), entry]));

  const items: ImageRevisionItemLedgerEntry[] = input.intake.items.map((item) => {
    const key = refKey(item.templateRef);
    const applied = appliedByKey.get(key);
    if (applied) return applied;
    const compiled = compiledByKey.get(key);
    if (compiled) return compiled;
    return {
      templateRef: item.templateRef,
      outcome: item.error ? "target_fetch_failed" : "source_resolve_failed",
      detail: item.error?.reason ?? "No compile/preview outcome recorded for this variant; the run did not reach a decision.",
      inputDigest: contentDigest({ item })
    };
  });

  const succeeded = items.filter((entry) => SUCCESS_OUTCOMES.has(entry.outcome)).length;
  const failed = items.filter((entry) => FAILURE_OUTCOMES.has(entry.outcome)).length;

  return {
    artifact: IMAGE_REVISION_ARTIFACTS.report,
    summary: `image_template_revision for tenant "${input.intake.tenantId ?? "(none)"}": ${succeeded} item(s) succeeded, ${failed} failed, of ${items.length} named.`,
    tenantId: input.intake.tenantId,
    sourceAsset: input.intake.sourceAsset,
    items,
    library: input.applied?.library,
    partial: succeeded > 0 && failed > 0,
    allFailed: items.length > 0 && succeeded === 0
  };
}
