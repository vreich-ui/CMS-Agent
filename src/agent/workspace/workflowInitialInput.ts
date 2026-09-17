// workflowId -> the builder that turns a DISPATCHED CATALOG OPERATION's own flat input into the
// nested initialInput that workflow's entry node actually reads. Applied in ONE place, startDryRun
// (executor.ts), BEFORE the run record exists — so a refusal costs nothing and a success is visible
// in run.initialInput for every later read (dispatch, retry, reset: resetRun rebuilds from the run's
// own stored initialInput, which is already built, and every builder here is idempotent anyway).
//
// WHY THIS EXISTS AT ALL. operationWorkflowBindings.ts's `inputMapping` is documented, deliberately,
// as a FLAT FIELD-RENAME TABLE — never structural nesting. Two of this codebase's entry nodes
// (pdf_template_intake, image_revision_intake) read a single NESTED brief object instead of flat
// fields, which a rename table cannot express; both bindings therefore carried an empty inputMapping
// and neither operation could ever run from chat (A10-D1). This module is the missing half: the
// binding still says WHICH workflow implements an operation, and a builder here says HOW that
// operation's input becomes that workflow's initialInput. It is NOT a second workflow engine and NOT
// a second dispatch path — it builds a plain object and hands it back.
//
// NOT A GUESS AND NOT A SILENT TRANSFORM:
//   * keyed by the workflow's own registered id constant, never a string literal typed twice;
//   * IDEMPOTENT — an initialInput that ALREADY carries the field(s) a builder provides is returned
//     untouched, so an operator/test caller that hand-built a brief (every existing A9 test does),
//     and a reset of an already-built run, behave exactly as before this module existed;
//   * a builder REFUSES with a named code rather than emitting a partial brief, and startDryRun
//     turns that into a WorkspaceToolError before a run is minted;
//   * `requiredOperationFields` / `providesInitialInputFields` are DECLARED so
//     bindingInputContract.ts can check the declaration against the operation descriptor's own
//     guaranteed fields and the entry node's own inputSchema — a preflight `executable:true` for a
//     builder-backed binding is therefore a verified statement about delivery, not a relaxed check.
import { IMAGE_TEMPLATE_REVISION_WORKFLOW_ID } from "./imageTemplateRevisionWorkflow.js";
import { VISUAL_IDENTITY_WORKFLOW_ID } from "./visualIdentityWorkflow.js";
import { PDF_TEMPLATE_STUDIO_WORKFLOW_ID } from "./pdfTemplateStudioWorkflow.js";
import {
  buildImageTemplateRevisionBrief,
  IMAGE_TEMPLATE_REVISION_BRIEF_BUILDER_ID,
  IMAGE_TEMPLATE_REVISION_BRIEF_KEY,
  IMAGE_TEMPLATE_REVISION_BRIEF_REQUIRED_OPERATION_FIELDS
} from "../capture/imageTemplateRevisionBriefBuilder.js";
import {
  buildVisualIdentityBrief,
  VISUAL_IDENTITY_BRIEF_BUILDER_ID,
  VISUAL_IDENTITY_BRIEF_PROVIDED_FIELDS,
  VISUAL_IDENTITY_BRIEF_REQUIRED_OPERATION_FIELDS
} from "./visualIdentityBriefBuilder.js";
import { DOCUMENT_RENDER_WORKFLOW_ID } from "./documentRenderWorkflow.js";
import { ASSET_LOOKUP_WORKFLOW_ID } from "./assetLookupWorkflow.js";
import {
  buildAssetLookupBrief,
  ASSET_LOOKUP_BRIEF_BUILDER_ID,
  ASSET_LOOKUP_BRIEF_KEY,
  ASSET_LOOKUP_BRIEF_REQUIRED_OPERATION_FIELDS
} from "../capture/assetLookupBriefBuilder.js";
import {
  buildDocumentRenderBrief,
  DOCUMENT_RENDER_BRIEF_BUILDER_ID,
  DOCUMENT_RENDER_BRIEF_KEY,
  DOCUMENT_RENDER_BRIEF_REQUIRED_OPERATION_FIELDS
} from "../capture/documentRenderBriefBuilder.js";
import { IMAGE_ANNOTATION_WORKFLOW_ID } from "./imageAnnotationWorkflow.js";
import {
  buildImageAnnotationBrief,
  IMAGE_ANNOTATION_BRIEF_BUILDER_ID,
  IMAGE_ANNOTATION_BRIEF_KEY,
  IMAGE_ANNOTATION_BRIEF_REQUIRED_OPERATION_FIELDS
} from "../capture/imageAnnotationBriefBuilder.js";
import {
  buildPdfTemplateFamilyBrief,
  PDF_TEMPLATE_FAMILY_BRIEF_BUILDER_ID,
  PDF_TEMPLATE_FAMILY_BRIEF_KEY,
  PDF_TEMPLATE_FAMILY_BRIEF_REQUIRED_OPERATION_FIELDS
} from "../capture/pdfTemplateFamilyBriefBuilder.js";

