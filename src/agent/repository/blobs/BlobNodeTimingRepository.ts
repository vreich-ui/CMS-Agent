import type { NodeTimingFilters, NodeTimingRecord } from "../../workspace/nodeTimings.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { NodeTimingRepository } from "../interfaces/NodeTimingRepository.js";
import { getBlobJson, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
// Mirrors BlobUsageRepository's runIndexedKey scheme (see its comment for the amplification this
// avoids), scoped by workflowId instead of runId: workflow.get_run_cost's plan block (this wave's
// ONLY consumer, read-only) reads aggregates for one workflowId across every run of that workflow —
// never for a single run alone — so workflowId is the hot filter here where runId was there.
const flatKey = (timingId: string) => `node_timings/${timingId}.json`;
const workflowPrefix = (workflowId: string) => `node_timings/by-workflow/${workflowId}/`;
const workflowIndexedKey = (workflowId: string, timingId: string) => `${workflowPrefix(workflowId)}${timingId}.json`;
const keyFor = (record: Pick<NodeTimingRecord, "timingId" | "workflowId">) => record.workflowId ? workflowIndexedKey(record.workflowId, record.timingId) : flatKey(record.timingId);
const inRange = (recordedAt: string, filters: NodeTimingFilters) => {
  const time = Date.parse(recordedAt);
  if (filters.from && time < Date.parse(filters.from)) return false;
  if (filters.to && time > Date.parse(filters.to)) return false;
  return true;
};

export class BlobNodeTimingRepository implements NodeTimingRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}
  async record(record: NodeTimingRecord): Promise<NodeTimingRecord> {
    await this.store.setJSON(keyFor(record), record);
    return clone(record);
  }
  async list(filters: NodeTimingFilters = {}): Promise<NodeTimingRecord[]> {
    const prefix = filters.workflowId ? workflowPrefix(filters.workflowId) : "node_timings/";
    const result = await this.store.list({ prefix });
    const records = await Promise.all(result.blobs.map((blob) => getBlobJson<NodeTimingRecord>(this.store, blob.key)));
    return records.filter((record): record is NodeTimingRecord => record !== null)
      .filter((record) => !filters.workflowId || record.workflowId === filters.workflowId)
      .filter((record) => !filters.runId || record.runId === filters.runId)
      .filter((record) => !filters.nodeId || record.nodeId === filters.nodeId)
      .filter((record) => inRange(record.recordedAt, filters))
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      .map((record) => clone(record));
  }
  clear(): void { throw new Error("BlobNodeTimingRepository.clear is only available in memory mode."); }
  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "node_timings.v1" }; }
}
