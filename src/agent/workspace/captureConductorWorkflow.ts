import { registerWorkflow } from "./workflowRegistry.js";
import { listCaptureConductorNodes } from "./captureConductorNodes.js";

// T12.9 — capture_conductor registration through the §2.23 seam. This workflow deliberately does
// NOT compose the shared publishing tail (composeWorkflowNodes): capture ENDS at a prepared report
// plus never-released drafts — publish/release must be unreachable from every capture node, which
// is exactly the sub-graph the tail exists to provide for workflows that DO publish. The registry
// isolates the node set (no new workspace/deployment); the executor resolves these nodes by the
// run's workflowId and the store overlay applies unchanged.
//
// This module is imported for its side effect from executor.ts, which every run driver (MCP tools,
// the Cloud Run conductor job, the run-continuation tick) already imports — registration therefore
// happens before any run can resolve nodes, on every plane, without touching the executor's logic.
export const CAPTURE_CONDUCTOR_WORKFLOW_ID = "capture_conductor";

registerWorkflow({ workflowId: CAPTURE_CONDUCTOR_WORKFLOW_ID, canonicalNodes: listCaptureConductorNodes });
