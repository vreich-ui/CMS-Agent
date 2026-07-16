import type { WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

// Thrown by saveRun when the stored run has advanced past the revision the caller loaded, i.e. a
// concurrent writer committed in between. Callers reload the latest run and retry, so a completed
// node is never re-run and currentNodeId never regresses under overlapping calls.
export class RunConcurrencyError extends Error {
  constructor(public readonly runId: string, public readonly expectedRev: number, public readonly actualRev: number) {
    super(`Concurrent modification of run ${runId} (expected rev ${expectedRev}, found ${actualRev})`);
    this.name = "RunConcurrencyError";
  }
}

export interface ExecutionRepository {
  createRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord>;
  getRun(runId: string): Promise<WorkflowExecutionRecord | undefined>;
  listRuns(filters?: { projectId?: string; workflowId?: string }): Promise<WorkflowExecutionRecord[]>;
  // Compare-and-swap persist. The run carries the `rev` it was loaded with; the write is committed
  // only if the stored record still has that `rev` (incrementing it on success) and otherwise
  // rejects with RunConcurrencyError. Node statuses, artifacts, stageOutputs and currentNodeId are
  // therefore persisted together, atomically, as one revision step.
  saveRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord>;
  // Unconditionally replace the run with a fresh state, bumping `rev` so any in-flight saveRun that
  // still holds a pre-reset revision fails its CAS instead of restoring stale node state.
  resetRun(runId: string, nextRun: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord>;
  health(): Promise<RepositoryHealth>;
}
