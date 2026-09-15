// D1 (2026-09-14) — THE CODE PATH THAT ABANDONED A DISPATCH, and the save that stops it.
//
// THE DEFECT, exactly. A driver stamps a dispatch claim on a node, saves the run (rev R), hands the
// node to a runner, gets a finished result back, and calls saveRun again with base rev R. Every save
// in this repository is a compare-and-swap (BlobExecutionRepository.saveRun). So if ANY other writer
// touched that run record while the node was in flight, the completion save throws
// RunConcurrencyError — and advanceRun's conflict handler is `continue`, which restarts the advance
// from a fresh read. That fresh read finds the driver's OWN claim, still inside its window, and the
// stale-claim guard at the top of advanceRun returns the run untouched.
//
// The result is the failure this wave is named after: a node that RAN and SUCCEEDED is thrown away,
// its claim is left stamped with nobody behind it, and the run sits until the claim ages out
// (timeoutMs + STALL_MARGIN_MS = 180-390s) and a later driver reclaims it as
// `stale_dispatch_reclaimed` and pays for the node a second time. Every diagnostic said "the driver
// process died mid-node. Nothing is in flight." — and every one of them was wrong: the driver
// returned normally, on time, holding the answer.
//
// WHO THE OTHER WRITER IS. Since W0 T0.2 the continuation tick stamps `driverHealth.lastSeenByTickAt`
// on EVERY continuable run at the end of EVERY tick — including runs it has just refused because
// something is genuinely in flight. `lastSeenByTickAt` always changes, so that stamp is always a full
// record write, every two minutes, against runs another driver is mid-node on. runContinuation.ts
// now declines to stamp an in-flight run at all (that is the trigger); this module is the damage.
// Both halves are needed: any foreign write — an operator's set_node_budget_override, a publish
// decision, a future writer nobody has thought of — reproduces it otherwise.
//
// THE FIX, and its one safety condition. The finished node's result is IN HAND; the conflict is about
// bookkeeping fields on the same document. So: re-read the stored record, lay this advance's node
// states and run-level progress onto it, and re-save against the fresh revision.
//
// The condition is that the claim we are completing must still be OURS. If another driver has since
// reclaimed the node (its stored dispatch claim is gone, or carries a different dispatchedAt), then
// the node is being re-dispatched by somebody else and merging our result over theirs would be the
// double-write this CAS exists to prevent. In that case — and only in that case — the old behaviour
// is the correct one: discard and let the caller return the stored record.
import { RunConcurrencyError, type ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { NodeExecutionState, WorkflowExecutionRecord } from "./executionTypes.js";

export const NODE_ADVANCE_SAVE_MAX_RETRIES = 5;

// The claim a completed node was dispatched under. `dispatch` is deleted on completion; `lastDispatch`
// is stamped alongside it at dispatch time precisely so the provenance survives that delete.
const dispatchedAtOf = (state: NodeExecutionState | undefined): string | undefined =>
  state?.dispatch?.dispatchedAt ?? state?.lastDispatch?.dispatchedAt;

// THREE ANSWERS, NOT TWO. What the conflict means depends on what the stored record says about the
// nodes this advance touched:
//   "ours"    — every touched node is still running under the SAME claim this advance dispatched it
//               with. Nobody else can be executing it (a live claim is what stops them), so merging
//               this advance's result onto the fresh record is safe, and discarding it is the bug.
//   "taken"   — a touched node is running under a DIFFERENT claim: another driver reclaimed it and
//               is executing it now. Writing our result over theirs is the double-write the CAS
//               exists to prevent, so we discard — the pre-D1 behaviour, which was right here.
//   "unclaimed" — a touched node holds no claim at all (the deterministic tail completes inline,
//               above the claim block, and the best-effort observation path passes claim=false).
//               There is no claim to trip over, so the caller's ordinary conflict retry is both
//               safe and cheaper than a merge: re-running a $0 deterministic node costs nothing.
export type AdvanceClaimOwnership = "ours" | "taken" | "unclaimed";

export const advanceClaimOwnership = (stored: WorkflowExecutionRecord, advanced: WorkflowExecutionRecord, nodeIds: readonly string[]): AdvanceClaimOwnership => {
  let sawClaim = false;
  for (const nodeId of nodeIds) {
    const storedState = stored.nodes.find((node) => node.nodeId === nodeId);
    const advancedState = advanced.nodes.find((node) => node.nodeId === nodeId);
    if (!storedState || !advancedState) return "taken";
    if (storedState.status !== "running" || !storedState.dispatch) continue;
    sawClaim = true;
    if (storedState.dispatch.dispatchedAt !== dispatchedAtOf(advancedState)) return "taken";
  }
  return sawClaim ? "ours" : "unclaimed";
};

// Stored record + this advance's progress. `stored` supplies rev and every field a NON-dispatching
// writer owns (driverHealth, run-level warnings, operator decisions, budget overrides); the advance
// supplies the nodes it ran and the run-level facts those nodes produced.
export const mergeNodeAdvance = (stored: WorkflowExecutionRecord, advanced: WorkflowExecutionRecord, nodeIds: readonly string[]): WorkflowExecutionRecord => {
  const touched = new Set(nodeIds);
  const advancedById = new Map(advanced.nodes.map((node) => [node.nodeId, node]));
  const storedArtifactIds = new Set(stored.artifacts.map((artifact) => artifact.id));
  return {
    ...stored,
    nodes: stored.nodes.map((node) => (touched.has(node.nodeId) ? advancedById.get(node.nodeId) ?? node : node)),
    stageOutputs: { ...stored.stageOutputs, ...advanced.stageOutputs },
    artifacts: [...stored.artifacts, ...advanced.artifacts.filter((artifact) => !storedArtifactIds.has(artifact.id))],
    errors: advanced.errors,
    approvalsRequired: advanced.approvalsRequired,
    status: advanced.status,
    currentNodeId: advanced.currentNodeId,
    completedAt: advanced.completedAt,
    budgetBlock: advanced.budgetBlock,
    retryBackoffUntil: advanced.retryBackoffUntil,
    economicDecision: advanced.economicDecision ?? stored.economicDecision,
    // REVIEW FIX (W2) — UNION, not "advanced wins" and not "stored wins".
    //
    // `defaultedNodeIds` is a run-level fact produced BY a dispatch (a node completed from a stored
    // default or an operator override), so it belongs in this list alongside stageOutputs. It is
    // append-only for the life of the run except for retryNode's single deliberate subtraction, and a
    // union is the only merge that is correct in both directions here: taking `advanced` alone would
    // discard an override another writer recorded while this advance was in flight, and taking
    // `stored` alone would discard this advance's own mark — leaving fixture content in stageOutputs
    // with an empty ledger, which is exactly the state the publish gate and the learning recorder read
    // to protect against. Omitted entirely when both are empty, so an ordinary run's record is
    // unchanged.
    //
    // retryNode's subtraction is unaffected: it runs inside withRunLock and saves through the normal
    // store path, not through this merge.
    ...((stored.defaultedNodeIds ?? []).length || (advanced.defaultedNodeIds ?? []).length
      ? { defaultedNodeIds: [...new Set([...(stored.defaultedNodeIds ?? []), ...(advanced.defaultedNodeIds ?? [])])] }
      : {}),
    updatedAt: advanced.updatedAt
  };
};

export type NodeAdvanceSaveOutcome =
  | { saved: WorkflowExecutionRecord; abandoned?: undefined }
  // The claim is no longer ours: another driver has taken the node. `stored` is the record as it
  // now stands, and the caller must return it rather than write anything.
  | { saved?: undefined; abandoned: WorkflowExecutionRecord };

// The ONLY save a dispatching driver should use for a completed node. A plain store.saveRun here is
// what created the abandon path; this one never lets a conflict throw away work that already ran.
export async function saveNodeAdvance(
  store: ExecutionRepository,
  advanced: WorkflowExecutionRecord,
  nodeIds: readonly string[]
): Promise<NodeAdvanceSaveOutcome> {
  let record = advanced;
  for (let attempt = 0; attempt <= NODE_ADVANCE_SAVE_MAX_RETRIES; attempt++) {
    try {
      return { saved: await store.saveRun(record) };
    } catch (error) {
      if (!(error instanceof RunConcurrencyError)) throw error;
      const stored = await store.getRun(advanced.runId);
      if (!stored) throw error;
      const ownership = advanceClaimOwnership(stored, advanced, nodeIds);
      if (ownership === "taken") return { abandoned: stored };
      // "unclaimed": rethrow so advanceRun's own conflict retry re-runs the advance exactly as it
      // always has. Nothing is stranded, because nothing was claimed.
      if (ownership === "unclaimed") throw error;
      record = mergeNodeAdvance(stored, advanced, nodeIds);
    }
  }
  // Six consecutive conflicts on one document is a store nobody can write; surfacing it is honest.
  throw new RunConcurrencyError(advanced.runId, advanced.rev ?? 0, (await store.getRun(advanced.runId))?.rev ?? 0);
}
