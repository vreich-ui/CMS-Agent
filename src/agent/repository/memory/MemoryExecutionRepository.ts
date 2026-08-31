import type { WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import { RunConcurrencyError, windowRunRows, type ExecutionRepository, type ListRunsFilters, type ListRunsPageResult } from "../interfaces/ExecutionRepository.js";

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

  // Mirrors the blob repository's windowed contract (W1.5) so tests exercising either backend see
  // identical filter/sort/pagination semantics; here the window is applied over the in-memory map.
  async listRuns(filters: ListRunsFilters = {}): Promise<WorkflowExecutionRecord[]> {
    return (await this.listRunsPage(filters)).runs;
  }

  async listRunsPage(filters: ListRunsFilters = {}): Promise<ListRunsPageResult> {
    const { window, matchedCount, hasMore } = windowRunRows([...this.runs.values()], filters);
    return { runs: window.map((run) => clone(run)), matchedCount, hasMore };
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
