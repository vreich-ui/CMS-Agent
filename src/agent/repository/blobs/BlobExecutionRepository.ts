import type { WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ExecutionRepository } from "../interfaces/ExecutionRepository.js";
import { getBlobJson, getCmsAgentBlobStore, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
const runKey = (runId: string) => `runs/${runId}.json`;
const artifactKey = (artifactId: string) => `artifacts/${artifactId}.json`;

export class BlobExecutionRepository implements ExecutionRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  private async persistArtifacts(run: WorkflowExecutionRecord) {
    await Promise.all(run.artifacts.map((artifact) => this.store.setJSON(artifactKey(artifact.id), { runId: run.runId, artifact })));
  }

  async createRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    await this.store.setJSON(runKey(run.runId), run);
    await this.persistArtifacts(run);
    return clone(run);
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

  async saveRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    await this.store.setJSON(runKey(run.runId), run);
    await this.persistArtifacts(run);
    return clone(run);
  }

  async resetRun(runId: string, nextRun: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    await this.store.setJSON(runKey(runId), nextRun);
    await this.persistArtifacts(nextRun);
    return clone(nextRun);
  }

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus("blobs"), version: "blobs.v1" }; }
}
