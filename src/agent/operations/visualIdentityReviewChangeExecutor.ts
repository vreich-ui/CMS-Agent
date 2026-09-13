// visual_identity_review_change — THE EXECUTOR (A6). The catalog descriptor
// (descriptors/visualIdentityReviewChange.ts) is a CONTRACT ONLY; this module is what actually runs
// it, composed entirely from the A2/A4 kernel (siteContext.ts, candidates.ts, changeSet.ts,
// scopedApproval.ts) plus the two pieces C5 already shipped that this task must NOT rebuild:
// brand_imagery_writer (the one vision-model judgment) and visual_standard_materializer (the
// deterministic save/apply). Composing those two by hand in a chat turn instead of through one
// operation is the exact failure mode this task exists to close — every write this module can cause
// is delegated to an injected function standing in for one of those two reused pieces; this module
// itself performs zero tenant calls.
//
// THE COMPOSED FLOW: snapshot -> (inferred brief, only when asked) -> visual proposal (injected;
// production wires brand_imagery_writer) -> contract-valid candidate (candidates.ts) -> exact diff
// (changeSet.ts) -> authorized save/apply (scopedApproval.ts + the injected materializer) ->
// effective-state readback (the materializer's own post-apply fields, hash-compared here against
// what was actually proposed — never trusted on the materializer's own `applied: true` alone).
//
// WHAT THIS MODULE NEVER DOES. It never calls object_publish or release_to_production for
// visual_standard (not a publishable type — publishableTypeCharter.ts) or for anything else; the
// only "released" signal this module ever reports is a record's own publishedTime, read verbatim off
// the snapshot, never inferred from version/content_revision (a save counter) or assumed from an
// apply merely having been attempted. This is the module built to get the Zilberman shape right:
// version 4, content_revision 2, published_time null — saved four times over, applied not once — and
// this module has no way to report that record as anything but saved-not-applied absent real apply
// evidence produced by THIS run.
//
// HOUSE VS NAMED, AND WHY NEITHER ID IS EVER INVENTED. `visual_standard` records are told apart by
// the snapshot's OWN registries (SiteRegistries.visualStandards: {id, kind, label}) — a "house"
// entry and a template/campaign entry are different records with different lifecycles, and this
// module never conflates a review of one with a change to the other. The same discipline governs
// `theme`: a themeId is only ever the id of a REAL theme record this snapshot actually returned,
// never a caller- or model-supplied string taken on faith and never assembled from a prefix. Both
// resolvers below (resolveVisualStandardTarget, resolveRecordTarget) return `objectId: null` — an
// EMPTY, VALID initial state, not an error — when nothing real matches.
//
// LORA REGISTRATION IS NOT AN IMAGE EFFECT. A brand-imagery proposal may touch two different object
// types: `visual_standard` (the identity fields every generated image is actually rendered against)
// and, separately, `image_model_config` (registering the LoRA weights themselves). Registering a
// model is bookkeeping, not evidence that any image changed — classifyImageEffect below is the one
// place that distinction is drawn, and it draws it from the DIFF, never from which object type
// happened to be written.
//
// SCOPE BOUNDARY (stated, not hidden): `focus: "theme"` reports the tenant's theme record (existence,
// save/release state) but does not propose a theme content change — there is no reviewed, reusable
// "theme writer" analogous to brand_imagery_writer to compose here yet. Extending this to an actual
// theme proposal is future work; inventing one under this task would be exactly the "rebuild instead
// of reuse" mistake this task exists to avoid.
import { getSiteSnapshot, type SiteContextObject, type SiteContextSource, type SiteSnapshot } from "./siteContext.js";
import { compileCandidate, type Candidate } from "./candidates.js";
import { computeChangeSet, type ChangeSet } from "./changeSet.js";
import { authorizeEffects, type ScopedApproval } from "./scopedApproval.js";
import { contentDigest } from "./contentHash.js";
import type { OperationBlocker } from "./operationTypes.js";

export const VISUAL_STANDARD_OBJECT_TYPE = "visual_standard";
export const THEME_OBJECT_TYPE = "theme";
export const IMAGE_MODEL_CONFIG_OBJECT_TYPE = "image_model_config";

