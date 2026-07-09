import type { ExecutionArtifact } from "../../workspace/executionTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ArtifactRepository } from "../interfaces/ArtifactRepository.js";
import { getCmsAgentBlobStore, strongConsistency, type BlobStoreClient } from "./blobClient.js";

type StoredArtifact = { runId: string; artifact: ExecutionArtifact };
const clone = <T>(value: T): T => structuredClone(value);

export class BlobArtifactRepository implements ArtifactRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  async listArtifacts(runId: string): Promise<ExecutionArtifact[]> {
    const result = await this.store.list({ prefix: "artifacts/" });
    const records = await Promise.all(result.blobs.map(async (blob) => this.store.get(blob.key, { type: "json", ...strongConsistency }) as Promise<StoredArtifact | null>));
    return records.filter((record): record is StoredArtifact => record !== null && record.runId === runId).map((record) => clone(record.artifact));
  }

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus("blobs"), version: "blobs.v1" }; }
}
