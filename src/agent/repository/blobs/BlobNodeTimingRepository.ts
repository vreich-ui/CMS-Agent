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
const runPrefix = (runId: string) => `node_timings/by-run/${runId}/`;
const runIndexedKey = (runId: string, timingId: string) => `${runPrefix(runId)}${timingId}.json`;
const RUN_INDEX_META_KEY = "node_timings/by-run/!meta.v1.json";
const keyFor = (record: Pick<NodeTimingRecord, "timingId" | "workflowId">) => record.workflowId ? workflowIndexedKey(record.workflowId, record.timingId) : flatKey(record.timingId);
const inRange = (recordedAt: string, filters: NodeTimingFilters) => {
  const time = Date.parse(recordedAt);
  if (filters.from && time < Date.parse(filters.from)) return false;
  if (filters.to && time > Date.parse(filters.to)) return false;
  return true;
};

export class BlobNodeTimingRepository implements NodeTimingRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  private runIndexConfirmed = false;
  private runIndexReady: Promise<void> | null = null;

  // The run index is a read-cost contract for cost history. Existing timing rows live under the
  // workflow prefix, so the first run-scoped read performs one complete, deduplicated backfill and
  // stamps a marker only after every discoverable row has a by-run copy. A result limit elsewhere
  // must never be mistaken for a bound on this compatibility migration.
  private ensureRunIndex(): Promise<void> {
    if (this.runIndexConfirmed) return Promise.resolve();
    if (!this.runIndexReady) {
      const ready = (async () => {
        const meta = await getBlobJson<{ schemaVersion: string }>(this.store, RUN_INDEX_META_KEY);
        if (meta?.schemaVersion !== "node_timing_run_index.v1") await this.backfillRunIndex();
        this.runIndexConfirmed = true;
      })();
      this.runIndexReady = ready;
      ready.catch(() => { if (this.runIndexReady === ready) this.runIndexReady = null; });
    }
    return this.runIndexReady;
  }

  private async backfillRunIndex(): Promise<void> {
    const listing = await this.store.list({ prefix: "node_timings/" });
    const rows = await Promise.all(listing.blobs
      .filter((blob) => blob.key !== RUN_INDEX_META_KEY)
      .map((blob) => getBlobJson<NodeTimingRecord>(this.store, blob.key)));
    const unique = new Map(rows.filter((row): row is NodeTimingRecord => row !== null).map((row) => [row.timingId, row]));
    await Promise.all([...unique.values()].map((row) => this.store.setJSON(runIndexedKey(row.runId, row.timingId), row)));
    await this.store.setJSON(RUN_INDEX_META_KEY, { schemaVersion: "node_timing_run_index.v1", backfilledAt: new Date().toISOString() });
  }

  async record(record: NodeTimingRecord): Promise<NodeTimingRecord> {
    // A full node timing is immutable. Write the workflow and run axes together so a history query
    // can join bounded run candidates without scanning the entire timing ledger on every dispatch.
    await Promise.all([
      this.store.setJSON(keyFor(record), record),
      this.store.setJSON(runIndexedKey(record.runId, record.timingId), record)
    ]);
    return clone(record);
  }
  async list(filters: NodeTimingFilters = {}): Promise<NodeTimingRecord[]> {
    if (filters.runId) await this.ensureRunIndex();
    const prefix = filters.runId ? runPrefix(filters.runId) : filters.workflowId ? workflowPrefix(filters.workflowId) : "node_timings/";
    const result = await this.store.list({ prefix });
    const records = await Promise.all(result.blobs.map((blob) => getBlobJson<NodeTimingRecord>(this.store, blob.key)));
    return records.filter((record): record is NodeTimingRecord => record !== null)
      .filter((record) => !filters.workflowId || record.workflowId === filters.workflowId)
      .filter((record) => !filters.runId || record.runId === filters.runId)
      .filter((record) => !filters.nodeId || record.nodeId === filters.nodeId)
      // W0.1 — projectId is a post-read filter rather than a second key prefix: workflowId remains
      // the hot filter (every reader windows by workflow first), and a pre-W0.1 record carrying no
      // projectId correctly fails this test rather than being counted for whichever tenant asked.
      .filter((record) => !filters.projectId || record.projectId === filters.projectId)
      .filter((record) => inRange(record.recordedAt, filters))
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      .map((record) => clone(record));
  }
  clear(): void { throw new Error("BlobNodeTimingRepository.clear is only available in memory mode."); }
  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "node_timings.v1" }; }
}
