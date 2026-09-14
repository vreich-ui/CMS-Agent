// pdf_template_family — CONTRACT ONLY, no implementation here. Covers designing or revising a
// family of related PDF templates (a base template and its variants) for the tenant.
// Implementing task: A7.
import type { OperationDescriptor } from "../operationTypes.js";

export const pdfTemplateFamilyOperationV1: OperationDescriptor = {
  operationId: "pdf_template_family",
  version: 1,
  title: "PDF template family design and revision",
  summary: "Designs a new family of related PDF templates or revises an existing one, then validates and publishes the family for use in document rendering.",
  surface: "pdf",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tenantId", "familyId"],
    properties: {
      tenantId: { type: "string", minLength: 1 },
      familyId: { type: "string", minLength: 1, description: "Stable id for the template family being designed or revised." },
      locale: { type: "string", minLength: 1, default: "en-US" },
      // Milestone A remainder — the two brief fields a chat dispatch could not previously supply at
      // all (additionalProperties:false). Both optional; pdfTemplateFamilyBriefBuilder.ts passes
      // them into the brief verbatim and omits them when absent (see that module's header for what
      // an absent sourceUrl means: pdf-tool publication completes, the library export is refused by
      // name — ADR §4.1).
      useCase: { type: "string", minLength: 1, description: "Seeded family profile to expand (templateFamilyProfiles.ts); omit for the default profile. An unknown profile is refused by the plan step, by name." },
      sourceUrl: { type: "string", minLength: 1, description: "The stateable source of this family, recorded as its provenance for the cross-tenant template library. Omit when there is none: the family still publishes to pdf-tool; only the library export is refused." }
    }
  },
  defaults: { locale: "en-US" },
  requiredCapabilities: ["pdf_template_write", "pdf_template_publish"],
  effects: [
    { kind: "design_pdf_template_family", targetType: "pdf_template", riskLevel: "write", description: "Creates or revises a family of related PDF templates for the tenant." },
    { kind: "publish_pdf_template_family", targetType: "pdf_template", riskLevel: "publish", description: "Publishes a validated template family so it can be used to render documents." }
  ],
  completion: [
    { id: "pdf_template_family_validated", description: "Every template in the family passed PDF template validation.", evidenceKind: "pdf_template_validation" },
    { id: "pdf_template_family_published", description: "The validated template family was published for rendering.", evidenceKind: "pdf_template_publish_receipt" }
  ],
  intentKeywords: ["template", "pdf template", "template family", "design a pdf template", "revise the pdf template", "brochure template"]
};