export type VisualIdentityFocus = "imagery" | "color" | "theme" | "full_review";
export type VisualIdentityMode = "house" | "template";

export type VisualIdentityReviewChangeInput = {
  tenantId: string;
  focus?: VisualIdentityFocus;
  mode?: VisualIdentityMode;
  templateSlug?: string;
  visualStandardId?: string;
  imageModelConfigId?: string;
  themeId?: string;
  references?: Array<Record<string, unknown>>;
  brief?: string;
  // The "no-board" path: work from the tenant's own current content instead of a supplied mood
  // board. Only consulted when neither references nor brief was supplied — a caller-supplied board
  // always wins.
  workFromSiteContent?: boolean;
  // A preview creates nothing: it computes and returns every proposal/diff below, but the save and
  // apply steps are never invoked, authorized or not.
  preview?: boolean;
  apply?: boolean;
  // Plural: a combined review may compile more than one change set (visual_standard AND
  // image_model_config), and scopedApproval.ts's ScopedApproval is scoped to exactly one
  // changeSetId — one approval cannot straddle two targets by design, so a caller authorizing both
  // supplies both.
  approvals?: ScopedApproval[];
};

// What the (injected) proposal step returns. `visualStandardFields` / `imageModelConfigFields` are
// each, when present, a COMPLETE candidate body for that object type — the same "whole object,
// required fields included" shape candidates.ts already validates against, never a partial patch —
// so the applied-hash comparison later in this module compares like with like.
export type VisualIdentityProposalLike = {
  label?: string;
  rationale?: string;
  visualStandardFields?: Record<string, unknown>;
  imageModelConfigFields?: Record<string, unknown>;
};

export type ProposeVisualIdentityParams = {
  tenantId: string;
  mode: VisualIdentityMode;
  templateSlug?: string;
  references?: Array<Record<string, unknown>>;
  brief: string;
  existingVisualStandardFields?: Record<string, unknown>;
  existingImageModelConfigFields?: Record<string, unknown>;
};
// Production wires this to the reused brand_imagery_writer node (visual_identity.propose /
// nodeRuntime.executeNode) — see this module's own header. Never implemented in this file.
export type ProposeVisualIdentityFn = (params: ProposeVisualIdentityParams) => Promise<VisualIdentityProposalLike>;

export type MaterializeVisualStandardParams = {
  tenantId: string;
  mode: VisualIdentityMode;
  templateSlug?: string;
  visualStandardId: string | null;
  candidateFields: Record<string, unknown>;
  apply: boolean;
};
// `appliedFieldsReadback` is the tenant's OWN post-apply state for the fields just written —
// present ONLY when an apply was actually attempted. Its absence when `applied: true` is claimed is
// treated as UNVERIFIED, never as a pass — see the hash comparison in buildImagerySection below.
export type MaterializeVisualStandardResult = {
  visualStandardId: string;
  created: boolean;
  status: "draft" | "active";
  applied: boolean;
  appliedFieldsReadback?: Record<string, unknown>;
  reason?: string;
};
// Production wires this to the reused visual_standard_materializer path
// (visualStandardMaterialization.ts's create/patch + gated apply). Never implemented in this file.
export type MaterializeVisualStandardFn = (params: MaterializeVisualStandardParams) => Promise<MaterializeVisualStandardResult>;

export type SaveImageModelConfigParams = { tenantId: string; imageModelConfigId: string | null; candidateFields: Record<string, unknown> };
export type SaveImageModelConfigResult = { imageModelConfigId: string; created: boolean };
export type SaveImageModelConfigFn = (params: SaveImageModelConfigParams) => Promise<SaveImageModelConfigResult>;

export type VisualIdentityReviewChangeDeps = {
  siteContextSource: SiteContextSource;
  proposeVisualIdentity?: ProposeVisualIdentityFn;
  materializeVisualStandard?: MaterializeVisualStandardFn;
  saveImageModelConfig?: SaveImageModelConfigFn;
};

export type ExistingRecordSummary = {
  objectId: string | null;
  exists: boolean;
  // "empty" is a VALID initial state, not an error — see this module's header.
  state: "empty" | "saved";
  version?: number;
  contentRevision?: number;
  publishedTime?: string | null;
};

