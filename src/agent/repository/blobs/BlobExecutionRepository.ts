import type { WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import { RunConcurrencyError, type ExecutionRepository } from "../interfaces/ExecutionRepository.js";
import { getBlobJson, getBlobJsonWithEtag, getCmsAgentBlobStore, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
const runKey = (runId: string) => `runs/${runId}.json`;
const artifactKey = (artifactId: string) => `artifacts/${artifactId}.json`;
const revOf = (run: WorkflowExecutionRecord | null | undefined): number => run?.rev ?? 0;

export class BlobExecutionRepository implements ExecutionRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  private async persistArtifacts(run: WorkflowExecutionRecord) {
    await Promise.all(run.artifacts.map((artifact) => this.store.setJSON(artifactKey(artifact.id), { runId: run.runId, artifact })));
  }

  async createRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    const seeded = { ...clone(run), rev: revOf(run) };
    await this.store.setJSON(runKey(seeded.runId), seeded);
    await this.persistArtifacts(seeded);
    return clone(seeded);
  }

  async getRun(runId: string): Promise<WorkflowExecutionRecord | undefined> {
    const run = await getBlobJson<WorkflowExecutionRecord>(this.store, runKey(runId));
    return run === null ? undefined : clone(run);
  }

  async listRuns(filters: { projectId?: string; workflowId?: string } = {}): Promise<WorkflowExecutionRecord[]> {
    const result = await this.store.list({ prefix: "runs/" });
    const runs = await Promise.all(result.blobs.map((blob) => getBlobJson<WorkflowExecutionRecord>(this.store, blob.key)));
    return runs.filter((run): run is WorkflowExecutionRecord => run !== null)
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
    return clone(next);
  }

  async resetRun(runId: string, nextRun: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    const key = runKey(runId);
    const current = await getBlobJson<WorkflowExecutionRecord>(this.store, key);
    const next = { ...clone(nextRun), rev: revOf(current) + 1 };
    await this.store.setJSON(key, next);
    // A reset must clear prior artifacts too: the run record's artifact array is already empty, but
    // each artifact was also written to its own `artifacts/<id>.json` blob that node-output queries
    // scan by runId. Delete those so no pre-reset output survives the reset.
    if (current?.artifacts?.length) await Promise.all(current.artifacts.map((artifact) => this.store.delete(artifactKey(artifact.id)).catch(() => undefined)));
    await this.persistArtifacts(next);
    return clone(next);
  }

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus("blobs"), version: "blobs.v1" }; }
}
