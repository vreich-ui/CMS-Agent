import type { ToolExecutionFilters, ToolExecutionRecord } from "../../tools/toolTypes.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ToolExecutionRepository } from "../interfaces/ToolExecutionRepository.js";

// The in-process backend. Deliberately the same Map the module-level `records` in toolExecutor.ts
// was, so nothing about dev/test behaviour changes shape — what changes is that the ledger is now
// reachable through the repository seam and therefore has a durable sibling in production.
const matches = (record: ToolExecutionRecord, filters: ToolExecutionFilters): boolean => {
  if (filters.runId && record.runId !== filters.runId) return false;
  if (filters.nodeId && record.nodeId !== filters.nodeId) return false;
  if (filters.toolId && record.toolId !== filters.toolId) return false;
  if (filters.caller && record.caller !== filters.caller) return false;
  if (filters.routeId && record.routeId !== filters.routeId) return false;
  if (filters.projectId && record.projectId !== filters.projectId) return false;
  return true;
};

export class MemoryToolExecutionRepository implements ToolExecutionRepository {
  private readonly records = new Map<string, ToolExecutionRecord>();

  constructor(private readonly backend: RepositoryBackend = "memory") {}

  async record(record: ToolExecutionRecord): Promise<ToolExecutionRecord> {
    this.records.set(record.toolExecutionId, record);
    return record;
  }

  async get(toolExecutionId: string): Promise<ToolExecutionRecord | undefined> {
    return this.records.get(toolExecutionId);
  }

  async list(filters: ToolExecutionFilters = {}): Promise<ToolExecutionRecord[]> {
    const found = [...this.records.values()]
      .filter((record) => matches(record, filters))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return filters.limit ? found.slice(-filters.limit) : found;
  }

  clear(): void { this.records.clear(); }

  // Same shape every other memory repository reports; the blob sibling carries the
  // tool_executions.v1 store version because that is where a store version means something.
  async health(): Promise<RepositoryHealth> {
    return healthyRepositoryStatus(this.backend);
  }
}
