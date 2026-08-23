import { registerWorkflow } from "./workflowRegistry.js";
import { listCloneConductorNodes } from "./cloneConductorNodes.js";

// T13.1 — clone_conductor registration through the §2.23 seam.
//
// Like capture_conductor and for the same reason, this workflow deliberately does NOT compose the
// shared publishing tail (composeWorkflowNodes). Its product is site STRUCTURE, not an article, and
// it must not inherit the article approval shape. It ends at a prepared report plus governed drafts;
// publish/release/build/deploy stay unreachable from every node.
//
// Unlike capture_conductor it is allowed to AUTHOR: mint recipes, bind theme tokens, restamp pages.
// Those are draft writes to governed objects — the same class of write capture_emit_live already
// performs — and every one of them is re-validated by deterministic engine code before it reaches
// the wire.
//
// Imported for its side effect from executor.ts alongside captureConductorWorkflow, so registration
// happens on every plane before any run can resolve nodes.
export const CLONE_CONDUCTOR_WORKFLOW_ID = "clone_conductor";

registerWorkflow({ workflowId: CLONE_CONDUCTOR_WORKFLOW_ID, canonicalNodes: listCloneConductorNodes });
