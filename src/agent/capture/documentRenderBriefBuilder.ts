// A8 (runner 3b) — the CONSTRUCTOR for document_render, in the same shape
// pdfTemplateFamilyBriefBuilder.ts holds for A7: the operation's dispatched input is flat and
// nested-by-one (`tenantId`, `documentRef`, `templateVersion` — descriptors/documentRender.ts),
// while document_render_studio's entry node reads ONE nested
// `initialInput.documentRenderBrief` ({documentRef, documentKind?, templateId?, attach?}). A rename
// table cannot construct that, so the binding carries an empty inputMapping and this builder does
// the whole translation.
//
// WHAT IS CONSTRUCTED, AND WHAT IS DELIBERATELY NOT:
//   * documentRef  <- documentRef, verbatim, AFTER one restriction: objectType must be
//                     "content_item". Platform's verb has exactly one registered render-data mapper
//                     today (document-render.ts; the tool's own schema says 'Only "content_item" has
//                     a registered render-data mapper today') and refuses everything else by name
//                     before any lookup. Refusing HERE, at build time, means an operator learns it
//                     before a run record exists rather than from a blocked run; the refusal names
//                     the same constraint platform names, and lifts the moment platform grows a
//                     second mapper.
//   * documentKind <- NOT SET. The operation's input has no kind field, and platform defaults to
//                     "article", which is the one kind with a mapper. Inventing a kind here would be
//                     the fastest possible route to a no_mapper_for_kind block.
//   * templateId   <- from templateVersion, and ONLY when it names something other than "latest".
//                     "latest" is the ABSENCE of a pin (the descriptor's own default), and the
//                     platform verb resolves the site's own configured default for the kind when no
//                     template_id is given — so passing the literal string "latest" as a template id
//                     would be a template that does not exist. A pinned value is passed through as
//                     the template id it is; this builder does not check it against the store (that
//                     is the verb's own job, and it blocks with no_template by name).
//   * attach       <- NOT SET: the verb's own default (true) is the right one for rendering an
//                     OWNED document, and the operation offers no way to ask otherwise.

export const DOCUMENT_RENDER_BRIEF_BUILDER_ID = "document_render_brief_builder.v1";

// The initialInput key this builder constructs — the SAME key documentRenderExecuteStep and
// cloneConductorRoutes.ts's document_render_execute case read.
export const DOCUMENT_RENDER_BRIEF_KEY = "documentRenderBrief";

// Both `required` on the descriptor, so the operation's own guaranteed set covers them
// (bindingInputContract.ts).
export const DOCUMENT_RENDER_BRIEF_REQUIRED_OPERATION_FIELDS = ["tenantId", "documentRef"] as const;

// The one owner type platform has a render-data mapper for today. Named here, once.
export const DOCUMENT_RENDER_SUPPORTED_OBJECT_TYPE = "content_item";

export type DocumentRenderDispatchBrief = {
  documentRef: { objectType: string; objectId: string; tenantId: string; revision?: string };
  templateId?: string;
};

export type DocumentRenderBriefBuildResult =
  | { ok: true; tenantId: string; brief: DocumentRenderDispatchBrief }
  | { ok: false; code: string; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Builds the brief from ONE dispatched operation input. Pure: no clock, no store, no network, no
 * model. `input` is the operation's own merged input (defaults already applied), under the
 * operation's OWN field names.
 */
export function buildDocumentRenderBrief(input: unknown): DocumentRenderBriefBuildResult {
  const source = isRecord(input) ? input : {};
  const refuse = (code: string, reason: string): DocumentRenderBriefBuildResult => ({ ok: false, code, reason });

  const tenantId = nonEmptyString(source.tenantId) ? source.tenantId.trim() : undefined;
  if (!tenantId) {
    return refuse("document_render_brief_tenant_missing", "document_render was dispatched with no tenantId; the render call is tenant-scoped (and site-scoped from that tenant's own record), so a brief cannot be built without one.");
  }

  const ref = isRecord(source.documentRef) ? source.documentRef : undefined;
  if (!ref) {
    return refuse("document_render_brief_document_missing", "document_render was dispatched with no documentRef; there is no document to render, and this operation never picks one.");
  }
  const objectType = nonEmptyString(ref.objectType) ? ref.objectType.trim() : undefined;
  const objectId = nonEmptyString(ref.objectId) ? ref.objectId.trim() : undefined;
  const refTenantId = nonEmptyString(ref.tenantId) ? ref.tenantId.trim() : undefined;
  if (!objectType || !objectId || !refTenantId) {
    return refuse("document_render_brief_document_incomplete", `documentRef needs objectType, objectId and tenantId; received ${JSON.stringify(source.documentRef)}. Never completed from the operation's own tenantId — a document this run cannot fully name is a document it does not render.`);
  }
  if (refTenantId !== tenantId) {
    return refuse("document_render_brief_tenant_mismatch", `documentRef names tenant "${refTenantId}" but the operation is scoped to "${tenantId}". A render is never redirected across tenant bounds; the two must name the same tenant.`);
  }
  if (objectType !== DOCUMENT_RENDER_SUPPORTED_OBJECT_TYPE) {
    return refuse(
      "document_render_object_type_unsupported",
      `documentRef.objectType is "${objectType}", and the only owner type Platform has a render-data mapper for today is "${DOCUMENT_RENDER_SUPPORTED_OBJECT_TYPE}" (its own document_render verb refuses any other by name, before any lookup, with document_render_owner_type_unsupported / no_mapper_for_kind). Refused here rather than dispatched into a run that can only come back blocked. This lifts as soon as Platform registers a second mapper — nothing else here changes.`
    );
  }

  const brief: DocumentRenderDispatchBrief = {
    documentRef: { objectType, objectId, tenantId: refTenantId, ...(nonEmptyString(ref.revision) ? { revision: ref.revision.trim() } : {}) }
  };

  const templateVersion = source.templateVersion;
  if (templateVersion !== undefined && !nonEmptyString(templateVersion)) {
    return refuse("document_render_brief_template_version_invalid", `templateVersion, when supplied, must be a non-empty string; received ${JSON.stringify(templateVersion)}. Omit it (or pass "latest") to let the site's own configured default resolve.`);
  }
  if (nonEmptyString(templateVersion) && templateVersion.trim() !== "latest") {
    brief.templateId = templateVersion.trim();
  }

  return { ok: true, tenantId, brief };
}
