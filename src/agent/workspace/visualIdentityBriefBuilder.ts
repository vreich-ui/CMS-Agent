// A6 (Milestone A remainder) — THE CONSTRUCTOR visual_identity_review_change WAS MISSING. The
// operation's own dispatched input is flat and small — `tenantId`, `focus`
// (imagery|color|theme|full_review, defaulted to full_review), `autoApply` (defaulted to false;
// descriptors/visualIdentityReviewChange.ts) — while the `visual_identity` workflow's entry node,
// brand_imagery_writer, REQUIRES `mode` ("house"|"template") and at least one of `references`/`brief`
// (visualIdentityNodes.ts's own inputSchema). The binding's old field-rename table
// ({tenantId -> projectId, autoApply -> apply}) could rename but never SUPPLY those two, so
// bindingInputContract.ts reported the binding UNSATISFIED (R1c) and preflight refused every
// chat-dispatched run by name — honest, and still a failure. This builds what the rename could not.
//
// WHY A BUILDER AND NOT visualIdentityReviewChangeExecutor.ts. That executor exists and is
// deliberately unregistered: operationExecutorBindings.ts throws at import if an operation is bound
// to both a workflow and an executor, and operation.execute is READ-ONLY GATED (operationTools.ts)
// while this operation declares a "write" effect — so an executor is refused at that entrypoint by
// construction, whatever registry it sits in. The work this operation does IS the two-node
// visual_identity graph (the writer's one vision turn, then the materializer's governed save);
// what was missing was only the translation from the operation's vocabulary into that graph's. Same
// reasoning, same shape, as imageTemplateRevisionBriefBuilder.ts (A10).
//
// WHY inputMapping IS NOW EMPTY FOR THIS BINDING. Platform applies a binding's inputMapping
// BEFORE workflow_start_dry_run (tools.ts's resolveCatalogOperation renames fields, then forces the
// tenant key last), and startDryRun applies this builder AFTER — on the renamed input. A binding
// carrying both would rename `tenantId` to `projectId` on Platform, and this builder, looking for
// its declared `requiredOperationFields` under the operation's OWN names, would find no `tenantId`
// and pass the input through unbuilt: a silent skip, and a run refused at the first node three
// steps later. So a builder-backed binding does the WHOLE translation itself, under the operation's
// own field names, and operationWorkflowBindings.ts asserts at import that no row carries both.
//
// WHAT IS CONSTRUCTED, AND WHY EACH VALUE IS THE OPERATION'S OWN AND NOT A GUESS:
//   * projectId  <- tenantId. The writer's inputSchema names the tenant-scoped site "projectId";
//                  this catalog's reference types (operationReferences.ts) and every project record
//                  use the two interchangeably for the same single-tenant-per-site identity.
//   * mode       <- "house", always. The operation reviews "the tenant's current visual identity
//                  standard" (its own summary) — the house look. Template mode names an alternative
//                  look via templateSlug, a field this operation does not have; a run that wants one
//                  is not a dispatch of this operation.
//   * brief      <- a fixed sentence per `focus`, quoting the focus verbatim. It is the operation's
//                  declared intent put into the words the writer's prompt expects ("what the
//                  operator asked for, in words"), never an inferred style: the writer is told to
//                  work from the site's own tokens and existing imagery and to say so in rationale.
//   * apply      <- autoApply. The materializer reads `apply === true` (visualStandardMaterialization.ts)
//                  and STILL only applies behind the project's own tool policy and gate — this
//                  builder states the intent the descriptor says the field states; it grants nothing.
//   * focus, tenantId, autoApply are KEPT on the initialInput alongside (the run record shows what
//                  was asked for next to what was built from it), same posture as A10's builder.
//
// TOTAL AND REFUSING, NEVER COERCING: a missing tenantId, a focus outside the descriptor's own enum,
// a non-boolean autoApply, or a caller-supplied `projectId` naming a DIFFERENT tenant than the
// operation's own (never silently redirected — Platform forces the top-level tenantId to the caller's
// project, and this refuses rather than letting a second key disagree with it) each return a named
// code + reason as data; workflowInitialInput.ts turns that into a refusal BEFORE a run record exists.

export const VISUAL_IDENTITY_BRIEF_BUILDER_ID = "visual_identity_review_change_brief_builder.v1";

// The operation fields this builder cannot construct without. `focus` and `autoApply` are DEFAULTED
// by the descriptor (defaults: { autoApply: false, focus: "full_review" }), so the operation's own
// guaranteed set (required ∪ defaults, bindingInputContract.ts) covers all three.
export const VISUAL_IDENTITY_BRIEF_REQUIRED_OPERATION_FIELDS = ["tenantId", "focus", "autoApply"] as const;

