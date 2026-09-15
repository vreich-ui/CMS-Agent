import { registerWorkflow } from "./workflowRegistry.js";
import { listDocumentRenderNodes } from "./documentRenderNodes.js";

// A8 (Milestone A remainder, runner 3b) — document_render_studio's registration through the §2.23
// multi-workflow seam, exactly as imageTemplateRevisionWorkflow.ts does for A9. Until this existed,
// document_render was the last catalog operation with no implementing workflow at all
// (UNBOUND_OPERATION_IMPLEMENTING_TASK named A8), so preflightOperation reported executable:false
// with "A8" as the remedy. It is now bound.
//
// Imported for its side effect from executor.ts and nodeResolution.ts alongside the other workflow
// registrations, so this registration is present on every plane that resolves a node.
export const DOCUMENT_RENDER_WORKFLOW_ID = "document_render_studio";

registerWorkflow({ workflowId: DOCUMENT_RENDER_WORKFLOW_ID, canonicalNodes: listDocumentRenderNodes });
