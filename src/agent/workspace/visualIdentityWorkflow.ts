import { registerWorkflow } from "./workflowRegistry.js";
import { listVisualIdentityNodes } from "./visualIdentityNodes.js";

// C5 (BRIEF §3.5) — visual_identity registration through the §2.23 seam.
//
// The pair is callable three ways and they are deliberately the same two nodes each time:
//   * node_execute('brand_imagery_writer') — the chat path. platform's `brand_imagery_propose`
//     (toolClass 'read') proxies to it and renders the proposal on an approval card.
//   * applying from that card, after the operator says yes — through a visual_identity RUN, NOT
//     through node_execute. REVIEW: node.execute dispatches a node runner directly (nodeRuntime.ts's
//     executeNode) and never takes any deterministic route, so a node_execute of the materializer
//     would put a MODEL where the engine belongs and hand back a receipt — visualStandardId,
//     applied, created — for a write that never happened, on a run whose projectId is the literal
//     "workspace". executeNode now refuses it by name outside mock mode.
//   * a visual_identity RUN — site genesis, where the pair runs end to end once and leaves a receipt.
//
// Imported for its side effect from executor.ts alongside captureConductorWorkflow /
// cloneConductorWorkflow, and from nodeResolution.ts, so the registration is present on every plane
// that resolves a node — including the tool-policy path, which is reachable without the executor
// module ever loading.
export const VISUAL_IDENTITY_WORKFLOW_ID = "visual_identity";

registerWorkflow({ workflowId: VISUAL_IDENTITY_WORKFLOW_ID, canonicalNodes: listVisualIdentityNodes });
