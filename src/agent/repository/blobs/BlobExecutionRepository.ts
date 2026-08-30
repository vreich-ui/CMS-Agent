import type { WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import { RunConcurrencyError, type ExecutionRepository } from "../interfaces/ExecutionRepository.js";
import { getBlobJson, getBlobJsonWithEtag, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
const runKey = (runId: string) => `runs/${runId}.json`;
const artifactKey = (artifactId: string) => `artifacts/${artifactId}.json`;
const revOf = (run: WorkflowExecutionRecord | null | undefined): number => run?.rev ?? 0;

// W1.2 (documented residual from W1.4/#232) — listRuns fetches EVERY run blob before any filter is
// applied, so a call with no projectId (workflow.list_runs unscoped, constellation tools, node's own
// fallback listing) pays that full-fleet fetch every single time, which is what let an unscoped call
// alone starve or OOM the instance. Cache the full-fleet fetch itself (not the filtered/sorted
// result — filters differ per call) for a short TTL so a burst of calls within the window — the
// common case, since several unscoped queries typically land within the same second — collapse into
// one blob-store round trip. Caching the in-flight PROMISE (not just the resolved value) also
// dedupes concurrent callers against each other, not only sequential ones.
const FULL_FLEET_CACHE_TTL_MS = 5_000;

export class BlobExecutionRepository implements ExecutionRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  private fullFleetCache: { expiresAt: number; runs: Promise<WorkflowExecutionRecord[]> } | null = null;

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

  private async persistArtifacts(run: WorkflowExecutionRecord) {
    await Promise.all(run.artifacts.map((artifact) => this.store.setJSON(artifactKey(artifact.id), { runId: run.runId, artifact })));
  }

  async createRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    const seeded = { ...clone(run), rev: revOf(run) };
    await this.store.setJSON(runKey(seeded.runId), seeded);
    await this.persistArtifacts(seeded);
    this.invalidateFullFleetCache();
    return clone(seeded);
  }

  async getRun(runId: string): Promise<WorkflowExecutionRecord | undefined> {
    const run = await getBlobJson<WorkflowExecutionRecord>(this.store, runKey(runId));
    return run === null ? undefined : clone(run);
  }

  async listRuns(filters: { projectId?: string; workflowId?: string } = {}): Promise<WorkflowExecutionRecord[]> {
    const runs = await this.fetchAllRuns();
    return runs
      .filter((run) => !filters.projectId || run.projectId === filters.projectId)
      .filter((run) => !filters.workflowId || run.workflowId === filters.workflowId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((run) => clone(run));
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
    this.invalidateFullFleetCache();
    return clone(next);
  }

  async resetRun(runId: string, nextRun: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    const key = runKey(runId);
    const current = await getBlobJson<WorkflowExecutionRecord>(this.store, key);
    const next = { ...clone(nextRun), rev: revOf(current) + 1 };
    await this.store.setJSON(key, next);
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
