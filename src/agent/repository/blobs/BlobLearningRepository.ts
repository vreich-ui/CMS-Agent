import type { LearningObservation } from "../../mcp/workspace/store.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { LearningRepository } from "../interfaces/LearningRepository.js";
import type { WorkspaceRepository } from "../interfaces/WorkspaceRepository.js";
import { getBlobJson, getCmsAgentBlobStore, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);

export class BlobLearningRepository implements LearningRepository {
  constructor(private readonly workspaceRepository: WorkspaceRepository, private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  async recordObservation(observation: string, metadata?: Record<string, unknown>): Promise<LearningObservation> {
    return this.workspaceRepository.recordObservation(observation, metadata);
  }

  async listObservations(): Promise<LearningObservation[]> {
    const result = await this.store.list({ prefix: "learning/" });
    if (result.blobs.length === 0) return this.workspaceRepository.listObservations();
    const records = await Promise.all(result.blobs.map((blob) => getBlobJson<LearningObservation>(this.store, blob.key)));
    return records.filter((record): record is LearningObservation => record !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((record) => clone(record));
  }

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus("blobs"), version: "blobs.v1" }; }
}
