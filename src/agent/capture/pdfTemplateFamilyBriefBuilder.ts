// A7 (Milestone A remainder) — THE CONSTRUCTOR pdf_template_family WAS MISSING, the same gap
// imageTemplateRevisionBriefBuilder.ts (A10) closed for image_template_revision: the operation's
// dispatched input is flat (`tenantId`, `familyId`, `locale`, and — since this task — optional
// `useCase` / `sourceUrl`; descriptors/pdfTemplateFamily.ts) while pdf_template_studio's entry
// node, pdf_template_intake, reads ONE nested `initialInput.pdfTemplateFamilyBrief`
// ({siteId, familyId, useCase, variants, revise, sourceUrl} — pdfTemplateFamilyEngine.ts's
// pdfTemplateFamilyPlanStep). The binding carried an empty inputMapping (a rename table cannot
// nest), the entry node's schema was open, and A10-D1 made bindingInputContract.ts call that
// UNSATISFIED rather than vacuously satisfied — so preflight refused every chat-dispatched run by
// name. This builds the brief; pdf_template_intake's inputSchema now names it as required.
//
// WHAT IS CONSTRUCTED, AND WHAT IS DELIBERATELY NOT:
//   * familyId  <- familyId, verbatim (the stable identity reuse/revision targets).
//   * useCase   <- useCase when supplied, else OMITTED: pdfTemplateFamilyPlanStep applies
//                  DEFAULT_TEMPLATE_FAMILY_USE_CASE itself (templateFamilyProfiles.ts) and refuses an
//                  unknown one by name (family_plan_rejected). This builder does not pre-validate
//                  against the seeded profile table — that table is the plan step's own authority and
//                  duplicating the check here would be a second copy that can drift.
//   * sourceUrl <- sourceUrl when supplied, else OMITTED, never invented. ADR §4.1: a template whose
//                  provenance cannot be stated is not library-publishable — depositPublishedPdfTemplatesStep
//                  names such a variant `library_export_refused` (STEP B) while STEP A, publication
//                  to pdf-tool's own template store, still completes. The operation's own two
//                  completion criteria (pdf_template_family_validated / _published) are STEP A, so a
//                  dispatch without sourceUrl is a complete operation with an honestly-refused export.
//   * siteId    <- NOT SET HERE. pdf-tool calls are scoped by the tenant's Platform site object id
//                  (`site_<client>`, projectTypes.ts's ProjectObjectDialect.siteObjectId), which is NOT
//                  the tenantId and lives on the project record this pure builder cannot read.
//                  cloneConductorRoutes.ts's pdf_template_intake case resolves it from the record
//                  (resolvePdfToolSiteId) and injects it into the brief before the plan step runs —
//                  or refuses by name when the record has none. A caller-supplied siteId is kept and
//                  checked there against the record's, never silently overwritten.
//   * locale    <- KEPT on the initialInput (every dispatched field is), NOT placed in the brief: no
//                  seeded family profile reads a locale today (grep templateFamilyProfiles.ts), and a
//                  brief field nothing reads would be a claim the run cannot honour. The descriptor
//                  keeps the field so a locale-aware profile can pick it up without a contract change.
//   * variants / revise are NOT dispatchable through this operation today (its inputSchema is
//                  additionalProperties:false); an operator/test caller hand-builds the brief for those.
//
// TOTAL AND REFUSING, NEVER COERCING: a missing tenantId or familyId, a non-string useCase/sourceUrl,
// or a `targetProjectId` naming a different tenant (cloneConductorRoutes.ts's resolveRunProjectId
// refuses that mismatch anyway; refusing here means before a run record exists) each return a named
// code + reason as data, which workflowInitialInput.ts turns into a refusal inside startDryRun.

export const PDF_TEMPLATE_FAMILY_BRIEF_BUILDER_ID = "pdf_template_family_brief_builder.v1";

// The initialInput key this builder constructs — the SAME key pdfTemplateFamilyPlanStep and
// cloneConductorRoutes.ts's pdf_template_intake case read.
export const PDF_TEMPLATE_FAMILY_BRIEF_KEY = "pdfTemplateFamilyBrief";

// The operation fields this builder cannot construct a brief without — both `required` on the
// descriptor, so the operation's own guaranteed set covers them (bindingInputContract.ts).
export const PDF_TEMPLATE_FAMILY_BRIEF_REQUIRED_OPERATION_FIELDS = ["tenantId", "familyId"] as const;

export type PdfTemplateFamilyDispatchBrief = {
  familyId: string;
  useCase?: string;
  sourceUrl?: string;
};

export type PdfTemplateFamilyBriefBuildResult =
  | { ok: true; tenantId: string; brief: PdfTemplateFamilyDispatchBrief }
  | { ok: false; code: string; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Builds the brief from ONE dispatched operation input. Pure: no clock, no store, no network, no
 * model. `input` is the operation's own merged input (defaults already applied), under the
 * operation's OWN field names.
 */
export function buildPdfTemplateFamilyBrief(input: unknown): PdfTemplateFamilyBriefBuildResult {
  const source = isRecord(input) ? input : {};
  const refuse = (code: string, reason: string): PdfTemplateFamilyBriefBuildResult => ({ ok: false, code, reason });

  const tenantId = nonEmptyString(source.tenantId) ? source.tenantId.trim() : undefined;
  if (!tenantId) {
    return refuse("pdf_template_family_brief_tenant_missing", "pdf_template_family was dispatched with no tenantId; every pdf-tool call this operation performs is tenant-scoped, so a brief cannot be built without one.");
  }
  const familyId = nonEmptyString(source.familyId) ? source.familyId.trim() : undefined;
  if (!familyId) {
    return refuse("pdf_template_family_brief_family_missing", "pdf_template_family was dispatched with no familyId; a family needs a stable identity for reuse and revision to target, so a brief cannot be built without one.");
  }
  if (source.useCase !== undefined && !nonEmptyString(source.useCase)) {
    return refuse("pdf_template_family_brief_use_case_invalid", `useCase, when supplied, must be a non-empty string naming a seeded family profile; received ${JSON.stringify(source.useCase)}. Not coerced to the default: the wrong family is not a lesser family, it is a different one.`);
  }
  if (source.sourceUrl !== undefined && !nonEmptyString(source.sourceUrl)) {
    return refuse("pdf_template_family_brief_source_url_invalid", `sourceUrl, when supplied, must be a non-empty string; received ${JSON.stringify(source.sourceUrl)}. Omit it entirely when the family has no stateable source (the library export is then refused by name, and the pdf-tool publication still completes).`);
  }
  const brief: PdfTemplateFamilyDispatchBrief = { familyId };
  if (nonEmptyString(source.useCase)) brief.useCase = source.useCase.trim();
  if (nonEmptyString(source.sourceUrl)) brief.sourceUrl = source.sourceUrl.trim();
  return { ok: true, tenantId, brief };
}
