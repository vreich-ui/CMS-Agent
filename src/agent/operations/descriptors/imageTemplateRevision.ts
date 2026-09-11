// image_template_revision — CONTRACT ONLY, no implementation here. Covers revising images and
// their placements within a batch of web page templates. Implementing task: A9.
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
    required: ["tenantId", "templateRefs"],
    properties: {
      tenantId: { type: "string", minLength: 1 },
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
            version: { type: "string", minLength: 1 }
          }
        }
      },
      batchSize: { type: "integer", minimum: 1, maximum: 100, default: 10 }
    }
  },
  defaults: { batchSize: 10 },
  requiredCapabilities: ["image_search", "image_template_write"],
  effects: [
    { kind: "revise_image_template_batch", targetType: "web_template_image_slot", riskLevel: "write", description: "Revises images and their placements within a batch of web page templates." }
  ],
  completion: [
    { id: "image_batch_verified", description: "Every image in the revised batch passed image/text verification.", evidenceKind: "image_verification_batch" }
  ],
  intentKeywords: ["template", "batch image update", "revise template images", "swap out images", "image and template revision", "update page images"]
};
