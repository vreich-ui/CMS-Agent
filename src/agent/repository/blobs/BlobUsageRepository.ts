import type { ModelUsageFilters, ModelUsageRecord } from "../../observability/modelUsageTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { UsageRepository } from "../interfaces/UsageRepository.js";
import { getBlobJson, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
const key = (usageId: string) => `usage/${usageId}.json`;
const inRange = (recordedAt: string, filters: ModelUsageFilters) => {
  const time = Date.parse(recordedAt);
  if (filters.from && time < Date.parse(filters.from)) return false;
  if (filters.to && time > Date.parse(filters.to)) return false;
  return true;
};

export class BlobUsageRepository implements UsageRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}
  async record(record: ModelUsageRecord): Promise<ModelUsageRecord> {
    await this.store.setJSON(key(record.usageId), record);
    return clone(record);
  }
  async list(filters: ModelUsageFilters = {}): Promise<ModelUsageRecord[]> {
    const result = await this.store.list({ prefix: "usage/" });
    const records = await Promise.all(result.blobs.map((blob) => getBlobJson<ModelUsageRecord>(this.store, blob.key)));
    return records.filter((record): record is ModelUsageRecord => record !== null)
      .filter((record) => !filters.runId || record.runId === filters.runId)
      .filter((record) => !filters.projectId || record.projectId === filters.projectId)
      .filter((record) => !filters.workflowId || record.workflowId === filters.workflowId)
      .filter((record) => !filters.nodeId || record.nodeId === filters.nodeId)
      .filter((record) => inRange(record.recordedAt, filters))
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      .map((record) => clone(record));
  }
  clear(): void { throw new Error("BlobUsageRepository.clear is only available in memory mode."); }
  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "blobs.v1" }; }
}
