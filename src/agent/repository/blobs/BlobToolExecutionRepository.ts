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
    // The run copy is canonical and is written first: if the second write fails, the record is still
    // findable by the axis every operator asks first, and the caller is not told the ledger failed
    // (see tenantInvoke — a ledger failure never changes what a tenant call returns).
    await this.store.setJSON(runKey(record.runId, record.toolExecutionId), record);
    await this.store.setJSON(nodeKey(record.nodeId, record.toolExecutionId), record);
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
    const records = await Promise.all(result.blobs.map((blob) => getBlobJson<ToolExecutionRecord>(this.store, blob.key)));
    const found = records
      .filter((record): record is ToolExecutionRecord => record !== null)
      .filter((record) => matches(record, filters))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((record) => clone(record));
    return filters.limit ? found.slice(-filters.limit) : found;
  }

  clear(): void { throw new Error("BlobToolExecutionRepository.clear is only available in memory mode."); }

  async health(): Promise<RepositoryHealth> {
    return { ...healthyRepositoryStatus(storeBackendLabel()), version: "tool_executions.v1" };
  }
}
