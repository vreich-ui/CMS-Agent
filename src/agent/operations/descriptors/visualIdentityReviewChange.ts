// visual_identity_review_change — CONTRACT ONLY, no implementation here. Covers reviewing a
// tenant's visual identity standard (colors, imagery, theme) and proposing a change to it.
// Implementing task: A6.
import type { OperationDescriptor } from "../operationTypes.js";

export const visualIdentityReviewChangeOperationV1: OperationDescriptor = {
  operationId: "visual_identity_review_change",
  version: 1,
  title: "Visual identity review and change",
  summary: "Reviews the tenant's current visual identity standard and proposes a change to it (imagery, color, theme) for operator review. Proposing a change writes a proposal record; it never applies the change itself.",
  surface: null,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tenantId"],
    properties: {
      tenantId: { type: "string", minLength: 1 },
      focus: { type: "string", enum: ["imagery", "color", "theme", "full_review"], description: "What aspect of the visual identity to review/change." },
      autoApply: { type: "boolean", default: false, description: "Whether a resulting proposal should be marked for autonomous application. The proposal itself is never auto-applied by this descriptor's own contract; this field only states intent for the executor that eventually runs it." }
    }
  },
  defaults: { autoApply: false, focus: "full_review" },
  requiredCapabilities: ["visual_identity_read", "visual_identity_propose"],
  effects: [
    { kind: "read_visual_identity_standard", targetType: "visual_identity_standard", riskLevel: "read", description: "Reads the tenant's current visual identity standard." },
    { kind: "propose_visual_identity_change", targetType: "visual_identity_standard", riskLevel: "write", description: "Proposes a change to the tenant's visual identity standard for operator review; nothing is applied until a separate approval." }
  ],
  completion: [
    { id: "visual_identity_proposal_recorded", description: "A visual identity change proposal was recorded for operator review.", evidenceKind: "visual_identity_proposal" }
  ],
  intentKeywords: ["visual identity", "brand imagery", "site theme", "review the look", "change the look", "color palette review"]
};
