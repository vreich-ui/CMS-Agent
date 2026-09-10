import type { ToolExecutionFilters, ToolExecutionRecord } from "../../tools/toolTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ToolExecutionRepository } from "../interfaces/ToolExecutionRepository.js";
import { getBlobJson, getBlobJsonWithEtag, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);

// The immutable call record has two direct indexes for its hot axes (run and node), plus a compact
// project index. The latter is deliberately an INDEX rather than a third full copy: it lets a
// project-scoped window select the correct records by their call timestamp before downloading those
// records, without making a `limit` pretend that an arbitrary key order is chronological.
const RUN_ROOT = "tool_executions/by-run/";
const NODE_ROOT = "tool_executions/by-node/";
const PROJECT_INDEX_ROOT = "tool_executions/project-index/";
const PROJECT_INDEX_META_KEY = `${PROJECT_INDEX_ROOT}!meta.v1.json`;
const runPrefix = (runId: string) => `${RUN_ROOT}${runId}/`;
const nodePrefix = (nodeId: string) => `${NODE_ROOT}${nodeId}/`;
const runKey = (runId: string, toolExecutionId: string) => `${runPrefix(runId)}${toolExecutionId}.json`;
const nodeKey = (nodeId: string, toolExecutionId: string) => `${nodePrefix(nodeId)}${toolExecutionId}.json`;
const projectIndexKey = (projectId: string) => `${PROJECT_INDEX_ROOT}${encodeURIComponent(projectId)}.json`;
// A contended compact index must never turn into a lossy last-writer-wins document. Entries that
// exhaust their bounded CAS budget are instead durable, immutable deltas. A subsequent project
// read merges and compacts them when the primary index is writable again.
const projectPendingPrefix = (projectId: string) => `${PROJECT_INDEX_ROOT}${encodeURIComponent(projectId)}/pending/`;
const projectPendingKey = (projectId: string, toolExecutionId: string) => `${projectPendingPrefix(projectId)}${encodeURIComponent(toolExecutionId)}.json`;

type ToolExecutionIndexEntry = Pick<ToolExecutionRecord,
  "toolExecutionId" | "runId" | "nodeId" | "toolId" | "startedAt" | "status" | "riskLevel" | "approvalStatus" | "caller" | "routeId" | "projectId">;
type ToolExecutionProjectIndex = { records: ToolExecutionIndexEntry[] };
type ToolExecutionProjectIndexMeta = { backfilledAt: string; schemaVersion: "tool_execution_project_index.v1" };

const indexEntryOf = (record: ToolExecutionRecord): ToolExecutionIndexEntry => ({
  toolExecutionId: record.toolExecutionId,
  runId: record.runId,
  nodeId: record.nodeId,
  toolId: record.toolId,
  startedAt: record.startedAt,
  status: record.status,
  riskLevel: record.riskLevel,
  approvalStatus: record.approvalStatus,
  ...(record.caller !== undefined ? { caller: record.caller } : {}),
  ...(record.routeId !== undefined ? { routeId: record.routeId } : {}),
  ...(record.projectId !== undefined ? { projectId: record.projectId } : {})
});

const matches = (record: ToolExecutionIndexEntry, filters: ToolExecutionFilters): boolean => {
  if (filters.runId && record.runId !== filters.runId) return false;
  if (filters.nodeId && record.nodeId !== filters.nodeId) return false;
  if (filters.toolId && record.toolId !== filters.toolId) return false;
  if (filters.caller && record.caller !== filters.caller) return false;
  if (filters.routeId && record.routeId !== filters.routeId) return false;
  if (filters.projectId && record.projectId !== filters.projectId) return false;
  return true;
};

// A call id is an identity, not a clock. Old callers and test fixtures can supply ids in any
// order, and a resumed old run can have the newest call in a key that sorts before another run's.
// The id is only a deterministic tie-breaker for equal timestamps.
const chronological = (left: Pick<ToolExecutionIndexEntry, "startedAt" | "toolExecutionId">, right: Pick<ToolExecutionIndexEntry, "startedAt" | "toolExecutionId">): number =>
  left.startedAt.localeCompare(right.startedAt) || left.toolExecutionId.localeCompare(right.toolExecutionId);

const newestWindow = <T extends ToolExecutionIndexEntry>(records: T[], limit: number | undefined): T[] => {
  const newestFirst = [...records].sort((left, right) => chronological(right, left));
  const selected = limit === undefined ? newestFirst : newestFirst.slice(0, limit);
  return selected.sort(chronological);
};

