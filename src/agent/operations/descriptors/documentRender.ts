// document_render — CONTRACT ONLY, no implementation here. Covers rendering an existing article or
// structured document into a PDF artifact through an already-published PDF template.
// Implementing task: A8.
import type { OperationDescriptor } from "../operationTypes.js";

export const documentRenderOperationV1: OperationDescriptor = {
  operationId: "document_render",
  version: 1,
  title: "Render an existing document as PDF",
  summary: "Renders an existing article or structured document into a PDF artifact via a published PDF template, then verifies the rendered content against the source document.",
  surface: "pdf",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tenantId", "documentRef"],
    properties: {
      tenantId: { type: "string", minLength: 1 },
      documentRef: {
        type: "object",
        additionalProperties: false,
        required: ["objectType", "objectId", "tenantId"],
        properties: {
          objectType: { type: "string", minLength: 1 },
          objectId: { type: "string", minLength: 1 },
          tenantId: { type: "string", minLength: 1 },
          revision: { type: "string", minLength: 1 }
        },
        description: "The existing article/document (ObjectRef) to render."
      },
      templateVersion: { type: "string", minLength: 1, default: "latest" }
    }
  },
  defaults: { templateVersion: "latest" },
  requiredCapabilities: ["pdf_render"],
  effects: [
    { kind: "render_document_pdf", targetType: "pdf_artifact", riskLevel: "write", description: "Renders an existing article or structured document into a PDF artifact via a published template." }
  ],
  completion: [
    { id: "pdf_content_verified", description: "The rendered PDF's content was verified against the source document.", evidenceKind: "pdf_content_verification" }
  ],
  intentKeywords: ["render pdf", "export as pdf", "document render", "print version", "download as pdf", "generate the pdf"]
};
