import { registerWorkflow } from "./workflowRegistry.js";
import { listPdfTemplateStudioNodes } from "./pdfTemplateStudioNodes.js";

// A7 (Stage A task list) — pdf_template_studio registration through the §2.23 multi-workflow seam
// (workflowRegistry.ts's registerWorkflow), exactly as captureConductorWorkflow.ts/
// cloneConductorWorkflow.ts/visualIdentityWorkflow.ts already do. This is what exposes the existing
// PDF branch as a STANDALONE studio (this task's own title): a caller that wants only PDF templates
// gets its own workflowId, its own registered node graph, and — through the SAME workflowRegistry.ts
// lookup every workflow shares — its own effective skills/tools/routes surfaced by node_get_effective_*
// and the workspace display paths, with no special-casing anywhere in that machinery.
//
// R1b (workflowRegistry.ts) — an explicit, unregistered workflowId is REFUSED, never silently
// substituted for another workflow's graph. Registering pdf_template_studio here is what makes that
// refusal moot for this id specifically: from this import onward, "pdf_template_studio" resolves to
// THIS graph and nothing else, and a caller who misspells it (or names an id nobody registered) still
// gets R1b's refusal rather than silently falling back to publishing_conductor.
//
// Imported for its side effect from executor.ts and nodeResolution.ts alongside the other three
// workflow registrations, so this registration is present on every plane that resolves a node.
export const PDF_TEMPLATE_STUDIO_WORKFLOW_ID = "pdf_template_studio";

registerWorkflow({ workflowId: PDF_TEMPLATE_STUDIO_WORKFLOW_ID, canonicalNodes: listPdfTemplateStudioNodes });
