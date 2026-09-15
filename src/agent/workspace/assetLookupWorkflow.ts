import { registerWorkflow } from "./workflowRegistry.js";
import { listAssetLookupNodes } from "./assetLookupNodes.js";

// A5 (Milestone A remainder, runner 3c) — asset_lookup_studio's registration through the §2.23
// multi-workflow seam, exactly as documentRenderWorkflow.ts and imageTemplateRevisionWorkflow.ts do.
// With this and A8 landed, UNBOUND_OPERATION_IMPLEMENTING_TASK is empty: every catalog operation has
// a real implementing workflow or executor.
//
// Imported for its side effect from executor.ts and nodeResolution.ts alongside the other workflow
// registrations, so this registration is present on every plane that resolves a node.
export const ASSET_LOOKUP_WORKFLOW_ID = "asset_lookup_studio";

registerWorkflow({ workflowId: ASSET_LOOKUP_WORKFLOW_ID, canonicalNodes: listAssetLookupNodes });
