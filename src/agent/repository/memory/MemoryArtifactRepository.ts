import type { ExecutionArtifact } from "../../workspace/executionTypes.js";
import type { ArtifactRepository } from "../interfaces/ArtifactRepository.js";
import type { ExecutionRepository } from "../interfaces/ExecutionRepository.js";

export class MemoryArtifactRepository implements ArtifactRepository {
  constructor(private readonly executionRepository: ExecutionRepository) {}

  async listArtifacts(runId: string): Promise<ExecutionArtifact[]> {
    const run = await this.executionRepository.getRun(runId);
    return run ? [...run.artifacts] : [];
  }
}