function summarizeRecord(objectId: string | null, record: SiteContextObject | undefined): ExistingRecordSummary {
  return {
    objectId,
    exists: !!record,
    state: record ? "saved" : "empty",
    version: record?.version,
    contentRevision: record?.contentRevision,
    publishedTime: record?.publishedTime ?? null
  };
}

// "visual_standard_fields_changed" / "lora_registration_only" / "no_change" — never any other
// string, so a caller pattern-matches this exhaustively rather than string-sniffing prose.
export type ImageEffectClassification = {
  demonstrated: boolean;
  reason: "visual_standard_fields_changed" | "lora_registration_only" | "no_change";
};

export type ImagerySection = {
  kind: VisualIdentityMode;
  existing: ExistingRecordSummary;
  imageModelConfig?: ExistingRecordSummary;
  proposal?: VisualIdentityProposalLike;
  changeSets: ChangeSet[];
  imageEffect?: ImageEffectClassification;
  saved: boolean;
  applied: boolean;
  applyReason?: string;
  // visual_standard is never a publishable type (publishableTypeCharter.ts) — stated as a literal
  // here, never computed, so nothing downstream can accidentally flip it.
  released: false;
};

export type ThemeSection = ExistingRecordSummary & { released: boolean };

export type PdfTemplatesSection = { templates: SiteSnapshot["registries"]["pdfTemplates"] };

export type VisualIdentityReviewChangeReport = {
  tenantId: string;
  focus: VisualIdentityFocus;
  preview: boolean;
  snapshotDigest: string;
  blockers: OperationBlocker[];
  sections: {
    imagery?: ImagerySection;
    theme?: ThemeSection;
    pdfTemplates?: PdfTemplatesSection;
  };
};

// ---------------------------------------------------------------------------------------------
// Target resolution. NEITHER function below ever assembles an id from a prefix or takes a caller-
// or model-supplied id on faith: an id that names nothing in the snapshot's own registries/objects
// is treated exactly like "no existing record" (objectId: null), never substituted for a real one.

export type ResolvedVisualStandardTarget = { kind: VisualIdentityMode; objectId: string | null; record?: SiteContextObject };

export function resolveVisualStandardTarget(
  snapshot: SiteSnapshot,
  params: { mode: VisualIdentityMode; templateSlug?: string; visualStandardId?: string }
): ResolvedVisualStandardTarget {
  const registry = snapshot.registries.visualStandards;
  const records = snapshot.objects.byType[VISUAL_STANDARD_OBJECT_TYPE] ?? [];

  if (params.visualStandardId) {
    const entry = registry.find((candidate) => candidate.id === params.visualStandardId);
    const record = records.find((candidate) => candidate.objectId === params.visualStandardId);
    if (entry || record) return { kind: params.mode, objectId: params.visualStandardId, record };
    // Falls through: an unverified id is not treated as real.
  }

  if (params.mode === "house") {
    const entry = registry.find((candidate) => candidate.kind === "house");
    if (!entry) return { kind: "house", objectId: null };
    return { kind: "house", objectId: entry.id, record: records.find((candidate) => candidate.objectId === entry.id) };
  }

  // mode "template": named/campaign standards are matched by slug against the REGISTRY, never
  // assembled from `vis_<site>_<slug>` here — that convention belongs to the write path
  // (visualStandardIds.ts) once an id is actually being minted, not to this read-side resolver.
  if (!params.templateSlug) return { kind: "template", objectId: null };
  const entry = registry.find(
    (candidate) => candidate.kind !== "house" && (candidate.id.endsWith(`_${params.templateSlug}`) || candidate.label === params.templateSlug)
  );
  if (!entry) return { kind: "template", objectId: null };
  return { kind: "template", objectId: entry.id, record: records.find((candidate) => candidate.objectId === entry.id) };
}

// Generic single-record resolver for object types with no house/template distinction (theme,
// image_model_config): an explicit id must match a real record; absent that, exactly one existing
// record resolves automatically, and zero or multiple resolve to nothing rather than guessing.
export function resolveRecordTarget(
  snapshot: SiteSnapshot,
  objectType: string,
  explicitId?: string
): { objectId: string | null; record?: SiteContextObject } {
  const records = snapshot.objects.byType[objectType] ?? [];
  if (explicitId) {
    const record = records.find((candidate) => candidate.objectId === explicitId);
    return record ? { objectId: record.objectId, record } : { objectId: null };
  }
  if (records.length === 1) return { objectId: records[0].objectId, record: records[0] };
  return { objectId: null };
}

