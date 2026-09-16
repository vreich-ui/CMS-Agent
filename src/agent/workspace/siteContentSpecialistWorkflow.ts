import { registerWorkflow } from "./workflowRegistry.js";
import { listSiteContentSpecialistNodes } from "./siteContentSpecialistNodes.js";

// C3 — site_content_specialists' registration through the §2.23 multi-workflow seam, exactly as
// documentRenderWorkflow.ts and assetLookupWorkflow.ts do.
//
// REVIEW: why this registers a WORKFLOW at all, ahead of any conductor that dispatches these nodes.
// The precedent is visual_identity (visualIdentityNodes.ts / visualIdentityWorkflow.ts, C5): a small
// set of specialist nodes that a caller dispatches individually rather than as a DAG a run walks end
// to end. workspaceStoreNodes.ts's store union is what actually makes a node governable — visible to
// workspace.get_node, workspace.get_node_effective_config, the optimizer and playbook tooling — and
// getting into that union requires being a raw array some registered source contributes (see that
// module's own header on why RAW, uncomposed arrays are what it unions). Registering a workflow here
// is the standard, minimal way to add such a source: it costs one registerWorkflow call, it composes
// no publishing tail (none of these five nodes produces anything publishable — see riskLevel's own
// comment in siteContentSpecialistNodes.ts), and it means these five are addressable and inspectable
// in the store/Workbench from this PR onward, instead of waiting on C4's conductor to exist before an
// operator can so much as read one of their prompts. When the C4 conductor lands, it dispatches these
// five by node id (node_execute / node.get_effective_prompt, the same path visual_identity's chat
// dispatch already uses for brand_imagery_writer) — this registration does not need to change for
// that to work, exactly as visual_identity's registration did not change when site genesis started
// running it end to end.
//
// Imported for its side effect from executor.ts and nodeResolution.ts alongside the other workflow
// registrations, so this registration is present on every plane that resolves a node.
export const SITE_CONTENT_SPECIALISTS_WORKFLOW_ID = "site_content_specialists";

registerWorkflow({ workflowId: SITE_CONTENT_SPECIALISTS_WORKFLOW_ID, canonicalNodes: listSiteContentSpecialistNodes });
