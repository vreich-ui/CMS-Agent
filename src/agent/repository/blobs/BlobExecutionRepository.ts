import type { ExecutionStatus, WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import { RunConcurrencyError, windowRunRows, type ExecutionRepository, type ListRunsFilters, type ListRunsPageResult } from "../interfaces/ExecutionRepository.js";
import { getBlobJson, getBlobJsonWithEtag, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
const runKey = (runId: string) => `runs/${runId}.json`;
const artifactKey = (artifactId: string) => `artifacts/${artifactId}.json`;
const revOf = (run: WorkflowExecutionRecord | null | undefined): number => run?.rev ?? 0;

// W1.5 — per-project run index. Before this, listRuns fetched EVERY run blob in the fleet (54+ runs,
// one of them 1.19MB) before applying any projectId/status/time filter, so every workflow.list_runs
// call — scoped or not — paid the full-fleet read, and unscoped calls timed out at the proxy from
// sheer latency/size alone. The fix: each project gets a small index blob (run-index/<projectId>.json)
// holding one compact entry per run — just the fields the list window filters and sorts on. A listing
// reads the index (or the aggregated indexes, for unscoped calls), applies status/time filters,
// cursor and limit FIRST, and only then fetches the ≤limit run blobs it will actually return.
//
// The index is maintained on the single write path (createRun/saveRun/resetRun all upsert the run's
// entry) and is self-healing in both directions:
//   - absent entirely (pre-W1.5 data): the first read that needs it rebuilds every project's index
//     from one full scan and stamps a meta blob, so no migration step ever has to be run;
//   - names a run whose blob is gone: the listing drops the ghost row and prunes it from the index
//     rather than failing;
//   - misses a run (a lost CAS race): the run's next status save re-upserts it.
type RunIndexEntry = {
  runId: string;
  projectId: string;
  workflowId: string;
  status: ExecutionStatus;
  startedAt: string;
  updatedAt: string;
  requestId?: string;
};
type RunIndexBlob = { runs: RunIndexEntry[] };
type RunIndexMeta = { backfilledAt: string };

const RUN_INDEX_PREFIX = "run-index/";
// "!" sorts before any encodeURIComponent output, and encodeURIComponent never emits it, so the meta
// blob can share the prefix (one `list` covers both) without ever colliding with a project id.
const RUN_INDEX_META_KEY = `${RUN_INDEX_PREFIX}!meta.json`;
const runIndexKey = (projectId: string) => `${RUN_INDEX_PREFIX}${encodeURIComponent(projectId)}.json`;
const indexEntryOf = (run: WorkflowExecutionRecord): RunIndexEntry => ({
  runId: run.runId,
  projectId: run.projectId,
  workflowId: run.workflowId,
  status: run.status,
  startedAt: run.startedAt,
  updatedAt: run.updatedAt,
  ...(run.requestId !== undefined ? { requestId: run.requestId } : {})
});

// W1.2 (documented residual from W1.4/#232) — retained under W1.5 for the callers that genuinely
// need every full run record (constellation tools, node-scoped fallback listings): those still fetch
// the whole fleet, so a burst of them within the window still collapses into one blob-store round
// trip. Caching the in-flight PROMISE (not just the resolved value) also dedupes concurrent callers
// against each other, not only sequential ones. Windowed calls never populate this cache — they no
// longer perform the full-fleet fetch at all — but they will happily answer from it while it is live.
const FULL_FLEET_CACHE_TTL_MS = 5_000;

export class BlobExecutionRepository implements ExecutionRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  private fullFleetCache: { expiresAt: number; runs: Promise<WorkflowExecutionRecord[]> } | null = null;

  // Once the meta blob has been seen (or written), it never disappears — remember that per instance
  // so steady-state windowed reads cost exactly one index read plus the page's run blobs.
  private indexConfirmed = false;
  private indexReady: Promise<void> | null = null;

  private fetchAllRuns(): Promise<WorkflowExecutionRecord[]> {
    const cached = this.fullFleetCache;
    if (cached && cached.expiresAt > Date.now()) return cached.runs;
    const fetch = (async () => {
      const result = await this.store.list({ prefix: "runs/" });
      const runs = await Promise.all(result.blobs.map((blob) => getBlobJson<WorkflowExecutionRecord>(this.store, blob.key)));
      return runs.filter((run): run is WorkflowExecutionRecord => run !== null);
    })();
    this.fullFleetCache = { expiresAt: Date.now() + FULL_FLEET_CACHE_TTL_MS, runs: fetch };
    // A failed fetch must not poison the cache for the rest of the TTL window — clear it so the very
    // next call retries instead of replaying the same rejection.
    fetch.catch(() => { if (this.fullFleetCache?.runs === fetch) this.fullFleetCache = null; });
    return fetch;
  }

  // Every write invalidates the cache so a caller never sees its own write as stale — this only
  // covers writes made through THIS repository instance (in-process, per Cloud Run instance), which
  // is the same scope the cache itself operates at.
  private invalidateFullFleetCache(): void { this.fullFleetCache = null; }

  // Self-healing backfill: if the meta blob is absent (a store predating W1.5), rebuild every
  // project's index from one full scan and stamp the meta. Deduped in-process so a burst of first
  // reads triggers one backfill, and a failure clears the gate so the next read retries.
  private ensureIndex(): Promise<void> {
    if (this.indexConfirmed) return Promise.resolve();
    if (!this.indexReady) {
      const ready = (async () => {
        const meta = await getBlobJson<RunIndexMeta>(this.store, RUN_INDEX_META_KEY);
        if (!meta) await this.backfillIndex();
        this.indexConfirmed = true;
      })();
      this.indexReady = ready;
      ready.catch(() => { if (this.indexReady === ready) this.indexReady = null; });
    }
    return this.indexReady;
  }

  private async backfillIndex(): Promise<void> {
    const runs = await this.fetchAllRuns();
    const byProject = new Map<string, RunIndexEntry[]>();
    for (const run of runs) {
      const entries = byProject.get(run.projectId) ?? [];
      entries.push(indexEntryOf(run));
      byProject.set(run.projectId, entries);
    }
    await Promise.all([...byProject.entries()].map(([projectId, entries]) => this.store.setJSON(runIndexKey(projectId), { runs: entries } satisfies RunIndexBlob)));
    await this.store.setJSON(RUN_INDEX_META_KEY, { backfilledAt: new Date().toISOString() } satisfies RunIndexMeta);
  }

  private async readProjectIndex(projectId: string): Promise<RunIndexEntry[]> {
    const index = await getBlobJson<RunIndexBlob>(this.store, runIndexKey(projectId));
    return index?.runs ?? [];
  }

  // Unscoped aggregation: the per-project index blobs are enumerated by prefix and read in full.
  // This is still cheap — a handful of small blobs, each a few hundred bytes per run — which is what
  // lets an UNSCOPED windowed listing avoid the full-fleet fetch too.
  private async readAllIndexEntries(): Promise<RunIndexEntry[]> {
    const listing = await this.store.list({ prefix: RUN_INDEX_PREFIX });
    const keys = listing.blobs.map((blob) => blob.key).filter((key) => key !== RUN_INDEX_META_KEY);
    const indexes = await Promise.all(keys.map((key) => getBlobJson<RunIndexBlob>(this.store, key)));
    return indexes.flatMap((index) => index?.runs ?? []);
  }

  // Read-modify-write with a CAS retry loop so concurrent writers to the same project's index don't
  // silently drop each other's entries. After the retries are exhausted the merged view from the
  // last read is written unconditionally: losing that (rare) race costs at worst one CONCURRENT
  // entry, which that run's next status save re-upserts — strictly better than dropping THIS entry.
  private async upsertIndexEntry(run: WorkflowExecutionRecord): Promise<void> {
    const key = runIndexKey(run.projectId);
    const entry = indexEntryOf(run);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await getBlobJsonWithEtag<RunIndexBlob>(this.store, key);
      const runs = (current.data?.runs ?? []).filter((existing) => existing.runId !== entry.runId);
      runs.push(entry);
      const conditional = attempt < 4;
      const options: Parameters<BlobStoreClient["setJSON"]>[2] =
        !conditional ? undefined : current.etag ? { onlyIfMatch: current.etag } : current.data ? undefined : { onlyIfNew: true };
      const write = await this.store.setJSON(key, { runs } satisfies RunIndexBlob, options);
      if (!write || (write as { modified?: boolean }).modified !== false) return;
    }
  }

  // Consistency guard: entries whose run blob has vanished are pruned (best-effort, one CAS attempt
  // per project) instead of failing the listing. A lost prune just means the ghost row is dropped
  // again — and pruned again — on the next listing.
  private async pruneIndexEntries(ghosts: RunIndexEntry[]): Promise<void> {
    const byProject = new Map<string, Set<string>>();
    for (const ghost of ghosts) {
      const ids = byProject.get(ghost.projectId) ?? new Set<string>();
      ids.add(ghost.runId);
      byProject.set(ghost.projectId, ids);
    }
    await Promise.all([...byProject.entries()].map(async ([projectId, runIds]) => {
      try {
        const key = runIndexKey(projectId);
        const current = await getBlobJsonWithEtag<RunIndexBlob>(this.store, key);
        if (!current.data) return;
        const runs = current.data.runs.filter((existing) => !runIds.has(existing.runId));
        if (runs.length === current.data.runs.length) return;
        await this.store.setJSON(key, { runs } satisfies RunIndexBlob, current.etag ? { onlyIfMatch: current.etag } : undefined);
      } catch { /* best-effort — the next listing prunes again */ }
    }));
  }

  private async persistArtifacts(run: WorkflowExecutionRecord) {
    await Promise.all(run.artifacts.map((artifact) => this.store.setJSON(artifactKey(artifact.id), { runId: run.runId, artifact })));
  }

  async createRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    const seeded = { ...clone(run), rev: revOf(run) };
    await this.store.setJSON(runKey(seeded.runId), seeded);
    await this.persistArtifacts(seeded);
    await this.upsertIndexEntry(seeded);
    this.invalidateFullFleetCache();
    return clone(seeded);
  }

  async getRun(runId: string): Promise<WorkflowExecutionRecord | undefined> {
    const run = await getBlobJson<WorkflowExecutionRecord>(this.store, runKey(runId));
    return run === null ? undefined : clone(run);
  }

  async listRuns(filters: ListRunsFilters = {}): Promise<WorkflowExecutionRecord[]> {
    return (await this.listRunsPage(filters)).runs;
  }

  async listRunsPage(filters: ListRunsFilters = {}): Promise<ListRunsPageResult> {
    // A live full-fleet cache already holds every record — any query, windowed or not, is answered
    // from it with zero further store round trips.
    const cached = this.fullFleetCache;
    if (cached && cached.expiresAt > Date.now()) return this.pageFromRecords(await cached.runs, filters);

    // Unscoped AND unwindowed: the caller genuinely needs every run record (constellation tools,
    // node fallback listings, run continuation). The index cannot help — every blob gets fetched
    // either way — so take the cached full-fleet path.
    if (!filters.projectId && filters.limit === undefined && filters.after === undefined) {
      return this.pageFromRecords(await this.fetchAllRuns(), filters);
    }

    // Index path: window over cheap index entries first, then fetch only the page's run blobs.
    await this.ensureIndex();
    const entries = filters.projectId ? await this.readProjectIndex(filters.projectId) : await this.readAllIndexEntries();
    const { window, matchedCount, hasMore } = windowRunRows(entries, filters);
    const fetched = await Promise.all(window.map((entry) => getBlobJson<WorkflowExecutionRecord>(this.store, runKey(entry.runId))));
    const ghosts = window.filter((_, i) => fetched[i] === null);
    if (ghosts.length) await this.pruneIndexEntries(ghosts);
    const runs = fetched.filter((run): run is WorkflowExecutionRecord => run !== null).map((run) => clone(run));
    return { runs, matchedCount: matchedCount - ghosts.length, hasMore };
  }

  private pageFromRecords(records: WorkflowExecutionRecord[], filters: ListRunsFilters): ListRunsPageResult {
    const { window, matchedCount, hasMore } = windowRunRows(records, filters);
    return { runs: window.map((run) => clone(run)), matchedCount, hasMore };
  }

  // Compare-and-swap persist. Read the current record with its ETag, reject when the stored revision
  // has moved past the caller's base, then write conditionally on that ETag so a writer that slipped
  // in between the read and the write is also rejected. When the store exposes no ETag (test doubles
  // or environments without getWithMetadata) the revision check still guards against stale overwrites.
  async saveRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    const key = runKey(run.runId);
    const base = revOf(run);
    const current = await getBlobJsonWithEtag<WorkflowExecutionRecord>(this.store, key);
    if (current.data && revOf(current.data) !== base) throw new RunConcurrencyError(run.runId, base, revOf(current.data));
    const next = { ...clone(run), rev: base + 1 };
    const options: Parameters<BlobStoreClient["setJSON"]>[2] =
      current.etag ? { onlyIfMatch: current.etag } : current.data ? undefined : { onlyIfNew: true };
    const write = await this.store.setJSON(key, next, options);
    if (write && (write as { modified?: boolean }).modified === false) throw new RunConcurrencyError(run.runId, base, revOf(current.data));
    await this.persistArtifacts(next);
    await this.upsertIndexEntry(next);
    this.invalidateFullFleetCache();
    return clone(next);
  }

  async resetRun(runId: string, nextRun: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    const key = runKey(runId);
    const current = await getBlobJson<WorkflowExecutionRecord>(this.store, key);
    const next = { ...clone(nextRun), rev: revOf(current) + 1 };
    await this.store.setJSON(key, next);
    await this.upsertIndexEntry(next);
    this.invalidateFullFleetCache();
    // A reset must clear prior artifacts too: the run record's artifact array is already empty, but
    // each artifact was also written to its own `artifacts/<id>.json` blob that node-output queries
    // scan by runId. Delete those so no pre-reset output survives the reset.
    if (current?.artifacts?.length) await Promise.all(current.artifacts.map((artifact) => this.store.delete(artifactKey(artifact.id)).catch(() => undefined)));
    await this.persistArtifacts(next);
    return clone(next);
  }

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "blobs.v1" }; }
}