// ---------------------------------------------------------------------------------------------
// The "no-board" path: a deterministic brief derived from the tenant's OWN current content, used
// only when the caller both supplied no board/brief and explicitly asked to work from site content.
// Never a model call — the visual judgment stays entirely inside the injected proposal step; this
// only assembles the text that step reads instead of a caller-supplied brief.
export function inferBriefFromSiteContent(snapshot: SiteSnapshot, target: { kind: VisualIdentityMode; record?: SiteContextObject }): string {
  const record = target.record;
  if (!record) {
    return `No existing ${target.kind} visual standard for tenant "${snapshot.tenantId}"; derive a style consistent with the tenant's own declared registries. No mood board was supplied.`;
  }
  const parts = [`Derive from the tenant's existing ${target.kind} visual standard ("${record.objectId}") rather than a supplied mood board.`];
  for (const key of ["whenToUse", "description", "label"]) {
    const value = record.fields[key];
    if (typeof value === "string" && value.trim()) parts.push(`${key}: ${value.trim()}.`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------------------------
// LoRA registration is not an image effect — see this module's header. Draws the distinction from
// the DIFF (did visual_standard's own fields actually change), never from which object type a
// caller or a model happened to name.
export function classifyImageEffect(params: { visualStandardChangeSet?: ChangeSet; imageModelConfigChangeSet?: ChangeSet }): ImageEffectClassification {
  const visualStandardChanged = (params.visualStandardChangeSet?.diffs.length ?? 0) > 0;
  const imageModelConfigChanged = (params.imageModelConfigChangeSet?.diffs.length ?? 0) > 0;
  if (visualStandardChanged) return { demonstrated: true, reason: "visual_standard_fields_changed" };
  if (imageModelConfigChanged) return { demonstrated: false, reason: "lora_registration_only" };
  return { demonstrated: false, reason: "no_change" };
}

const findApproval = (approvals: ScopedApproval[] | undefined, changeSetId: string): ScopedApproval | null =>
  approvals?.find((approval) => approval.changeSetId === changeSetId) ?? null;

// ---------------------------------------------------------------------------------------------
// The imagery section: snapshot -> (inferred brief) -> proposal -> candidate(s) -> diff(s) ->
// classification -> (preview stops here) -> authorized save/apply -> verified effective-state.
async function buildImagerySection(
  input: VisualIdentityReviewChangeInput,
  snapshot: SiteSnapshot,
  deps: VisualIdentityReviewChangeDeps,
  mode: VisualIdentityMode,
  preview: boolean,
  blockers: OperationBlocker[]
): Promise<ImagerySection> {
  const target = resolveVisualStandardTarget(snapshot, { mode, templateSlug: input.templateSlug, visualStandardId: input.visualStandardId });
  if (input.visualStandardId && target.objectId === null) {
    blockers.push({
      code: "visual_standard_id_not_found",
      message: `No visual_standard record or registry entry matches "${input.visualStandardId}" for tenant "${snapshot.tenantId}".`,
      remedy: "Omit visualStandardId to let this review resolve the tenant's own house/template record, or supply an id this snapshot actually returned.",
      blocking: false,
      evidence: { requestedVisualStandardId: input.visualStandardId }
    });
  }

  const section: ImagerySection = {
    kind: target.kind,
    existing: summarizeRecord(target.objectId, target.record),
    changeSets: [],
    saved: false,
    applied: false,
    released: false
  };

  const boardSupplied = (input.references?.length ?? 0) > 0 || !!input.brief;
  if (!boardSupplied && !input.workFromSiteContent) return section; // a complete, valid read-only report

  if (!deps.proposeVisualIdentity) {
    blockers.push({
      code: "visual_identity_proposal_unavailable",
      message: "A visual identity proposal was requested but no proposeVisualIdentity dependency was supplied.",
      remedy: "Wire proposeVisualIdentity to the brand_imagery_writer node (visual_identity.propose) and retry.",
      blocking: true
    });
    return section;
  }

  // Resolved upfront (not inside the `proposal.imageModelConfigFields` branch below) so its existing
  // fields, if any, can be handed to the proposal step for context regardless of whether the
  // proposal ends up touching it — the same "existing state informs the judgment" contract
  // existingBrandImagery already carries on the live writer node.
  const imageModelConfigLookup = resolveRecordTarget(snapshot, IMAGE_MODEL_CONFIG_OBJECT_TYPE, input.imageModelConfigId);

  const brief = boardSupplied ? (input.brief ?? "") : inferBriefFromSiteContent(snapshot, target);
  const proposal = await deps.proposeVisualIdentity({
    tenantId: input.tenantId,
    mode: target.kind,
    templateSlug: input.templateSlug,
    references: input.references,
    brief,
    existingVisualStandardFields: target.record?.fields,
    existingImageModelConfigFields: imageModelConfigLookup.record?.fields
  });
  section.proposal = proposal;

  let visualStandardEntry: { candidate: Candidate; changeSet: ChangeSet } | undefined;
  if (proposal.visualStandardFields) {
    const compiled = compileCandidate({
      snapshot,
      objectType: VISUAL_STANDARD_OBJECT_TYPE,
      intent: "visual_identity_review_change",
      fields: proposal.visualStandardFields,
      objectId: target.objectId
    });
    if (!compiled.ok) blockers.push(...compiled.blockers);
    else {
      const changeSet = computeChangeSet({ snapshot, candidate: compiled.candidate });
      visualStandardEntry = { candidate: compiled.candidate, changeSet };
      section.changeSets.push(changeSet);
    }
  }

  let imageModelConfigEntry: { candidate: Candidate; changeSet: ChangeSet } | undefined;
  if (proposal.imageModelConfigFields) {
    section.imageModelConfig = summarizeRecord(imageModelConfigLookup.objectId, imageModelConfigLookup.record);
    const compiled = compileCandidate({
      snapshot,
      objectType: IMAGE_MODEL_CONFIG_OBJECT_TYPE,
      intent: "visual_identity_review_change",
      fields: proposal.imageModelConfigFields,
      objectId: imageModelConfigLookup.objectId
    });
    if (!compiled.ok) blockers.push(...compiled.blockers);
    else {
      const changeSet = computeChangeSet({ snapshot, candidate: compiled.candidate });
      imageModelConfigEntry = { candidate: compiled.candidate, changeSet };
      section.changeSets.push(changeSet);
    }
  }

  section.imageEffect = classifyImageEffect({
    visualStandardChangeSet: visualStandardEntry?.changeSet,
    imageModelConfigChangeSet: imageModelConfigEntry?.changeSet
  });

  // A preview creates nothing: every diff/classification above is already computed and returned,
  // but save/apply are never invoked from here on, authorized or not.
  if (preview) return section;

  if (visualStandardEntry) {
    const authorization = authorizeEffects(visualStandardEntry.changeSet, findApproval(input.approvals, visualStandardEntry.changeSet.changeSetId));
    if (authorization.allAllowed) {
      if (!deps.materializeVisualStandard) {
        blockers.push({
          code: "materializer_unavailable",
          message: "Saving the visual_standard was authorized but no materializeVisualStandard dependency was supplied.",
          remedy: "Wire materializeVisualStandard to the reused visual_standard_materializer path and retry.",
          blocking: true
        });
      } else {
        const materialized = await deps.materializeVisualStandard({
          tenantId: input.tenantId,
          mode: target.kind,
          templateSlug: input.templateSlug,
          visualStandardId: target.objectId,
          candidateFields: visualStandardEntry.candidate.fields,
          apply: input.apply === true
        });
        // Saving is not applying: this flips the moment the write succeeds, independent of `apply`.
        section.saved = true;
        section.existing = { ...section.existing, objectId: materialized.visualStandardId, exists: true, state: "saved" };

        if (input.apply === true) {
          if (!materialized.applied) {
            section.applyReason = materialized.reason ?? "apply_not_confirmed";
          } else if (!materialized.appliedFieldsReadback) {
            // The materializer CLAIMS applied but produced no readback to verify it against — never
            // trusted on its own say-so.
            section.applyReason = "apply_hash_unverifiable_no_readback";
          } else if (contentDigest(materialized.appliedFieldsReadback) !== contentDigest(proposal.visualStandardFields)) {
            section.applyReason = "apply_hash_mismatch";
          } else {
            section.applied = true;
          }
        }
      }
    }
  }

  if (imageModelConfigEntry) {
    const authorization = authorizeEffects(imageModelConfigEntry.changeSet, findApproval(input.approvals, imageModelConfigEntry.changeSet.changeSetId));
    if (authorization.allAllowed) {
      if (!deps.saveImageModelConfig) {
        blockers.push({
          code: "image_model_config_save_unavailable",
          message: "Saving the image_model_config was authorized but no saveImageModelConfig dependency was supplied.",
          remedy: "Wire saveImageModelConfig and retry.",
          blocking: true
        });
      } else {
        const saved = await deps.saveImageModelConfig({
          tenantId: input.tenantId,
          imageModelConfigId: imageModelConfigLookup.objectId,
          candidateFields: imageModelConfigEntry.candidate.fields
        });
        section.imageModelConfig = { ...(section.imageModelConfig as ExistingRecordSummary), objectId: saved.imageModelConfigId, exists: true, state: "saved" };
      }
    }
  }

  return section;
}

// ---------------------------------------------------------------------------------------------
// The theme section: read-only (see this module's header scope boundary). `released` is read
// verbatim off the record's own publishedTime — never inferred from version/content_revision.
function buildThemeSection(input: VisualIdentityReviewChangeInput, snapshot: SiteSnapshot, blockers: OperationBlocker[]): ThemeSection {
  const target = resolveRecordTarget(snapshot, THEME_OBJECT_TYPE, input.themeId);
  if (input.themeId && target.objectId === null) {
    blockers.push({
      code: "theme_id_not_found",
      message: `No theme record matches "${input.themeId}" for tenant "${snapshot.tenantId}".`,
      remedy: "Omit themeId to let this review resolve the tenant's own theme record, or supply an id this snapshot actually returned.",
      blocking: false,
      evidence: { requestedThemeId: input.themeId }
    });
  }
  const summary = summarizeRecord(target.objectId, target.record);
  return { ...summary, released: summary.publishedTime !== null };
}

// ---------------------------------------------------------------------------------------------
// The entry point. A `focus: "full_review"` request (the default) is the COMBINED report:
// imagery, theme and PDF templates in one report, never an inventory-only partial success — see
// this module's header. A narrower focus scopes the snapshot read and the report to just that
// concern.
export async function runVisualIdentityReviewChange(
  input: VisualIdentityReviewChangeInput,
  deps: VisualIdentityReviewChangeDeps
): Promise<VisualIdentityReviewChangeReport> {
  const focus = input.focus ?? "full_review";
  const preview = input.preview === true;
  const mode = input.mode ?? "house";
  const blockers: OperationBlocker[] = [];

  const wantImagery = focus === "imagery" || focus === "color" || focus === "full_review";
  const wantTheme = focus === "theme" || focus === "full_review";

  const objectTypes = [
    ...(wantImagery ? [VISUAL_STANDARD_OBJECT_TYPE, IMAGE_MODEL_CONFIG_OBJECT_TYPE] : []),
    ...(wantTheme ? [THEME_OBJECT_TYPE] : [])
  ];
  const snapshot = await getSiteSnapshot(deps.siteContextSource, { tenantId: input.tenantId, objectTypes });

  const sections: VisualIdentityReviewChangeReport["sections"] = {};
  if (wantImagery) sections.imagery = await buildImagerySection(input, snapshot, deps, mode, preview, blockers);
  if (wantTheme) sections.theme = buildThemeSection(input, snapshot, blockers);
  // PDFs surface only on the combined report — a narrower focus (imagery/color/theme) stays scoped
  // to its own concern, matching the descriptor's own vocabulary.
  if (focus === "full_review") sections.pdfTemplates = { templates: snapshot.registries.pdfTemplates };

  return {
    tenantId: input.tenantId,
    focus,
    preview,
    snapshotDigest: snapshot.digest,
    blockers,
    sections
  };
}