// The initialInput keys this builder writes — the SAME names brand_imagery_writer's inputSchema
// requires (`mode`, `brief`) and names (`projectId`), and visualStandardMaterialization.ts reads
// (`apply`, `mode`). Exported so the binding's declared providesInitialInputFields and the
// contract check are the same strings as the ones actually written.
export const VISUAL_IDENTITY_BRIEF_PROVIDED_FIELDS = ["projectId", "mode", "brief", "apply"] as const;

export const VISUAL_IDENTITY_FOCUS_VALUES = ["imagery", "color", "theme", "full_review"] as const;
export type VisualIdentityFocus = (typeof VISUAL_IDENTITY_FOCUS_VALUES)[number];

// The words handed to the writer for each declared focus. Fixed text, quoting the focus, so two runs
// with the same dispatch produce the same brief (and the same inputRevision in noProgressFingerprint).
const BRIEF_BY_FOCUS: Readonly<Record<VisualIdentityFocus, string>> = {
  full_review:
    "Review this site's current visual identity standard in full (focus: full_review) — imagery, colour palette and theme — and propose the changes an operator should consider. Work only from the site's own brand tokens and its existing brand imagery; do not invent a house style, and say in rationale what you had to work from.",
  imagery:
    "Review this site's brand imagery (focus: imagery) — style sentence, sample subjects, aspect ratios — and propose changes to it. Keep the colour palette and theme as they are. Work only from the site's own brand tokens and existing brand imagery; say in rationale what you had to work from.",
  color:
    "Review this site's colour palette (focus: color) against its own brand tokens and propose changes to it. Keep the imagery style and theme as they are. Every swatch must come from the site's tokens or an existing reference; never invent a colour.",
  theme:
    "Review this site's theme (focus: theme) — the mood, surfaces and typographic direction the imagery must sit within — and propose changes to it. Keep the imagery style and colour palette as they are. Work only from the site's own tokens and existing brand imagery; say in rationale what you had to work from."
};

export type VisualIdentityBrief = {
  projectId: string;
  mode: "house";
  brief: string;
  apply: boolean;
};

export type VisualIdentityBriefBuildResult = { ok: true; brief: VisualIdentityBrief } | { ok: false; code: string; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isFocus = (value: unknown): value is VisualIdentityFocus => typeof value === "string" && (VISUAL_IDENTITY_FOCUS_VALUES as readonly string[]).includes(value);

export function visualIdentityBriefTextFor(focus: VisualIdentityFocus): string {
  return BRIEF_BY_FOCUS[focus];
}

/**
 * Builds the writer/materializer fields from ONE dispatched operation input. Pure: no clock, no
 * store, no network, no model. `input` is the operation's own merged input (defaults already
 * applied by operationPreflight/Platform), under the operation's OWN field names.
 */
export function buildVisualIdentityBrief(input: unknown): VisualIdentityBriefBuildResult {
  const source = isRecord(input) ? input : {};
  const refuse = (code: string, reason: string): VisualIdentityBriefBuildResult => ({ ok: false, code, reason });

  const tenantId = nonEmptyString(source.tenantId) ? source.tenantId.trim() : undefined;
  if (!tenantId) {
    return refuse("visual_identity_brief_tenant_missing", "visual_identity_review_change was dispatched with no tenantId; the standard under review is tenant-scoped, so nothing can be built without one.");
  }
  const declaredProject = nonEmptyString(source.projectId) ? source.projectId.trim() : "";
  if (declaredProject && declaredProject !== tenantId) {
    return refuse(
      "visual_identity_brief_project_mismatch",
      `This run declares projectId "${declaredProject}" but the operation is scoped to tenant "${tenantId}". A dispatched review is never redirected to another project's standard; the two must name the same tenant.`
    );
  }
  const focus = source.focus === undefined ? "full_review" : source.focus;
  if (!isFocus(focus)) {
    return refuse(
      "visual_identity_brief_focus_invalid",
      `focus must be one of ${VISUAL_IDENTITY_FOCUS_VALUES.join(", ")} (the operation's own enum); received ${JSON.stringify(source.focus)}. Not coerced to full_review: a review of the wrong aspect is not a lesser review, it is a different one.`
    );
  }
  const autoApply = source.autoApply === undefined ? false : source.autoApply;
  if (typeof autoApply !== "boolean") {
    return refuse(
      "visual_identity_brief_auto_apply_invalid",
      `autoApply must be a boolean; received ${JSON.stringify(source.autoApply)}. Not coerced: whether a proposal is marked for application is the one field on this operation that changes what the materializer may do.`
    );
  }
  return { ok: true, brief: { projectId: tenantId, mode: "house", brief: BRIEF_BY_FOCUS[focus], apply: autoApply } };
}
