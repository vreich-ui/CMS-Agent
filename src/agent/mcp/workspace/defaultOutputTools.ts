// W1/W3 — the MCP-side halves of the node default-output contract: building a validated stored
// default, and applying an operator's run-scoped override. Both live here rather than inline in
// tools.ts because they are the two places a value an operator typed becomes a value a run will
// consume, and that transition deserves one reviewable file.
//
// The validation rule is the same in both, and is stated once: a value is checked against the node's
// OWN outputSchema (the schema node.validate_output enforces and a dispatch would have been held to),
// and a failure is REFUSED with the failing fields named. `force` overrides it, because the operator
// is the authority — mirroring the Workbench override modal's own second confirm — and a forced value
// is stamped `schemaValidAt: null` so the record shows it was never validated rather than quietly
// looking like every other saved default.

import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import type { WorkspaceRepository } from "../../repository/interfaces/WorkspaceRepository.js";
import type { ExecutionRepository } from "../../repository/interfaces/ExecutionRepository.js";
import { validateAgainstNodeSchema } from "../../workspace/nodeRuntime.js";
import { applyNonDispatchOutput, resolveConductorNodes } from "../../workspace/executor.js";
import { readNodeDefaultOutput, type NodeDefaultOutput } from "../../workspace/defaultOutput.js";
import { WorkspaceToolError } from "../../workspace/workspaceErrors.js";
import type { WorkspaceActor } from "../../workspace/changeTypes.js";

export type BuildDefaultOutputResult =
  | { ok: true; defaultOutput: NodeDefaultOutput; warnings: string[] }
  | { ok: false; error: WorkspaceToolError };

/**
 * Attribution for a stored default, read from the caller's own actor stamp rather than guessed. The
 * secure proxy stamps `human` with an identity email, a direct MCP bearer stamps `agent`, an internal
 * write stamps `system` — the same three-way reading changeTypes.ts's WorkspaceActor documents, and
 * the same caveat: this is attribution, never authorization.
 */
export const defaultOutputActorKind = (data: { actor?: string | WorkspaceActor }): NodeDefaultOutput["updatedBy"] => {
  const actor = data.actor;
  if (typeof actor === "string") return "agent";
  return actor?.kind ?? "system";
};

export function buildNodeDefaultOutput(
  node: WorkspaceNode,
  value: unknown,
  options: { note?: string; force: boolean; updatedBy: NodeDefaultOutput["updatedBy"] }
): BuildDefaultOutputResult {
  const at = new Date().toISOString();
  const validation = validateAgainstNodeSchema(value, node.outputSchema);
  if (!validation.valid && !options.force) {
    return {
      ok: false,
      error: new WorkspaceToolError(
        "default_output_schema_invalid",
        `The value does not satisfy ${node.id}'s output schema, so a run consuming it would hand a malformed output to every downstream node: ${validation.issues.join("; ")}. Fix the value, or pass force:true to store it anyway (it will be marked as never validated).`,
        { nodeId: node.id, issues: validation.issues }
      )
    };
  }
  return {
    ok: true,
    defaultOutput: {
      value,
      ...(options.note ? { note: options.note } : {}),
      updatedAt: at,
      updatedBy: options.updatedBy,
      // A TIMESTAMP OR null, never a boolean: `null` says "saved unvalidated, deliberately", and a
      // timestamp says WHEN it validated — so a schema edited afterwards leaves a default whose stamp
      // is visibly older than the schema, instead of a stale `true` that reads as current forever.
      schemaValidAt: validation.valid ? at : null
    },
    warnings: validation.valid ? [] : [`default_output_schema_invalid_forced: ${validation.issues.join("; ")}`]
  };
}

export type RunScopedOverrideInput = { runId: string; nodeId: string; value: unknown; note?: string; force?: boolean };

