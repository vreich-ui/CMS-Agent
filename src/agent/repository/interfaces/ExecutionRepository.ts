import type { WorkflowExecutionRecord } from "../../workspace/executionTypes.js";

export interface ExecutionRepository {
  createRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord>;
  getRun(runId: string): Promise<WorkflowExecutionRecord | undefined>;
  listRuns(filters?: { projectId?: string; workflowId?: string }): Promise<WorkflowExecutionRecord[]>;
  saveRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord>;
  resetRun(runId: string, nextRun: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord>;
}
