// W3.3 (2026-09-09) — ONE STATEMENT OF WHAT A DISPATCH IS ALLOWED TO DO.
//
// THE DEFECT. `evaluateToolPolicy` declares eight refusal reasons. Three of them could never fire on
// a real dispatch, because the context fields they read were never populated by anything that
// dispatches:
//
//   platform_tool_not_allowed        reads context.platformAllowedTools — never set.
//   run_tool_not_authorized          reads context.runAuthorizedTools  — never set.
//   risk_level_exceeds_authorization reads context.maxRiskLevel        — never set, so it silently
//                                    fell back to the node's own riskLevel. A node was therefore
//                                    capped by its own declaration and by nothing above it.
//
// And the approval gate had the same shape from the other side: `approvedToolIds` is populated on the
// tool.test diagnostic path and nowhere else, so a tool declaring requiresApproval was denied
// approval_required on every real run — the F4 incident, whose fix was to stop requiring approval on
// the one tool that hit it rather than to wire the gate up.
//
// The second half of the defect is that the operator's own view disagreed with all of this:
// `node.get_effective_tools` resolved a node with NO context at all, so the answer to "what can this
// node call" was computed from different inputs than the dispatch that would actually call it.
//
// WHAT THIS IS. The single builder both sides use. A dispatch and an inspection of that dispatch now
// produce the same ToolExecutionContext by construction rather than by two call sites remembering to
// pass the same arguments — which is the only version of "the inspector matches reality" that stays
// true after the next edit.
//
// FAIL-OPEN, EXPLICITLY. Absent authorization means UNRESTRICTED, never "allow nothing":
// `includes()` in toolPolicy treats undefined and [] alike as no restriction, and this builder passes
// undefined through rather than substituting an empty list. Nothing writes the run's authorization
// fields yet (see executionTypes.ts), so today every dispatch is exactly as permitted as it was
// before — what changed is that there is now one place to grant from, and one answer to what was
// granted.
import type { WorkflowExecutionRecord } from "../workspace/executionTypes.js";
import type { WorkspaceNode } from "../workspace/nodeTypes.js";
import type { ToolExecutionContext } from "../tools/toolTypes.js";

export type DispatchAuthorizationInput = {
  run: Pick<WorkflowExecutionRecord, "runId" | "workflowId" | "projectId" | "dryRun" | "authorizedTools" | "platformAllowedTools">;
  node: Pick<WorkspaceNode, "id" | "riskLevel">;
  // The tool ids an operator has approved for this dispatch. Threaded from the runner context, which
  // is where the diagnostic path already supplies it.
  approvedToolIds?: string[];
};

/**
 * The ToolExecutionContext a dispatch runs under — and, given the same run and node, exactly the
 * context `node.get_effective_tools` reports against.
 */
export function dispatchToolContext({ run, node, approvedToolIds }: DispatchAuthorizationInput): ToolExecutionContext {
  return {
    runId: run.runId,
    nodeId: node.id,
    workflowId: run.workflowId,
    projectId: run.projectId,
    dryRun: run.dryRun,
    ...(approvedToolIds ? { approvedToolIds } : {}),
    // Stated rather than left to toolPolicy's fallback. The value is the same one the fallback
    // produced (the node's own riskLevel), and saying it here is what lets a run-level or platform-level
    // cap be introduced above it later without another silent default appearing underneath.
    ...(node.riskLevel ? { maxRiskLevel: node.riskLevel } : {}),
    ...(run.platformAllowedTools ? { platformAllowedTools: run.platformAllowedTools } : {}),
    ...(run.authorizedTools ? { runAuthorizedTools: run.authorizedTools } : {})
  };
}
