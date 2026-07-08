import type { LearningObservation } from "../../mcp/workspace/store.js";
import type { LearningRepository } from "../interfaces/LearningRepository.js";
import type { WorkspaceRepository } from "../interfaces/WorkspaceRepository.js";

export class MemoryLearningRepository implements LearningRepository {
  constructor(private readonly workspaceRepository: WorkspaceRepository) {}

  recordObservation(observation: string, metadata?: Record<string, unknown>): Promise<LearningObservation> {
    return this.workspaceRepository.recordObservation(observation, metadata);
  }

  listObservations(): Promise<LearningObservation[]> {
    return this.workspaceRepository.listObservations();
  }
}
