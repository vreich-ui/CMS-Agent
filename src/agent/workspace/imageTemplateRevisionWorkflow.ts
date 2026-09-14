import { registerWorkflow } from "./workflowRegistry.js";
import { listImageTemplateRevisionNodes } from "./imageTemplateRevisionNodes.js";

// A9 — image_template_revision_studio registration through the §2.23 multi-workflow seam
// (workflowRegistry.ts's registerWorkflow), exactly as pdfTemplateStudioWorkflow.ts does for A7. A
// caller that wants the image-on-every-page batch operation gets its own workflowId, its own
// registered four-node graph, and its own effective skills/tools/routes surfaced by
// node_get_effective_* and the workspace display paths — no special-casing anywhere in that shared
// machinery.
//
// R1b (workflowRegistry.ts) — an explicit, unregistered workflowId is REFUSED, never silently
// substituted for another workflow's graph. Registering image_template_revision_studio here is what
// makes that refusal moot for this id specifically.
//
// Imported for its side effect from executor.ts and nodeResolution.ts alongside the other five
// workflow registrations, so this registration is present on every plane that resolves a node.
export const IMAGE_TEMPLATE_REVISION_WORKFLOW_ID = "image_template_revision_studio";

registerWorkflow({ workflowId: IMAGE_TEMPLATE_REVISION_WORKFLOW_ID, canonicalNodes: listImageTemplateRevisionNodes });
