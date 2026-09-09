import type { ToolExecutionFilters, ToolExecutionRecord } from "../../tools/toolTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ToolExecutionRepository } from "../interfaces/ToolExecutionRepository.js";
import { getBlobJson, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);

// TWO PREFIXES, BOTH HOT, NEITHER A POST-READ FILTER.
//
// `tool.list_executions` is asked two questions: "what did this RUN call" and "what does this NODE
// call". BlobNodeTimingRepository and BlobUsageRepository each answer their second axis by listing a
// whole prefix and filtering after the download — the amplification defect this programme has now
// hit three times (W0.3, W1.4, W2.1). Here both axes are keys.
//
// The record is written ONCE and never updated (toolExecutor's `finish` and tenantInvoke's `finish`
// are each reached exactly once per call, on every outcome path), so the second copy is the record
// itself rather than a pointer needing a join. Two small writes at call time; an O(matching) read on
// either axis. Records carry summaries that are already bounded (500 chars per string, 50 keys, 20
// array entries — see toolExecutor's `redact`), so duplication is cheap in bytes as well.
const RUN_ROOT = "tool_executions/by-run/";
const NODE_ROOT = "tool_executions/by-node/";
const runPrefix = (runId: string) => `${RUN_ROOT}${runId}/`;
const nodePrefix = (nodeId: string) => `${NODE_ROOT}${nodeId}/`;
const runKey = (runId: string, toolExecutionId: string) => `${runPrefix(runId)}${toolExecutionId}.json`;
const nodeKey = (nodeId: string, toolExecutionId: string) => `${nodePrefix(nodeId)}${toolExecutionId}.json`;

const matches = (record: ToolExecutionRecord, filters: ToolExecutionFilters): boolean => {
  if (filters.runId && record.runId !== filters.runId) return false;
  if (filters.nodeId && record.nodeId !== filters.nodeId) return false;
  if (filters.toolId && record.toolId !== filters.toolId) return false;
  if (filters.caller && record.caller !== filters.caller) return false;
  if (filters.routeId && record.routeId !== filters.routeId) return false;
  if (filters.projectId && record.projectId !== filters.projectId) return false;
  return true;
};

export class BlobToolExecutionRepository implements ToolExecutionRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  async record(record: ToolExecutionRecord): Promise<ToolExecutionRecord> {
    // BOTH INDEXES AT ONCE. They were sequential, which made every tenant call pay two round trips
    // end to end; they are independent keys with no ordering requirement between them, so the only
    // thing serialising them was the `await`. capture's emit_live makes ~58 tenant calls on a real
    // site, so this is ~58 round trips of wall clock returned to the longest stage on that route.
    // (A ledger failure still never reaches the caller — see toolExecutionLedger.)
    await Promise.all([
      this.store.setJSON(runKey(record.runId, record.toolExecutionId), record),
      this.store.setJSON(nodeKey(record.nodeId, record.toolExecutionId), record)
    ]);
    return clone(record);
  }

  async get(toolExecutionId: string, runId?: string): Promise<ToolExecutionRecord | undefined> {
    // Without a runId this would be a scan of every run's prefix — the exact shape this class exists
    // to avoid — so it is refused rather than performed. tool.get_execution's existing run-record
    // fallback answers the by-id question instead.
    if (!runId) return undefined;
    const found = await getBlobJson<ToolExecutionRecord>(this.store, runKey(runId, toolExecutionId));
    return found ?? undefined;
  }

  async list(filters: ToolExecutionFilters = {}): Promise<ToolExecutionRecord[]> {
    // runId wins when both are given: a run is the narrower set in practice (one run's calls) and a
    // node's key space spans every run that ever dispatched it.
    const prefix = filters.runId ? runPrefix(filters.runId) : filters.nodeId ? nodePrefix(filters.nodeId) : RUN_ROOT;
    const result = await this.store.list({ prefix });

    // A `limit` MUST bound the downloads, not just the answer. The previous shape fetched every blob
    // under the prefix and then sliced — so `project.get.usedBy`, which filters by projectId only and
    // therefore lands on the unindexed RUN_ROOT, would have downloaded the entire ledger to return
    // its newest 500. That is the read-amplification trap this class was written to avoid, reproduced
    // by the one axis that has no prefix of its own.
    //
    // Newest first, by KEY: a toolExecutionId is `tool_exec_<Date.now()>_<rand>`, and Date.now() is
    // 13 digits until the year 2286, so descending lexicographic order on the key IS descending time
    // order — recoverable from the listing alone, without reading a single blob to find out.
    const keys = result.blobs.map((blob) => blob.key).sort((a, b) => b.localeCompare(a));
    const wanted = filters.limit;
    const found: ToolExecutionRecord[] = [];
    // Fetched in small waves rather than one at a time: a bounded read should still be a fast one.
    const WAVE = 25;
    for (let index = 0; index < keys.length; index += WAVE) {
      const wave = await Promise.all(keys.slice(index, index + WAVE).map((key) => getBlobJson<ToolExecutionRecord>(this.store, key)));
      for (const record of wave) {
        if (record && matches(record, filters)) found.push(record);
      }
      if (wanted !== undefined && found.length >= wanted) break;
    }
    return found
      .slice(0, wanted)
      // Returned oldest-first, which is the order a reader walking a run's call sequence wants; the
      // newest-first walk above is only how the bound is applied.
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((record) => clone(record));
  }

  clear(): void { throw new Error("BlobToolExecutionRepository.clear is only available in memory mode."); }

  async health(): Promise<RepositoryHealth> {
    return { ...healthyRepositoryStatus(storeBackendLabel()), version: "tool_executions.v1" };
  }
}
