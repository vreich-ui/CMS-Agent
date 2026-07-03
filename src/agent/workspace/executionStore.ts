import type { WorkflowExecutionRecord } from "./executionTypes.js";

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryExecutionStore {
  private runs = new Map<string, WorkflowExecutionRecord>();

  async createRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    this.runs.set(run.runId, clone(run));
    return clone(run);
  }

  async getRun(runId: string): Promise<WorkflowExecutionRecord | undefined> {
    const run = this.runs.get(runId);
    return run ? clone(run) : undefined;
  }

  async listRuns(filters: { projectId?: string; workflowId?: string } = {}): Promise<WorkflowExecutionRecord[]> {
    return [...this.runs.values()]
      .filter((run) => !filters.projectId || run.projectId === filters.projectId)
      .filter((run) => !filters.workflowId || run.workflowId === filters.workflowId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((run) => clone(run));
  }

  async saveRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    this.runs.set(run.runId, clone(run));
    return clone(run);
  }

  async resetRun(runId: string, nextRun: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    this.runs.set(runId, clone(nextRun));
    return clone(nextRun);
  }
}

export const executionStore = new InMemoryExecutionStore();