export class BlobToolExecutionRepository implements ToolExecutionRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  private projectIndexConfirmed = false;
  private projectIndexReady: Promise<void> | null = null;

  // A global marker is the compatibility contract. A store from before this index is scanned once,
  // every project index is built, then the marker is written. The first read is intentionally a
  // complete backfill (a result limit does NOT bound it); later project reads fetch one index plus
  // at most the selected record blobs. This is safer than returning a partial answer that hides old
  // ledger rows merely because they predate the index.
  private ensureProjectIndex(): Promise<void> {
    if (this.projectIndexConfirmed) return Promise.resolve();
    if (!this.projectIndexReady) {
      const ready = (async () => {
        const meta = await getBlobJson<ToolExecutionProjectIndexMeta>(this.store, PROJECT_INDEX_META_KEY);
        if (!meta || meta.schemaVersion !== "tool_execution_project_index.v1") await this.backfillProjectIndex();
        this.projectIndexConfirmed = true;
      })();
      this.projectIndexReady = ready;
      ready.catch(() => { if (this.projectIndexReady === ready) this.projectIndexReady = null; });
    }
    return this.projectIndexReady;
  }

  private async backfillProjectIndex(): Promise<void> {
    const listing = await this.store.list({ prefix: RUN_ROOT });
    const records = await Promise.all(listing.blobs.map((blob) => getBlobJson<ToolExecutionRecord>(this.store, blob.key)));
    const byProject = new Map<string, ToolExecutionIndexEntry[]>();
    for (const record of records) {
      if (!record?.projectId) continue;
      const entries = byProject.get(record.projectId) ?? [];
      entries.push(indexEntryOf(record));
      byProject.set(record.projectId, entries);
    }
    // Merge rather than overwrite: a concurrent post-ledger write may have already upserted its
    // entry while this first-read scan was in flight. The CAS loop keeps it rather than reopening a
    // lost-index race on GCS.
    await Promise.all([...byProject.entries()].map(([projectId, entries]) => this.mergeProjectIndex(projectId, entries)));
    await this.store.setJSON(PROJECT_INDEX_META_KEY, {
      backfilledAt: new Date().toISOString(), schemaVersion: "tool_execution_project_index.v1"
    } satisfies ToolExecutionProjectIndexMeta);
  }

  // Returns whether all additions are in the compact primary index. False means they are safely in
  // their immutable pending keys; callers must retain those keys until a later compaction wins CAS.
  private async mergeProjectIndex(projectId: string, additions: ToolExecutionIndexEntry[]): Promise<boolean> {
    if (!additions.length) return true;
    const key = projectIndexKey(projectId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await getBlobJsonWithEtag<ToolExecutionProjectIndex>(this.store, key);
      // Without an ETag we cannot prove an existing primary document has not changed. Do not
      // degrade to an unconditional overwrite: durable pending entries preserve every writer.
      if (current.data && !current.etag) break;
      const entries = new Map((current.data?.records ?? []).map((entry) => [entry.toolExecutionId, entry]));
      for (const entry of additions) entries.set(entry.toolExecutionId, entry);
      const options: Parameters<BlobStoreClient["setJSON"]>[2] = current.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true };
      const write = await this.store.setJSON(key, { records: [...entries.values()] } satisfies ToolExecutionProjectIndex, options);
      if (!write || (write as { modified?: boolean }).modified !== false) return true;
    }
    // Every pending key is an immutable call identity, so concurrent exhausted writers cannot
    // overwrite each other. This is intentionally a bounded write path, not a retry-until-lucky
    // loop that could hold up the ledger's nonblocking caller path.
    await Promise.all(additions.map((entry) => this.store.setJSON(projectPendingKey(projectId, entry.toolExecutionId), entry)));
    return false;
  }

  private async readProjectIndexEntries(projectId: string): Promise<ToolExecutionIndexEntry[]> {
    const [index, listing] = await Promise.all([
      getBlobJson<ToolExecutionProjectIndex>(this.store, projectIndexKey(projectId)),
      this.store.list({ prefix: projectPendingPrefix(projectId) })
    ]);
    const pending = await Promise.all(listing.blobs.map(async (blob) => ({
      key: blob.key,
      entry: await getBlobJson<ToolExecutionIndexEntry>(this.store, blob.key)
    })));
    const entries = new Map((index?.records ?? []).map((entry) => [entry.toolExecutionId, entry]));
    const durablePending = pending.filter((item): item is { key: string; entry: ToolExecutionIndexEntry } => item.entry !== null);
    for (const { entry } of durablePending) entries.set(entry.toolExecutionId, entry);
    if (durablePending.length) void this.compactPendingProjectEntries(projectId, durablePending);
    return [...entries.values()];
  }

  private async compactPendingProjectEntries(projectId: string, pending: { key: string; entry: ToolExecutionIndexEntry }[]): Promise<void> {
    try {
      if (await this.mergeProjectIndex(projectId, pending.map(({ entry }) => entry))) {
        await Promise.all(pending.map(({ key }) => this.store.delete(key)));
      }
    } catch { /* A later project read retries compaction; immutable pending entries remain visible. */ }
  }

  private async pruneProjectIndex(projectId: string, missingIds: Set<string>): Promise<void> {
    if (!missingIds.size) return;
    try {
      const key = projectIndexKey(projectId);
      const current = await getBlobJsonWithEtag<ToolExecutionProjectIndex>(this.store, key);
      if (!current.data || !current.etag) return;
      const records = current.data.records.filter((entry) => !missingIds.has(entry.toolExecutionId));
      if (records.length === current.data.records.length) return;
      await this.store.setJSON(key, { records } satisfies ToolExecutionProjectIndex, { onlyIfMatch: current.etag });
    } catch { /* best effort: a later reader drops and retries the same ghost safely. */ }
  }

  async record(record: ToolExecutionRecord): Promise<ToolExecutionRecord> {
    // The two immutable direct records remain concurrent. The project index is a small CAS document
    // because its writers share a project; it is still off a tenant call's clock through
    // toolExecutionLedger's nonblocking writer.
    await Promise.all([
      this.store.setJSON(runKey(record.runId, record.toolExecutionId), record),
      this.store.setJSON(nodeKey(record.nodeId, record.toolExecutionId), record),
      record.projectId ? this.mergeProjectIndex(record.projectId, [indexEntryOf(record)]) : Promise.resolve()
    ]);
    return clone(record);
  }

  async get(toolExecutionId: string, runId?: string): Promise<ToolExecutionRecord | undefined> {
    if (!runId) return undefined;
    const found = await getBlobJson<ToolExecutionRecord>(this.store, runKey(runId, toolExecutionId));
    return found ?? undefined;
  }

  async list(filters: ToolExecutionFilters = {}): Promise<ToolExecutionRecord[]> {
    if (filters.limit === 0) return [];

    if (filters.projectId) {
      await this.ensureProjectIndex();
      const entries = await this.readProjectIndexEntries(filters.projectId);
      const selected = newestWindow(entries.filter((record) => matches(record, filters)), filters.limit);
      const records = await Promise.all(selected.map((entry) => getBlobJson<ToolExecutionRecord>(this.store, runKey(entry.runId, entry.toolExecutionId))));
      const ghosts = new Set(selected.filter((_, index) => records[index] === null).map((entry) => entry.toolExecutionId));
      if (ghosts.size) void this.pruneProjectIndex(filters.projectId, ghosts);
      return records.filter((record): record is ToolExecutionRecord => record !== null).map((record) => clone(record));
    }

    // No project index can safely answer a cross-project question. Fetch all records under the
    // narrowest direct prefix, apply the real timestamp/id ordering, then apply the result limit.
    // This deliberately makes the cost visible in the persistence contract instead of claiming that
    // `limit` also bounded downloads when it did not.
    const prefix = filters.runId ? runPrefix(filters.runId) : filters.nodeId ? nodePrefix(filters.nodeId) : RUN_ROOT;
    const listing = await this.store.list({ prefix });
    const records = await Promise.all(listing.blobs.map((blob) => getBlobJson<ToolExecutionRecord>(this.store, blob.key)));
    return newestWindow(records.filter((record): record is ToolExecutionRecord => record !== null && matches(record, filters)), filters.limit)
      .map((record) => clone(record));
  }

  clear(): void { throw new Error("BlobToolExecutionRepository.clear is only available in memory mode."); }

  async health(): Promise<RepositoryHealth> {
    return { ...healthyRepositoryStatus(storeBackendLabel()), version: "tool_executions.v2" };
  }
}
