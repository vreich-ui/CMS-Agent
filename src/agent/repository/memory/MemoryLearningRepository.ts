import type { LearningObservation } from "../../mcp/workspace/store.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { LearningRepository } from "../interfaces/LearningRepository.js";
import type { WorkspaceRepository } from "../interfaces/WorkspaceRepository.js";

export class MemoryLearningRepository implements LearningRepository {
  constructor(private readonly workspaceRepository: WorkspaceRepository, private readonly backend: RepositoryBackend = "memory") {}

  recordObservation(observation: string, metadata?: Record<string, unknown>): Promise<LearningObservation> {
    return this.workspaceRepository.recordObservation(observation, metadata);
  }

  listObservations(): Promise<LearningObservation[]> {
    return this.workspaceRepository.listObservations();
  }

  async health(): Promise<RepositoryHealth> {
    return healthyRepositoryStatus(this.backend);
  }
}
