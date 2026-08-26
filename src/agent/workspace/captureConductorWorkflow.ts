import { registerWorkflow } from "./workflowRegistry.js";
import { listCaptureConductorNodes } from "./captureConductorNodes.js";

// T12.9 — capture_conductor registration through the §2.23 seam.
//
// T15.7 (ADR-2026-08-25-publish-autonomy §6, §9) SUPERSEDES the T12.9-era claim this comment used to
// make: capture no longer "ends at a prepared report plus never-released drafts". It composes the
// shared publishing tail's PUBLISH segment (composeWorkflowNodes, in captureConductorNodes.ts) exactly
// as publishing_conductor does, and publish/release ARE reachable — through the identical governed
// publish_executor/release_executor nodes, with the identical publish-risk safety machinery watching
// them. What capture never composes is the AUTHORING segment (contract_intelligence/artifact_plan/
// article_body): capture has no article body and never will. The registry isolates the node set (no
// new workspace/deployment); the executor resolves these nodes by the run's workflowId and the store
// overlay applies unchanged.
//
// This module is imported for its side effect from executor.ts, which every run driver (MCP tools,
// the Cloud Run conductor job, the run-continuation tick) already imports — registration therefore
// happens before any run can resolve nodes, on every plane, without touching the executor's logic.
export const CAPTURE_CONDUCTOR_WORKFLOW_ID = "capture_conductor";

registerWorkflow({ workflowId: CAPTURE_CONDUCTOR_WORKFLOW_ID, canonicalNodes: listCaptureConductorNodes });
