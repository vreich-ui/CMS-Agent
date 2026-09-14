// image_template_revision — the A2 catalog contract for the image-on-every-page batch operation.
// Implemented by A9: bound to the image_template_revision_studio workflow
// (imageTemplateRevisionWorkflow.ts / imageTemplateRevisionEngine.ts) via
// operationWorkflowBindings.ts. Today's engine supports templateRefs with surface "pdf" (the
// Zilberman acceptance scenario — three multi-page PDF templates); a "web" surface ref is a named
// capability gap (image_revision_surface_unsupported), not silently mishandled — see
// imageTemplateRevisionEngine.ts's fetchTargetTemplateVersionStep.
//
// A10 — the flat input below is turned into the workflow's nested initialInput.
// imageTemplateRevisionBrief by imageTemplateRevisionBriefBuilder.ts, declared on the binding
// (operationWorkflowBindings.ts's `initialInputBuilder`) and applied once, in startDryRun. Three
// fields were added here for that to be possible at all — sourceAsset (required: the image being
// placed was previously unnameable through this operation), placement and approve — and
// templateRefs[].version's declared type was corrected from string to integer. See each field's own
// comment.
import type { OperationDescriptor } from "../operationTypes.js";

export const imageTemplateRevisionOperationV1: OperationDescriptor = {
  operationId: "image_template_revision",
  version: 1,
  title: "Image and template revision",
  summary: "Revises the images and their placements within a batch of web page templates, then verifies every image in the revised batch.",
  surface: "web",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tenantId", "templateRefs", "sourceAsset"],
    properties: {
      tenantId: { type: "string", minLength: 1 },
      // A10 — ADDED, and REQUIRED. The image being placed was never nameable through this
      // operation's own input at all: the engine's brief has always had a `sourceAsset`
      // {tag|checksum|captureRequestId} (imageTemplateRevisionEngine.ts's SourceAssetRef) and this
      // descriptor carried no field that could reach it, so no dispatched request could ever say
      // WHICH image to place. Required rather than optional because a revision with no source image
      // has nothing to do: resolveSourceImageStep refuses without one
      // (image_revision_source_ref_missing), so accepting the request only to refuse it per-run
      // would be a worse contract than refusing it at preflight with a named missing field. An
      // image is never resolved by description — only by a tag, a checksum, or the capture request
      // that produced it (provenance, never a content-item mapping).
      sourceAsset: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          tag: { type: "string", minLength: 1 },
          checksum: { type: "string", minLength: 1 },
          captureRequestId: { type: "string", minLength: 1 }
        }
      },
      // A10 — ADDED, optional. The engine's own ImagePlacementSpec, defaulted by
      // DEFAULT_IMAGE_PLACEMENT when absent (top-right, reserved header band, aspect ratio
      // preserved). Omitting it is the normal case; naming it is how an editor asks for different
      // physical dimensions or margins. Every field is NAMED here, with additionalProperties:false:
      // the engine spreads this object over its defaults, so an unrecognised key (widthMm for
      // widthPt) would otherwise be accepted end to end and silently rendered at the default size.
      // The brief builder refuses the same shapes for callers that bypass this schema.
      placement: {
        type: "object",
        additionalProperties: false,
        properties: {
          position: { type: "string", enum: ["top-right"] },
          widthPt: { type: "number", exclusiveMinimum: 0 },
          heightPt: { type: "number", exclusiveMinimum: 0 },
          marginPt: { type: "number", exclusiveMinimum: 0 },
          headerReservePt: { type: "number", exclusiveMinimum: 0 }
        }
      },
      // A10 — ADDED, optional, and deliberately NOT defaulted to true. Absent approve leaves every
      // previewed item at "not_approved" in the apply stage's ledger — which the terminal report
      // counts as a NON-success (#337/D4). `true` approves every previewed item; an array approves
      // exactly the named templateIds. Defaulting this would turn "show me" into "publish it".
      approve: {
        anyOf: [{ type: "boolean" }, { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }]
      },
      templateRefs: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["surface", "templateId", "tenantId"],
          properties: {
            surface: { type: "string", enum: ["web", "pdf"] },
            templateId: { type: "string", minLength: 1 },
            tenantId: { type: "string", minLength: 1 },
            // A10 — WAS `{ type: "string" }`, which no consumer could ever use: a target version is
            // the template library's own integer version number (TargetTemplateRef.version /
            // FetchedTemplateVersion.version, imageTemplateRevisionEngine.ts, and
            // TemplateLibraryStore.getVersion's own numeric argument). A string here meant a pinned
            // version either failed the brief builder's own check or would have had to be coerced
            // silently into "whatever is latest" — the builder refuses a non-integer instead
            // (image_revision_template_ref_version_invalid), and this schema now states the type
            // the whole path has always actually used.
            version: { type: "integer", minimum: 1 }
          }
        }
      },
      batchSize: { type: "integer", minimum: 1, maximum: 100, default: 10 }
    }
  },
  defaults: { batchSize: 10 },
  // A10 — pdf_template_publish ADDED. The apply stage does not only write: runImageRevisionApplyBatch
  // reuses pdfTemplateEngine.ts's mint AND publish stages, whose verbs are create_pdf_template and
  // publish_pdf_template — which is why pdf_template_family, doing the same two things, has always
  // required both. Without it, a tenant granted create but not publish cleared preflight and then
  // failed at apply, after paying for intake and preview.
  requiredCapabilities: ["image_search", "image_template_write", "pdf_template_publish"],
  effects: [
    { kind: "revise_image_template_batch", targetType: "web_template_image_slot", riskLevel: "write", description: "Revises images and their placements within a batch of web page templates." }
  ],
  completion: [
    { id: "image_batch_verified", description: "Every image in the revised batch passed image/text verification.", evidenceKind: "image_verification_batch" }
  ],
  intentKeywords: ["template", "batch image update", "revise template images", "swap out images", "image and template revision", "update page images"]
};
