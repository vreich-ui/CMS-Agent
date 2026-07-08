import type { ExecutionArtifact } from "../../workspace/executionTypes.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ArtifactRepository } from "../interfaces/ArtifactRepository.js";
import type { ExecutionRepository } from "../interfaces/ExecutionRepository.js";

export class MemoryArtifactRepository implements ArtifactRepository {
  constructor(private readonly executionRepository: ExecutionRepository, private readonly backend: RepositoryBackend = "memory") {}

  async listArtifacts(runId: string): Promise<ExecutionArtifact[]> {
    const run = await this.executionRepository.getRun(runId);
    return run ? [...run.artifacts] : [];
  }

  async health(): Promise<RepositoryHealth> {
    return healthyRepositoryStatus(this.backend);
  }
}
