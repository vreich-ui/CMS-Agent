import { repositoryManager } from "../runtime/repositories.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import type { WorkspaceNode } from "./nodeTypes.js";
import { getWorkflowDefinition, listRegisteredWorkflowIds } from "./workflowRegistry.js";
// Side-effect import: capture_conductor registers itself here (the same import executor.ts already
// makes). Node resolution must see EVERY registered workflow on every plane that resolves a node —
// including the tool-policy path, which is reachable without the executor module ever loading.
import "./captureConductorWorkflow.js";

// T12.15 — single-node resolution for EXECUTION, as opposed to resolveConductorNodes (executor.ts),
// which resolves a whole run's node array.
//
// THE DEFECT THIS EXISTS FOR (T12.6 acceptance run, 2026-08-18). capture_conductor's three AI nodes —
// block_classifier, copy_regenerator, gap_adjudicator — are code-defined in captureConductorNodes.ts
// and registered through the §2.23 registry; they were never seeded into the workspace store, and
// they never should be (scripts/seedNodesFromWorkspace.ts's header: "Workspace fix ≠ fixed", a trap
// this project has paid for three times; resolveConductorNodes deliberately pins topology to the
// canonical definitions). Every per-node lookup on the execution path, however, went straight to
// `workspaceRepository.getNode(id)` and threw `Unknown node: <id>` on a miss:
//
//   * toolResolver.ts's resolveEffectiveToolsForNode, called by OpenAINodeRunner for any node with a
//     non-empty allowedTools — the LIVE break: `tool_error: Unknown node: block_classifier` out of
//     workflow.run_all;
//   * toolResolver.ts's resolvePolicySubjects, called by toolExecutor for every controlled tool call —
//     which returned `node: undefined` rather than throwing, silently disabling the node's OWN
//     allowedTools gate for exactly these nodes;
//   * nodeRuntime.ts's getEffectivePrompt / prepareNodeExecution / executeNode (node.get_effective_prompt,
//     node.prepare_execution, node.execute).
//
// The deterministic capture stages were unaffected because the executor's metadata.captureStageDeterministic
// fast-path completes them before any of the above runs — which is also why the mock harness and the
// mock-mode tests never caught it: MockNodeRunner resolves no tools.
//
// THE RULE. Store first, canonical second. A store record still WINS wherever one exists — that is the
// intended authoring overlay (a promoted prompt, an edited schema, a retuned modelConfig), and it is why
// publishing_conductor, every one of whose nodes is in the store, is byte-identical under this change.
// The registry is consulted only when the store has NO record for the id. A node id in neither place
// still resolves to nothing, so `Unknown node: <id>` is still thrown by every caller that threw it
// before — this invents no nodes.
//
// A store READ FAILURE is deliberately NOT caught here. resolveConductorNodes falls back wholesale on a
// throw because a transient repository error must not abort a whole run; a single-node lookup has no such
// duty, and swallowing the error would let a broken store quietly serve canonical definitions in place of
// an operator's promoted ones. Store errors propagate exactly as they did before.

// The canonical (code-defined) definition of one node id, or undefined.
//
// workflowId — the run's workflowId — drives which registry entry is consulted: a registered id is
// searched ALONE, so a run resolves its own workflow's canonical definitions and no other's. Callers
// with no run in hand (nodeRuntime.ts's independent single-node execution) pass none, and every
// registered workflow is searched in registration order (publishing_conductor first). An UNREGISTERED
// workflowId also searches them all, matching resolveConductorNodes' rule that an unknown stamp still
// resolves against publishing_conductor.
export function findCanonicalNodeById(nodeId: string, workflowId?: string): WorkspaceNode | undefined {
  const workflowIds = workflowId && getWorkflowDefinition(workflowId) ? [workflowId] : listRegisteredWorkflowIds();
  for (const id of workflowIds) {
    const found = getWorkflowDefinition(id)?.canonicalNodes().find((node) => node.id === nodeId);
    if (found) return found;
  }
  return undefined;
}

// Resolve ONE node for execution: the store's record when it has one, otherwise the registered
// workflow's canonical definition, otherwise undefined (callers keep throwing `Unknown node: <id>`).
export async function resolveNodeForExecution(nodeId: string, workspaceRepository?: WorkspaceRepository, workflowId?: string): Promise<WorkspaceNode | undefined> {
  const stored = await (workspaceRepository ?? repositoryManager.getWorkspaceRepository()).getNode(nodeId);
  return stored ?? findCanonicalNodeById(nodeId, workflowId);
}
