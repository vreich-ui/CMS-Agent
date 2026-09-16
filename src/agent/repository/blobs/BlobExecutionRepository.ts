import type { ExecutionStatus, WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import { RunConcurrencyError, runSummaryOf, windowRunRows, type ExecutionRepository, type ListRunSummariesPageResult, type ListRunsFilters, type ListRunsPageResult, type RunSummaryRecord } from "../interfaces/ExecutionRepository.js";
import { CoalescedTtlCache, getBlobJson, getBlobJsonWithEtag, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

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
//   - names a run whose blob is gone: a listing that opens run records (listRunsPage, and the
//     repair path of a summary listing) drops the ghost row and prunes it from the index rather
//     than failing. A `detail: "summary"` listing of CURRENT entries opens no records at all, so
//     it cannot detect a ghost and will keep returning that row until something reads the blob.
//     Nothing in this service deletes a run blob, so a ghost only arises from external deletion
//     or a partial write; the alternative — a GET per row to prove existence — would give back
//     the entire cost this row projection exists to remove;
//   - misses a run (a lost CAS race): the run's next status save re-upserts it.
//
// W4 — the index entry IS the list row now. It used to hold only what the window filters and
// sorts on, so a listing still had to open every run blob it returned just to build a row.
// Measured live (2026-09-14): ~28KB per row, ~8s for twenty rows scoped to one project, 16s
// unscoped — for a row whose visible content is a dozen scalars. Carrying the row projection
// (RunSummaryRecord) in the entry makes `detail: "summary"` cost zero blob reads.
//
// The entry is a superset of RunSummaryRecord plus the `v` schema stamp. `v` is what makes the
// extension self-healing: an index written before W4 has no `v`, ensureIndex sees the meta
// blob's version is behind and rebuilds, and any straggler entry that slips through (a lost CAS
// race mid-deploy) is detected per-row and filled from its own blob rather than reported with
// missing counts.
type RunIndexEntry = RunSummaryRecord & { v?: number };
type RunIndexBlob = { runs: RunIndexEntry[] };
type RunIndexMeta = { backfilledAt: string; v?: number };

// Bumped whenever the entry projection gains or changes a field — v3 adds approvalsRequired,
// budgetBlock, operatorPublishDecision and operatorDecisionSource, restored to the row after
// review. isStaleEntry is the only thing that repairs an entry to the current projection and it
// keys on this number, so forgetting the bump means any store already holding v2 entries serves
// `approvalsRequired: undefined` for those runs forever — indistinguishable from a run with no
// pending gate, which is precisely the silent wire break restoring the field was meant to close.
// Bumping is cheap now: a version gap heals lazily, per page, instead of scanning the fleet.
// 4 (W5): rows gained nodeStatuses/failedNodeIds. Bumped so isStaleEntry re-reads a row written by an
// older build instead of serving a listing whose per-node chips are silently absent — which would look
// to the rail exactly like a fleet with no failures anywhere.
// 5 (W5, this wave): rows gained `scores`. Same reasoning one field over — a row written before this
// carries no scores, and serving it as-is would report a scored run as unscored. The bump is what
// makes the lazy per-page heal re-read it; that heal is loud and never repeated in-instance as of
// W1, and scripts/run-index-heal.mjs drains a whole fleet in one pass when an operator would rather
// not wait for the pages to be visited.
export const RUN_INDEX_VERSION = 5;

// W1 — the heal is instrumented. `isStaleEntry` repairs a row by opening its run blob; the write
// that makes the repair permanent used to be `.catch(() => undefined)`, so a store whose index
// writes were failing would re-read up to `limit` run blobs on EVERY listing and never say a word.
// These two log names are the difference between a five-minute diagnosis and a week of guessing.
export const RUN_INDEX_HEAL_OK = "run_index.heal_persisted";
export const RUN_INDEX_HEAL_FAILED = "run_index.heal_failed";

// What a merged index write actually managed to persist — `failed` means five CAS attempts lost,
// including the final unconditional one, so nothing landed for those run ids.
type IndexWriteOutcome = { written: string[]; failed: string[] };

// Repairs remembered in-instance so a listing never re-reads a blob it already healed. Bounded:
// this is an optimization, and a full map degrades to exactly the pre-W1 behavior (re-read).
const REPAIRED_ROW_CACHE_CAP = 500;
// W7 — how long a repaired row may answer for a run whose index entry is still stale. Long enough
// to collapse the burst of pages a single Runs-screen paint makes; short enough that a run whose
// index write keeps failing cannot be reported in a state it left minutes ago.
const REPAIRED_ROW_TTL_MS = 30_000;

const RUN_INDEX_PREFIX = "run-index/";
// "!" sorts before any encodeURIComponent output, and encodeURIComponent never emits it, so the meta
// blob can share the prefix (one `list` covers both) without ever colliding with a project id.
const RUN_INDEX_META_KEY = `${RUN_INDEX_PREFIX}!meta.json`;
const runIndexKey = (projectId: string) => `${RUN_INDEX_PREFIX}${encodeURIComponent(projectId)}.json`;
// One reading, shared with every other backend (runSummaryOf) — so "the index agrees with the
// record" is a property of one function, not of two copies that drift.
const indexEntryOf = (run: WorkflowExecutionRecord): RunIndexEntry => ({ ...runSummaryOf(run), v: RUN_INDEX_VERSION });

/** The sort key of the last WINDOWED row — the paging anchor, which survives a dropped row. */
const lastKeyOf = (window: Array<{ startedAt: string; runId: string }>) =>
  window.length ? { lastKey: { startedAt: window[window.length - 1].startedAt, runId: window[window.length - 1].runId } } : {};

/** The row, without the index's own bookkeeping stamp. */
const stripEntry = ({ v: _v, ...row }: RunIndexEntry): RunSummaryRecord => row;

/** An entry written by an older deployment, before the row projection was indexed. */
const isStaleEntry = (entry: RunIndexEntry): boolean => (entry.v ?? 0) < RUN_INDEX_VERSION;

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

  // W1 — rows repaired by this instance, and a running tally of how the repair went. Both are
  // process-local and reset with the instance, which is the same scope the full-fleet cache uses.
  private readonly repairedRows = new Map<string, { summary: RunSummaryRecord; at: number }>();
  private readonly indexHealStats = { repaired: 0, failed: 0, lastFailureAt: undefined as string | undefined };

  private rememberRepairedRow(runId: string, summary: RunSummaryRecord): void {
    if (this.repairedRows.size >= REPAIRED_ROW_CACHE_CAP) {
      const oldest = this.repairedRows.keys().next();
      if (!oldest.done) this.repairedRows.delete(oldest.value);
    }
    this.repairedRows.set(runId, { summary: clone(summary), at: Date.now() });
  }

  /** W7 — a repaired row is a COPY of a run's state at one moment, kept because the index write for
   *  it failed. Read it back forever and it stops being a cost saving and becomes a lie: the exact
   *  situation it exists for (index writes failing) is also the situation in which the index never
   *  learns the run moved on, so the listing would report "running, 3/8" for the life of the
   *  instance while the run failed and finished. The TTL bounds that to one window; a write made
   *  through this instance drops the row outright, because then we KNOW it moved. */
  private repairedRow(runId: string): RunSummaryRecord | undefined {
    const hit = this.repairedRows.get(runId);
    if (!hit) return undefined;
    if (Date.now() - hit.at > REPAIRED_ROW_TTL_MS) {
      this.repairedRows.delete(runId);
      return undefined;
    }
    return clone(hit.summary);
  }

  // Every write invalidates the cache so a caller never sees its own write as stale — this only
  // covers writes made through THIS repository instance (in-process, per Cloud Run instance), which
  // is the same scope the cache itself operates at.
  private invalidateFullFleetCache(runId?: string): void {
    this.fullFleetCache = null;
    this.indexCache.invalidate();
    // A run this instance just wrote is no longer described by whatever it repaired earlier.
    if (runId) this.repairedRows.delete(runId);
  }

  // Self-healing backfill: if the meta blob is absent (a store predating W1.5), rebuild every
  // project's index from one full scan and stamp the meta. Deduped in-process so a burst of first
  // reads triggers one backfill, and a failure clears the gate so the next read retries.
  private ensureIndex(): Promise<void> {
    if (this.indexConfirmed) return Promise.resolve();
    if (!this.indexReady) {
      const ready = (async () => {
        const meta = await getBlobJson<RunIndexMeta>(this.store, RUN_INDEX_META_KEY);
        // Absent meta (a store predating W1.5) still means one full scan: there is no index to
        // read at all, so there is nothing cheaper to do.
        //
        // REVIEW FIX — a meta merely BEHIND the current entry version does NOT trigger that scan.
        // It used to, and that was the W3 defect reintroduced at deploy time: production's meta
        // has no `v`, so every cold instance would have run fetchAllRuns() — store.list("runs/")
        // plus a GET of all 115 blobs, one of them 1.19MB — inline, on its first request, and
        // again on every autoscale, in front of the very endpoint this change exists to make
        // fast. A version gap is instead healed lazily and per page: a listing repairs the stale
        // entries in ITS OWN window (bounded by the page limit) and writes them back once.
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
    await this.store.setJSON(RUN_INDEX_META_KEY, { backfilledAt: new Date().toISOString(), v: RUN_INDEX_VERSION } satisfies RunIndexMeta);
    this.indexCache.invalidate();
  }

  // W3 — the index read, coalesced and briefly cached. `workbench.bootstrap` asks four
  // status-scoped questions at once to build its attention counts, and every one of them wants the
  // same index; before this each was a prefix listing plus one read per project blob. One second,
  // dropped by every index write, so a listing can never show a row this instance has already
  // moved past.
  private readonly indexCache = new CoalescedTtlCache<RunIndexEntry[]>(1000);

  private async readProjectIndex(projectId: string): Promise<RunIndexEntry[]> {
    return this.indexCache.read(`project:${projectId}`, async () => {
      const index = await getBlobJson<RunIndexBlob>(this.store, runIndexKey(projectId));
      return index?.runs ?? [];
    });
  }

  // Unscoped aggregation: the per-project index blobs are enumerated by prefix and read in full.
  // This is still cheap — a handful of small blobs, each a few hundred bytes per run — which is what
  // lets an UNSCOPED windowed listing avoid the full-fleet fetch too.
  private async readAllIndexEntries(): Promise<RunIndexEntry[]> {
    return this.indexCache.read("all", async () => {
      const listing = await this.store.list({ prefix: RUN_INDEX_PREFIX });
      const keys = listing.blobs.map((blob) => blob.key).filter((key) => key !== RUN_INDEX_META_KEY);
      const indexes = await Promise.all(keys.map((key) => getBlobJson<RunIndexBlob>(this.store, key)));
      return indexes.flatMap((index) => index?.runs ?? []);
    });
  }

  // Read-modify-write with a CAS retry loop so concurrent writers to the same project's index don't
  // silently drop each other's entries. After the retries are exhausted the merged view from the
  // last read is written unconditionally: losing that (rare) race costs at worst one CONCURRENT
  // entry, which that run's next status save re-upserts — strictly better than dropping THIS entry.
  private async upsertIndexEntry(run: WorkflowExecutionRecord): Promise<void> {
    await this.upsertIndexEntries([run]);
  }

  // REVIEW FIX — entries are merged into ONE write per project rather than one CAS loop per run.
  // The lazy repair path can have a whole page of stale entries to fix at once; firing `limit`
  // concurrent read-modify-write loops at a single index blob means most of them lose their CAS,
  // and the loop's final unconditional write then replays a stale snapshot over whatever landed
  // in between — which could drop entries a concurrent saveRun had just added. One merged write
  // is both correct and O(1) in the number of repairs.
  private async upsertIndexEntries(records: WorkflowExecutionRecord[]): Promise<IndexWriteOutcome> {
    const byProject = new Map<string, RunIndexEntry[]>();
    for (const record of records) {
      const entries = byProject.get(record.projectId) ?? [];
      entries.push(indexEntryOf(record));
      byProject.set(record.projectId, entries);
    }
    const outcome: IndexWriteOutcome = { written: [], failed: [] };
    this.indexCache.invalidate();
    await Promise.all([...byProject.entries()].map(async ([projectId, entries]) => {
      const key = runIndexKey(projectId);
      const ids = new Set(entries.map((entry) => entry.runId));
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await getBlobJsonWithEtag<RunIndexBlob>(this.store, key);
        const runs = (current.data?.runs ?? []).filter((existing) => !ids.has(existing.runId));
        runs.push(...entries);
        const conditional = attempt < 4;
        const options: Parameters<BlobStoreClient["setJSON"]>[2] =
          !conditional ? undefined : current.etag ? { onlyIfMatch: current.etag } : current.data ? undefined : { onlyIfNew: true };
        const write = await this.store.setJSON(key, { runs } satisfies RunIndexBlob, options);
        if (!write || (write as { modified?: boolean }).modified !== false) { outcome.written.push(...ids); this.indexCache.invalidate(); return; }
      }
      // Five CAS attempts lost, INCLUDING the final unconditional one. Nothing landed; say so
      // rather than returning as though it had.
      outcome.failed.push(...ids);
    }));
    return outcome;
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
        this.indexCache.invalidate();
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
    this.invalidateFullFleetCache(seeded.runId);
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

    // Unscoped AND unwindowed AND not status-filtered: the caller genuinely needs every run record
    // (constellation tools, node fallback listings). The index cannot help — every blob gets fetched
    // either way — so take the cached full-fleet path.
    //
    // `status` is the exception, and the reason this condition grew a third clause. The index entry
    // already CARRIES the status (windowRunRows filters on it at ExecutionRepository.ts:70), so a
    // non-matching run is rejected without its blob ever being opened. The continuation tick asks
    // for exactly two statuses out of a fleet whose terminal runs outnumber its active ones by three
    // orders of magnitude; before this clause it paid one `list` plus one GET per run — ~2,000 Class
    // B operations every two minutes — to discard ~99.5% of them at `skip_not_active`. The answer,
    // the ordering and `matchedCount` are identical either way; only the reads differ.
    if (!filters.projectId && filters.limit === undefined && filters.after === undefined && filters.status === undefined) {
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
    return { runs, matchedCount: matchedCount - ghosts.length, hasMore, ...lastKeyOf(window) };
  }

  /**
   * W4 — the whole point of the extended index: a page of list ROWS with no run blob opened.
   *
   * Two honest fallbacks, both bounded by the page size rather than by the fleet:
   *   - a live full-fleet cache is already holding every record, so answer from it;
   *   - an individual entry written by an older deployment cannot answer the row, so THAT run's
   *     blob is read and its entry repaired. Reporting a row with missing counts would be worse
   *     than the read: a zero that means "not indexed" is indistinguishable from a zero that
   *     means "no failures".
   */
  async listRunSummariesPage(filters: ListRunsFilters = {}): Promise<ListRunSummariesPageResult> {
    const cached = this.fullFleetCache;
    if (cached && cached.expiresAt > Date.now()) {
      const { window, matchedCount, hasMore } = windowRunRows(await cached.runs, filters);
      return { rows: window.map((run) => runSummaryOf(run)), matchedCount, hasMore, ...lastKeyOf(window) };
    }

    await this.ensureIndex();
    const entries = filters.projectId ? await this.readProjectIndex(filters.projectId) : await this.readAllIndexEntries();
    const { window, matchedCount, hasMore } = windowRunRows(entries, filters);

    // Rows this instance already repaired are answered from memory. Without that, a heal whose
    // WRITE never lands (the defect this whole block is instrumented for) makes every listing pay
    // the same `limit` blob reads forever — the 23 s, 60 KB listing measured on 2026-09-16.
    const repaired = new Map<string, RunSummaryRecord>();
    const stale: RunIndexEntry[] = [];
    for (const entry of window) {
      if (!isStaleEntry(entry)) continue;
      const remembered = this.repairedRow(entry.runId);
      if (remembered) repaired.set(entry.runId, remembered);
      else stale.push(entry);
    }

    if (stale.length) {
      const startedAt = Date.now();
      const records = await Promise.all(stale.map((entry) => getBlobJson<WorkflowExecutionRecord>(this.store, runKey(entry.runId))));
      const found: WorkflowExecutionRecord[] = [];
      const ghosts: RunIndexEntry[] = [];
      records.forEach((record, i) => {
        if (record) {
          found.push(record);
          const summary = runSummaryOf(record);
          repaired.set(record.runId, summary);
          this.rememberRepairedRow(record.runId, summary);
        } else ghosts.push(stale[i]);
      });
      // One merged write per project, so the next listing of this page costs nothing — IF it
      // lands. It used to be `.catch(() => undefined)`: a write that never succeeded left every
      // listing re-reading the same blobs, silently, forever. Now the outcome is reported, the
      // failure is counted, and repository health carries it.
      if (found.length) {
        let outcome: IndexWriteOutcome = { written: [], failed: found.map((record) => record.runId) };
        let error: string | undefined;
        try { outcome = await this.upsertIndexEntries(found); }
        catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
        this.indexHealStats.repaired += outcome.written.length;
        this.indexHealStats.failed += outcome.failed.length;
        if (outcome.failed.length || error) {
          this.indexHealStats.lastFailureAt = new Date().toISOString();
          console.warn(RUN_INDEX_HEAL_FAILED, JSON.stringify({
            rows: found.length, written: outcome.written.length, failed: outcome.failed.length,
            runIds: outcome.failed.slice(0, 10), indexVersion: RUN_INDEX_VERSION, ...(error ? { error } : {})
          }));
        } else {
          console.info(RUN_INDEX_HEAL_OK, JSON.stringify({ rows: found.length, blobReads: stale.length, ms: Date.now() - startedAt, indexVersion: RUN_INDEX_VERSION }));
        }
      }
      if (ghosts.length) await this.pruneIndexEntries(ghosts);
    }

    const rows = window
      .filter((entry) => !isStaleEntry(entry) || repaired.has(entry.runId))
      .map((entry) => repaired.get(entry.runId) ?? stripEntry(entry));
    return { rows, matchedCount: matchedCount - (window.length - rows.length), hasMore, ...lastKeyOf(window) };
  }

  private pageFromRecords(records: WorkflowExecutionRecord[], filters: ListRunsFilters): ListRunsPageResult {
    const { window, matchedCount, hasMore } = windowRunRows(records, filters);
    return { runs: window.map((run) => clone(run)), matchedCount, hasMore, ...lastKeyOf(window) };
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
    this.invalidateFullFleetCache(next.runId);
    return clone(next);
  }

  async resetRun(runId: string, nextRun: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    const key = runKey(runId);
    const current = await getBlobJson<WorkflowExecutionRecord>(this.store, key);
    const next = { ...clone(nextRun), rev: revOf(current) + 1 };
    await this.store.setJSON(key, next);
    await this.upsertIndexEntry(next);
    this.invalidateFullFleetCache(next.runId);
    // A reset must clear prior artifacts too: the run record's artifact array is already empty, but
    // each artifact was also written to its own `artifacts/<id>.json` blob that node-output queries
    // scan by runId. Delete those so no pre-reset output survives the reset.
    if (current?.artifacts?.length) await Promise.all(current.artifacts.map((artifact) => this.store.delete(artifactKey(artifact.id)).catch(() => undefined)));
    await this.persistArtifacts(next);
    return clone(next);
  }

  async health(): Promise<RepositoryHealth> {
    const { repaired, failed, lastFailureAt } = this.indexHealStats;
    return {
      ...healthyRepositoryStatus(storeBackendLabel()),
      version: "blobs.v1",
      // A heal that is not persisting is the difference between a listing that costs nothing and
      // one that opens `limit` run blobs every single time. Never silent again.
      ...(repaired > 0 || failed > 0
        ? { details: { runIndexVersion: RUN_INDEX_VERSION, runIndexRowsRepaired: repaired, runIndexRepairsFailed: failed, ...(lastFailureAt ? { runIndexLastRepairFailureAt: lastFailureAt } : {}) } }
        : {})
    };
  }
}
