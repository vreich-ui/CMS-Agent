import type { WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import { RunConcurrencyError, type ExecutionRepository } from "../interfaces/ExecutionRepository.js";

const clone = <T>(value: T): T => structuredClone(value);
const revOf = (run: WorkflowExecutionRecord | undefined): number => run?.rev ?? 0;

export class MemoryExecutionRepository implements ExecutionRepository {
  private readonly runs = new Map<string, WorkflowExecutionRecord>();

  constructor(private readonly backend: RepositoryBackend = "memory") {}

  async createRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    const seeded = { ...clone(run), rev: revOf(run) };
    this.runs.set(seeded.runId, seeded);
    return clone(seeded);
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

  // Compare-and-swap: the whole map operation runs synchronously (no await between the read and the
  // write), so it is atomic with respect to other in-process callers. A save whose base revision no
  // longer matches the stored record is rejected instead of clobbering a newer state.
  async saveRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    const stored = this.runs.get(run.runId);
    const base = revOf(run);
    if (stored && revOf(stored) !== base) throw new RunConcurrencyError(run.runId, base, revOf(stored));
    const next = { ...clone(run), rev: base + 1 };
    this.runs.set(next.runId, next);
    return clone(next);
  }

  async resetRun(runId: string, nextRun: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    const next = { ...clone(nextRun), rev: revOf(this.runs.get(runId)) + 1 };
    this.runs.set(runId, next);
    return clone(next);
  }

  async health(): Promise<RepositoryHealth> {
    return healthyRepositoryStatus(this.backend);
  }
}