/**
 * THE OPERATOR OVERRIDE the Workbench's override modal has always meant to perform.
 *
 * Writes `run.stageOutputs[nodeId]` through the executor's own single non-dispatch writer, so an
 * override is marked (`run.defaultedNodeIds`), gated (a live run carrying one can never reach a
 * publishing node) and excluded from the learning record on exactly the same terms a stored default
 * is. That shared writer is the whole point: a second, parallel way to put a value into a run would be
 * a second thing every future guard has to remember to cover.
 */
export async function saveRunScopedOutput(
  data: RunScopedOverrideInput,
  deps: { workspaceRepository: WorkspaceRepository; executionRepository: ExecutionRepository }
): Promise<{ run: unknown; nodeId: string; provenance: string; warnings: string[] }> {
  const run = await deps.executionRepository.getRun(data.runId);
  if (!run) throw new WorkspaceToolError("unknown_run", `Unknown run: ${data.runId}`, { runId: data.runId });
  // Resolved through the RUN's own workflow, not the flat store view: a node id can belong to two
  // workflows with two different definitions (see overlayStoreNode's A10-D5 note), and validating
  // against the wrong one would refuse a correct value or accept a wrong one.
  const nodes = await resolveConductorNodes(deps.workspaceRepository, run.workflowId);
  const node = nodes.find((candidate) => candidate.id === data.nodeId);
  if (!node) {
    throw new WorkspaceToolError("unknown_node", `Run ${data.runId} runs workflow ${run.workflowId}, which has no node ${data.nodeId}.`, { runId: data.runId, nodeId: data.nodeId, workflowId: run.workflowId });
  }
  const state = run.nodes.find((candidate) => candidate.nodeId === data.nodeId);
  if (!state) throw new WorkspaceToolError("unknown_node", `Run ${data.runId} has no state for node ${data.nodeId}.`, { runId: data.runId, nodeId: data.nodeId });
  // A node with work in flight is refused rather than overwritten: the dispatch that is running would
  // complete afterwards and write over the override, so accepting it here would be a silent lie about
  // which value the run ended up using.
  if (state.status === "running" && state.dispatch) {
    throw new WorkspaceToolError("node_in_flight", `Node ${data.nodeId} is dispatched and still running in ${data.runId}. An override saved now would be overwritten the moment that dispatch returns. Wait for it, or cancel the run first.`, { runId: data.runId, nodeId: data.nodeId });
  }
  const validation = validateAgainstNodeSchema(data.value, node.outputSchema);
  if (!validation.valid && data.force !== true) {
    throw new WorkspaceToolError(
      "override_schema_invalid",
      `The value does not satisfy ${data.nodeId}'s output schema, so every downstream node in this run would receive a malformed input: ${validation.issues.join("; ")}. Fix the value, or pass force:true to override anyway.`,
      { runId: data.runId, nodeId: data.nodeId, issues: validation.issues }
    );
  }
  applyNonDispatchOutput(run, node, state, data.value, {
    source: "operator_override",
    updatedAt: new Date().toISOString(),
    ...(data.note ? { note: data.note } : {})
  });
  // An override on a node that had already failed clears the wall with it — the node is completed now,
  // and a blockage describing a node that is no longer stopped is exactly the stale card retryNode's
  // own comment warns about.
  delete state.blockage;
  delete state.errors;
  run.errors = run.errors.filter((error) => !error.startsWith(`${data.nodeId}:`));
  run.approvalsRequired = run.approvalsRequired.filter((approval) => approval.nodeId !== data.nodeId);
  // The run goes back to queued rather than being advanced here: this tool records a value, it does
  // not drive the run. The caller (or the continuation tick) advances it, which keeps every dispatch
  // decision in the one place that makes them.
  const saved = await deps.executionRepository.saveRun({ ...run, status: run.status === "completed" ? run.status : "queued", updatedAt: new Date().toISOString() });
  return {
    run: saved,
    nodeId: data.nodeId,
    provenance: "operator_override",
    warnings: validation.valid ? [] : [`override_schema_invalid_forced: ${validation.issues.join("; ")}`]
  };
}

export { readNodeDefaultOutput };