export type WorkflowInitialInputBuildResult =
  | { ok: true; initialInput: Record<string, unknown> }
  | { ok: false; code: string; reason: string };

export type WorkflowInitialInputBuilder = {
  builderId: string;
  workflowId: string;
  // The initialInput keys this builder constructs. Read by bindingInputContract.ts as the target
  // fields the binding GUARANTEES the entry node, and by applyWorkflowInitialInput below as the
  // "already built" signal that makes application idempotent.
  providesInitialInputFields: readonly string[];
  // The operation fields the builder cannot work without. Checked against the operation descriptor's
  // own required ∪ defaults set (bindingInputContract.ts) — a builder needing a field the operation
  // does not guarantee makes the binding's input contract UNSATISFIED, never a silent runtime hope.
  requiredOperationFields: readonly string[];
  // The refusal code applyWorkflowInitialInput reports when an input carries BOTH a hand-built
  // result and a full operation dispatch (see the conflict branch below). Per builder, so the code
  // names the brief that conflicted rather than one workflow's vocabulary for every workflow.
  conflictCode: string;
  build: (input: unknown) => WorkflowInitialInputBuildResult;
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const BUILDERS: readonly WorkflowInitialInputBuilder[] = [
  {
    builderId: IMAGE_TEMPLATE_REVISION_BRIEF_BUILDER_ID,
    workflowId: IMAGE_TEMPLATE_REVISION_WORKFLOW_ID,
    providesInitialInputFields: [IMAGE_TEMPLATE_REVISION_BRIEF_KEY],
    requiredOperationFields: [...IMAGE_TEMPLATE_REVISION_BRIEF_REQUIRED_OPERATION_FIELDS],
    conflictCode: "image_revision_brief_conflict",
    build: (input) => {
      const built = buildImageTemplateRevisionBrief(input);
      if (!built.ok) return built;
      const source = isRecord(input) ? input : {};
      // cloneConductorRoutes.ts's resolveRunProjectId REFUSES a run whose declared targetProjectId
      // differs from the run's own projectId (clone_target_mismatch). OVERWRITING a caller-supplied
      // one would silently redirect exactly the request that guard exists to refuse, so a
      // conflicting value is refused here instead — and the value is only STATED when the caller
      // supplied none, which is what gives that existing guard the dispatched tenant to compare
      // against rather than nothing.
      const declaredTarget = typeof source.targetProjectId === "string" ? source.targetProjectId.trim() : "";
      if (declaredTarget && declaredTarget !== built.brief.tenantId) {
        return {
          ok: false,
          code: "image_revision_target_project_mismatch",
          reason: `This run declares targetProjectId "${declaredTarget}" but the operation is scoped to tenant "${built.brief.tenantId}". A dispatched revision is never redirected to another project's bounds; the two must name the same tenant.`
        };
      }
      return {
        ok: true,
        initialInput: {
          // The operation's own dispatched fields are KEPT, not replaced: the run record shows what
          // was actually asked for alongside what was built from it.
          ...source,
          targetProjectId: built.brief.tenantId,
          [IMAGE_TEMPLATE_REVISION_BRIEF_KEY]: built.brief
        }
      };
    }
  },
  {
    // A6 — visual_identity_review_change -> visual_identity. The builder writes the writer's and
    // materializer's own top-level fields (projectId/mode/brief/apply) rather than one nested brief,
    // because that is what those two nodes read (visualIdentityNodes.ts's inputSchema;
    // visualStandardMaterialization.ts's readVisualStandardRequest). See the builder's own header
    // for why every value is the operation's own and not a guess.
    builderId: VISUAL_IDENTITY_BRIEF_BUILDER_ID,
    workflowId: VISUAL_IDENTITY_WORKFLOW_ID,
    providesInitialInputFields: [...VISUAL_IDENTITY_BRIEF_PROVIDED_FIELDS],
    requiredOperationFields: [...VISUAL_IDENTITY_BRIEF_REQUIRED_OPERATION_FIELDS],
    conflictCode: "visual_identity_brief_conflict",
    build: (input) => {
      const built = buildVisualIdentityBrief(input);
      if (!built.ok) return built;
      const source = isRecord(input) ? input : {};
      // Dispatched fields KEPT beside what was built from them, same posture as A10's builder.
      return { ok: true, initialInput: { ...source, ...built.brief } };
    }
  },
  {
    // A7 — pdf_template_family -> pdf_template_studio. Nested brief, like A10's. `siteId` is NOT
    // written here — it is the tenant's Platform site object id, read off the project record by
    // cloneConductorRoutes.ts's pdf_template_intake case (resolvePdfToolSiteId), never the tenantId.
    builderId: PDF_TEMPLATE_FAMILY_BRIEF_BUILDER_ID,
    workflowId: PDF_TEMPLATE_STUDIO_WORKFLOW_ID,
    providesInitialInputFields: [PDF_TEMPLATE_FAMILY_BRIEF_KEY],
    requiredOperationFields: [...PDF_TEMPLATE_FAMILY_BRIEF_REQUIRED_OPERATION_FIELDS],
    conflictCode: "pdf_template_family_brief_conflict",
    build: (input) => {
      const built = buildPdfTemplateFamilyBrief(input);
      if (!built.ok) return built;
      const source = isRecord(input) ? input : {};
      // Same clone_target_mismatch guard A10's builder holds: state targetProjectId only when the
      // caller supplied none; refuse a conflicting one rather than redirect the run.
      const declaredTarget = typeof source.targetProjectId === "string" ? source.targetProjectId.trim() : "";
      if (declaredTarget && declaredTarget !== built.tenantId) {
        return {
          ok: false,
          code: "pdf_template_family_target_project_mismatch",
          reason: `This run declares targetProjectId "${declaredTarget}" but the operation is scoped to tenant "${built.tenantId}". A dispatched template family is never designed into another project's bounds; the two must name the same tenant.`
        };
      }
      return { ok: true, initialInput: { ...source, targetProjectId: built.tenantId, [PDF_TEMPLATE_FAMILY_BRIEF_KEY]: built.brief } };
    }
  },
  {
    // A8 (runner 3b) — document_render -> document_render_studio. Nested brief, like A7's and A10's.
    // `siteId` is NOT written here either: it is the tenant's Platform site object id, read off the
    // project record by cloneConductorRoutes.ts's document_render_execute case, never the tenantId.
    builderId: DOCUMENT_RENDER_BRIEF_BUILDER_ID,
    workflowId: DOCUMENT_RENDER_WORKFLOW_ID,
    providesInitialInputFields: [DOCUMENT_RENDER_BRIEF_KEY],
    requiredOperationFields: [...DOCUMENT_RENDER_BRIEF_REQUIRED_OPERATION_FIELDS],
    conflictCode: "document_render_brief_conflict",
    build: (input) => {
      const built = buildDocumentRenderBrief(input);
      if (!built.ok) return built;
      const source = isRecord(input) ? input : {};
      // Same clone_target_mismatch guard the two builders above hold.
      const declaredTarget = typeof source.targetProjectId === "string" ? source.targetProjectId.trim() : "";
      if (declaredTarget && declaredTarget !== built.tenantId) {
        return {
          ok: false,
          code: "document_render_target_project_mismatch",
          reason: `This run declares targetProjectId "${declaredTarget}" but the operation is scoped to tenant "${built.tenantId}". A dispatched render is never redirected to another project's documents; the two must name the same tenant.`
        };
      }
      return { ok: true, initialInput: { ...source, targetProjectId: built.tenantId, [DOCUMENT_RENDER_BRIEF_KEY]: built.brief } };
    }
  },
  {
    // A5 (runner 3c) — asset_lookup_adopt -> asset_lookup_studio. Nested brief, same posture as the
    // three above.
    builderId: ASSET_LOOKUP_BRIEF_BUILDER_ID,
    workflowId: ASSET_LOOKUP_WORKFLOW_ID,
    providesInitialInputFields: [ASSET_LOOKUP_BRIEF_KEY],
    requiredOperationFields: [...ASSET_LOOKUP_BRIEF_REQUIRED_OPERATION_FIELDS],
    conflictCode: "asset_lookup_brief_conflict",
    build: (input) => {
      const built = buildAssetLookupBrief(input);
      if (!built.ok) return built;
      const source = isRecord(input) ? input : {};
      const declaredTarget = typeof source.targetProjectId === "string" ? source.targetProjectId.trim() : "";
      if (declaredTarget && declaredTarget !== built.tenantId) {
        return {
          ok: false,
          code: "asset_lookup_target_project_mismatch",
          reason: `This run declares targetProjectId "${declaredTarget}" but the operation is scoped to tenant "${built.tenantId}". An asset lookup is never redirected to another project's artifacts; the two must name the same tenant.`
        };
      }
      return { ok: true, initialInput: { ...source, targetProjectId: built.tenantId, [ASSET_LOOKUP_BRIEF_KEY]: built.brief } };
    }
  },
  {
    // T5 (2026-09-16 annotate-bridge plan) — image_annotation -> image_annotation_studio. Nested
    // brief, same posture as the four above. The operation's flat fields (tenantId, image,
    // annotations, slot?, deviceScaleFactor?) have no flat equivalent on the entry node
    // (image_annotation_analyze), which reads ONE nested initialInput.imageAnnotationBrief.
    builderId: IMAGE_ANNOTATION_BRIEF_BUILDER_ID,
    workflowId: IMAGE_ANNOTATION_WORKFLOW_ID,
    providesInitialInputFields: [IMAGE_ANNOTATION_BRIEF_KEY],
    requiredOperationFields: [...IMAGE_ANNOTATION_BRIEF_REQUIRED_OPERATION_FIELDS],
    conflictCode: "image_annotation_brief_conflict",
    build: (input) => {
      const built = buildImageAnnotationBrief(input);
      if (!built.ok) return built;
      const source = isRecord(input) ? input : {};
      // Same clone_target_mismatch guard every builder above holds: state targetProjectId only when
      // the caller supplied none; refuse a conflicting one rather than redirect the run.
      const declaredTarget = typeof source.targetProjectId === "string" ? source.targetProjectId.trim() : "";
      if (declaredTarget && declaredTarget !== built.tenantId) {
        return {
          ok: false,
          code: "image_annotation_target_project_mismatch",
          reason: `This run declares targetProjectId "${declaredTarget}" but the operation is scoped to tenant "${built.tenantId}". An annotation is never redirected to another project's artifact store; the two must name the same tenant.`
        };
      }
      return { ok: true, initialInput: { ...source, targetProjectId: built.tenantId, [IMAGE_ANNOTATION_BRIEF_KEY]: built.brief } };
    }
  }
];

const buildersByWorkflowId = new Map<string, WorkflowInitialInputBuilder>();
for (const builder of BUILDERS) {
  if (buildersByWorkflowId.has(builder.workflowId)) {
    throw new Error(`workflowInitialInput: duplicate initial-input builder for workflow "${builder.workflowId}".`);
  }
  buildersByWorkflowId.set(builder.workflowId, builder);
}

// null (never a throw, never a guess) when this workflow has no registered builder — which is the
// case for every workflow whose entry node reads flat fields and needs no construction at all.
export function getWorkflowInitialInputBuilder(workflowId: string | null | undefined): WorkflowInitialInputBuilder | null {
  if (!workflowId) return null;
  return buildersByWorkflowId.get(workflowId) ?? null;
}

export type AppliedWorkflowInitialInput =
  | { ok: true; input: unknown; builderId: string | null; applied: boolean }
  | { ok: false; code: string; reason: string; builderId: string };

/**
 * The one transform startDryRun applies. Returns the input UNCHANGED (applied:false) when there is
 * no builder for this workflow, when the input is not an object, when every field the builder
 * provides is already present (idempotence — see this module's header), or when the input is not a
 * dispatch of this builder's operation at all (see the comment on `looksLikeDispatch` below).
 */
export function applyWorkflowInitialInput(workflowId: string | null | undefined, input: unknown): AppliedWorkflowInitialInput {
  const builder = getWorkflowInitialInputBuilder(workflowId);
  if (!builder) return { ok: true, input, builderId: null, applied: false };
  if (!isRecord(input)) return { ok: true, input, builderId: builder.builderId, applied: false };
  const alreadyBuilt = builder.providesInitialInputFields.every((field) => input[field] !== undefined);
  const carriesDispatchFields = builder.requiredOperationFields.every((field) => input[field] !== undefined);
  if (alreadyBuilt) {
    // BOTH a hand-written brief AND a full operation dispatch. Passing through here would make every
    // refusal this builder performs (cross-tenant templateRef, unreadable version pin, batch bound,
    // duplicate refs) optional: a caller could simply attach its own brief alongside the fields and
    // have the checked construction skipped. Which of the two the caller meant is genuinely
    // ambiguous, so this refuses rather than picking one.
    if (carriesDispatchFields) {
      return {
        ok: false,
        code: builder.conflictCode,
        reason: `This run carries BOTH a caller-supplied ${builder.providesInitialInputFields.join("/")} and a full set of the operation's own dispatch fields (${builder.requiredOperationFields.join(", ")}). Send one or the other: the dispatch fields alone (the brief is constructed from them, with every check the construction performs applied) or the built fields alone (an operator surface). Supplying both would let a hand-written brief bypass those checks.`,
        builderId: builder.builderId
      };
    }
    return { ok: true, input, builderId: builder.builderId, applied: false };
  }
  // NOT AN OPERATION DISPATCH AT ALL -> pass through, unchanged and unrefused. A builder builds; it
  // is not a second gate on who may start a run of this workflow. An input carrying none (or only
  // some) of the operation fields the builder requires is not a malformed dispatch to name a
  // refusal for — it is an operator, a test, or a future caller starting this workflow some other
  // way, and the entry node's OWN dispatch-boundary refusal
  // (image_template_revision_brief_missing) is already the honest answer for it, unchanged by this
  // module. publishAutonomyEveryWorkflow.test.ts starts a run of EVERY registered workflow with a
  // generic {targetProjectId, note} input purely to assert the project's publishing-policy snapshot
  // reaches it: that run must still be created, exactly as before.
  //
  // Once EVERY required operation field is present, the input IS a dispatch of this operation, and a
  // problem with it gets a named refusal here rather than a generic "no brief" three steps later.
  // (The operation's own inputSchema is still the authority on whether those fields are required at
  // all — preflightOperation refuses a request missing one before dispatch ever happens.)
  if (!carriesDispatchFields) return { ok: true, input, builderId: builder.builderId, applied: false };
  const built = builder.build(input);
  if (!built.ok) return { ok: false, code: built.code, reason: built.reason, builderId: builder.builderId };
  return { ok: true, input: built.initialInput, builderId: builder.builderId, applied: true };
}
