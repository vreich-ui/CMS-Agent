import type { ModelUsageFilters, ModelUsageRecord } from "../../observability/modelUsageTypes.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { UsageRepository } from "../interfaces/UsageRepository.js";

const inRange = (recordedAt: string, filters: ModelUsageFilters) => {
  const time = Date.parse(recordedAt);
  if (filters.from && time < Date.parse(filters.from)) return false;
  if (filters.to && time > Date.parse(filters.to)) return false;
  return true;
};

export class MemoryUsageRepository implements UsageRepository {
  private readonly records = new Map<string, ModelUsageRecord>();

  constructor(private readonly backend: RepositoryBackend = "memory") {}

  async record(record: ModelUsageRecord): Promise<ModelUsageRecord> {
    this.records.set(record.usageId, record);
    return record;
  }

  async list(filters: ModelUsageFilters = {}): Promise<ModelUsageRecord[]> {
    return [...this.records.values()].filter((record) => {
      if (filters.runId && record.runId !== filters.runId) return false;
      if (filters.projectId && record.projectId !== filters.projectId) return false;
      if (filters.workflowId && record.workflowId !== filters.workflowId) return false;
      if (filters.nodeId && record.nodeId !== filters.nodeId) return false;
      return inRange(record.recordedAt, filters);
    }).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }

  clear() {
    this.records.clear();
  }

  async health(): Promise<RepositoryHealth> {
    return healthyRepositoryStatus(this.backend);
  }
}
