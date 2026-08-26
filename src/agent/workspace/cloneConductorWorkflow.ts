import { registerWorkflow } from "./workflowRegistry.js";
import { listCloneConductorNodes } from "./cloneConductorNodes.js";

// T13.1 — clone_conductor registration through the §2.23 seam.
//
// T15.10 (2026-08-25, #189) — like capture_conductor since T15.7 (#187) and for the same reason,
// this workflow composes the shared publishing tail's PUBLISH segment (composeWorkflowNodes, inside
// cloneConductorNodes.ts's listCloneConductorNodes). Its product is site STRUCTURE, not an article,
// so it does not inherit the tail's AUTHORING segment (contract_intelligence/artifact_plan/
// article_body) or an article's approval shape — but it DOES publish, through the identical
// publish_executor/release_executor nodes every tail-composing workflow shares. It ends at a
// prepared terminal report (clone_report) over what that tail did, not at a human gate.
//
// It is allowed to AUTHOR: mint recipes, bind theme tokens, restamp pages. Those are draft writes to
// governed objects — the same class of write capture_emit_live already performs — and every one of
// them is re-validated by deterministic engine code before it reaches the wire. What is now new is
// that a minted recipe, the bound theme, and the site singleton (clone's chartered publishable types,
// publishableTypeCharter.ts) have a live path: they go through the shared tail's own object-scoped
// self-check and the project's publishingPolicy.autonomyMode, exactly as capture's do.
//
// Imported for its side effect from executor.ts alongside captureConductorWorkflow, so registration
// happens on every plane before any run can resolve nodes.
export const CLONE_CONDUCTOR_WORKFLOW_ID = "clone_conductor";

registerWorkflow({ workflowId: CLONE_CONDUCTOR_WORKFLOW_ID, canonicalNodes: listCloneConductorNodes });
