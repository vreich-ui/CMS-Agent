import type { NodeTimingFilters, NodeTimingRecord } from "../../workspace/nodeTimings.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { NodeTimingRepository } from "../interfaces/NodeTimingRepository.js";

const inRange = (recordedAt: string, filters: NodeTimingFilters) => {
  const time = Date.parse(recordedAt);
  if (filters.from && time < Date.parse(filters.from)) return false;
  if (filters.to && time > Date.parse(filters.to)) return false;
  return true;
};

export class MemoryNodeTimingRepository implements NodeTimingRepository {
  private readonly records = new Map<string, NodeTimingRecord>();

  constructor(private readonly backend: RepositoryBackend = "memory") {}

  async record(record: NodeTimingRecord): Promise<NodeTimingRecord> {
    this.records.set(record.timingId, record);
    return record;
  }

  async list(filters: NodeTimingFilters = {}): Promise<NodeTimingRecord[]> {
    return [...this.records.values()].filter((record) => {
      if (filters.runId && record.runId !== filters.runId) return false;
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
