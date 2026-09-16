// image_annotation — CONTRACT ONLY, no implementation here. Covers drawing a DETERMINISTIC
// annotation layer (a caption, a title, a label, a numbered badge) over an image that is ALREADY in
// the tenant's store, and saving the result as a NEW image artifact on the tenant plane.
// Implementing task: T4 of the 2026-09-16 annotate-bridge plan.
//
// WHY THIS DESCRIPTOR EXISTS AT ALL, AND WHY IT IS ONLY A DESCRIPTOR. The deterministic annotate
// path already SHIPPED and is live-verified end to end (2026-09-16, site_drlurie and
// site_platform): analyze_image_layout then annotate_image, reached through the per-tenant pdf-tool
// MCP bridge — correct pixels, zero render warnings, OCR-confirmed legible text. What it never had
// was an operationId. Nothing in this file adds, wraps or re-implements a single line of that
// path; it DESCRIBES the existing bridge tools as an operation, because three separate mechanisms
// in this codebase are keyed on an operationId and are therefore blind without one:
//   * planner_plan / operation_preflight select from operationCatalog.ts — an unregistered
//     capability is unselectable, however well it works;
//   * operation_execute dispatches on a registered binding — there is nothing to dispatch to;
//   * and, the costly one, operation_list_capability_gaps records one gap per (tenant,
//     operationId@version, missing capability) (capabilityGapTypes.ts / capabilityGapRecorder.ts),
//     so with no operationId the very mechanism built to SURFACE a missed capability could not
//     record this miss either. That is how a fully-shipped, fully-working capability sat unused and
//     unnoticed for ten days: not a broken tool, an unregistered contract.
//
// SURFACE IS null, DELIBERATELY. An annotated image is consumed by both surfaces — a web hero and a
// PDF cover page annotate identically, through the same two bridge verbs — so scoping this to "web"
// or "pdf" would make operationDisambiguation.ts narrow a correct match away on a surface signal
// that says nothing about this operation. site_inventory takes the same null for the same reason.
//
// FIELD SHAPES ARE READ FROM THE LIVE BRIDGE TOOLS, NOT INVENTED. `annotations[].role`'s four values
// are exactly AnnotationSpec v1's own text styles (label | title | caption | badge, where badge is
// the numbered-step element); `deviceScaleFactor`'s 1-3 range and default of 1 are annotate_image's
// own; `slot` is annotate_image's own optional safe slot (the by-slot lookup pointer the annotated
// artifact becomes retrievable under). An executor (T4) maps these onto the spec document and the
// grant; nothing here constructs one.
import type { OperationDescriptor } from "../operationTypes.js";

export const imageAnnotationOperationV1: OperationDescriptor = {
  operationId: "image_annotation",
  version: 1,
  title: "Image annotation",
  summary: "Draws a deterministic text/badge annotation layer over an image already stored on the tenant plane and saves the result as a new image artifact, then verifies the drawn strings are actually legible in the rendered pixels.",
  surface: null,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tenantId", "image", "annotations"],
    properties: {
      tenantId: { type: "string", minLength: 1 },
      // THE BASE IMAGE, NAMED BY PROVENANCE — never by description, the same discipline
      // imageTemplateRevision.ts's sourceAsset holds. Two accepted spellings, and exactly two: the
      // artifact-store pair the bridge verifies a reference with (requestId + sha256, the scope
      // check whose failure is ARTIFACT_NOT_VERIFIED), or the tenant-plane publicPath an already
      // published image is addressable at. `anyOf` rather than minProperties, because a lone
      // requestId with no sha256 is not a usable reference and must be refused at preflight rather
      // than accepted here and refused by the bridge a call later.
      image: {
        type: "object",
        additionalProperties: false,
        anyOf: [{ required: ["requestId", "sha256"] }, { required: ["publicPath"] }],
        properties: {
          requestId: { type: "string", minLength: 1, description: "The artifact request this image was stored under; paired with sha256, this is the reference the bridge access-checks." },
          sha256: { type: "string", minLength: 1, description: "The stored image's sha256, as returned when it was created." },
          publicPath: { type: "string", minLength: 1, description: "Tenant-plane path of an already-published image (the bridge's own `public_path` spelling; camelCase here, as every field in this catalog is)." }
        }
      },
      // THE ANNOTATION INTENT: the strings to draw and what each one IS. `role` is a CLOSED enum of
      // AnnotationSpec v1's own four text styles, with additionalProperties:false beside it, for the
      // reason imageTemplateRevision.ts's `placement` names every field: an unrecognised role would
      // otherwise travel the whole way and be rendered at the default style, silently. Extending
      // this vocabulary is an edit here, visible in a diff — never a pass-through.
      annotations: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "role"],
          properties: {
            text: { type: "string", minLength: 1 },
            role: {
              type: "string",
              enum: ["title", "caption", "label", "badge"],
              description: "Which kind of annotation this string is. \"badge\" is the numbered/short-label step marker; the other three are AnnotationSpec text styles."
            }
          }
        }
      },
      slot: { type: "string", minLength: 1, description: "Optional safe slot the annotated artifact becomes retrievable under (get_agent_artifact_by_slot). Setting it REPLACES that slot's lookup pointer; the previous artifact's bytes stay stored." },
      deviceScaleFactor: { type: "integer", minimum: 1, maximum: 3, default: 1, description: "Pixel density of the rendered canvas. 2 costs four times the pixels, which is what an up-front budget refusal is usually about." }
    }
  },
  defaults: { deviceScaleFactor: 1 },
  requiredCapabilities: ["image_annotate"],
  effects: [
    { kind: "analyze_image_layout", targetType: "stored_image", riskLevel: "read", description: "Reads the base image's 6x6 luminance/busyness grid and ranked safe zones to choose where text can go. Writes nothing." },
    { kind: "annotate_image", targetType: "image_artifact", riskLevel: "write", description: "Draws the annotation layer over the base image and saves the result as a NEW image artifact on the tenant plane; the base image is never modified." }
  ],
  // THE COMPLETION EVIDENCE IS check_image_text {mode: "expect"}'s OWN RESULT — the same strings the
  // annotation drew, read back out of the rendered pixels by OCR. Projected from that receipt, never
  // accepted on an executor's say-so that it finished (operationTypes.ts's OperationCompletionCheck).
  //
  // ITS WARNINGS ARE INFORMATIONAL AND MUST NEVER BLOCK. check_image_text is WARN-ONLY by design
  // platform-wide: a failing check still returns ok:true at the call's own level with the verdict
  // nested in textCheck.ok, and annotate_image's own renderReport.warnings (TEXT_SHRUNK,
  // TEXT_WRAPPED, COLLISION_PUSHED, AVOID_ZONE_OVERLAP, ...) ride along with a SUCCESSFUL render.
  // A descriptor is not a gate (operationTypes.ts's header), and this one does not attempt to become
  // one: no warning named here or there is a blocker, and T4's executor must not invent a gate out
  // of them either.
  completion: [
    { id: "annotation_text_verified", description: "Every string the annotation drew was read back out of the rendered image by the post-render text check.", evidenceKind: "image_text_check" }
  ],
  intentKeywords: ["caption this image", "put a title on the hero", "number the steps", "label the diagram", "add text to the image", "annotate"]
};
