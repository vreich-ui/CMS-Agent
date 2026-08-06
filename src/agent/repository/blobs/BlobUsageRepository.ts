import type { ModelUsageFilters, ModelUsageRecord } from "../../observability/modelUsageTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { UsageRepository } from "../interfaces/UsageRepository.js";
import { getBlobJson, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
// Perf (mcp-client-abort-timeouts-memoization): summarizeModelUsage({runId}) is the hot path — it is
// called on every node dispatch (the run budget gate in executor.ts, the per-node budget guard in
// OpenAINodeRunner.ts) — and used to list() the ENTIRE "usage/" prefix and download every usage blob
// this process has EVER written just to filter down to one run's records in memory afterward. A
// record with a runId (the overwhelming majority — every node-dispatch usage record carries one) is
// now ALSO indexed under usage/by-run/<runId>/<usageId>.json, so a runId-scoped list() only has to
// list and download that one run's blobs. Records with no runId keep the flat usage/<usageId>.json
// key they always had; a runId-less list() still scans the full "usage/" prefix (which naturally
// includes the by-run/ subtree too, since blob prefixes are plain string matches) exactly as before —
// that query shape was never the amplification this fixes.
const flatKey = (usageId: string) => `usage/${usageId}.json`;
const runPrefix = (runId: string) => `usage/by-run/${runId}/`;
const runIndexedKey = (runId: string, usageId: string) => `${runPrefix(runId)}${usageId}.json`;
const keyFor = (record: Pick<ModelUsageRecord, "usageId" | "runId">) => record.runId ? runIndexedKey(record.runId, record.usageId) : flatKey(record.usageId);
const inRange = (recordedAt: string, filters: ModelUsageFilters) => {
  const time = Date.parse(recordedAt);
  if (filters.from && time < Date.parse(filters.from)) return false;
  if (filters.to && time > Date.parse(filters.to)) return false;
  return true;
};

export class BlobUsageRepository implements UsageRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}
  async record(record: ModelUsageRecord): Promise<ModelUsageRecord> {
    await this.store.setJSON(keyFor(record), record);
    return clone(record);
  }
  async list(filters: ModelUsageFilters = {}): Promise<ModelUsageRecord[]> {
    const prefix = filters.runId ? runPrefix(filters.runId) : "usage/";
    const result = await this.store.list({ prefix });
    const records = await Promise.all(result.blobs.map((blob) => getBlobJson<ModelUsageRecord>(this.store, blob.key)));
    return records.filter((record): record is ModelUsageRecord => record !== null)
      .filter((record) => !filters.runId || record.runId === filters.runId)
      .filter((record) => !filters.projectId || record.projectId === filters.projectId)
      .filter((record) => !filters.workflowId || record.workflowId === filters.workflowId)
      .filter((record) => !filters.nodeId || record.nodeId === filters.nodeId)
      .filter((record) => !filters.status || record.status === filters.status)
      .filter((record) => inRange(record.recordedAt, filters))
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      .map((record) => clone(record));
  }
  clear(): void { throw new Error("BlobUsageRepository.clear is only available in memory mode."); }
  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "blobs.v1" }; }
}
