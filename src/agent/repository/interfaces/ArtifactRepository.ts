import type { ExecutionArtifact } from "../../workspace/executionTypes.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

export interface ArtifactRepository {
  listArtifacts(runId: string): Promise<ExecutionArtifact[]>;
  health(): Promise<RepositoryHealth>;
}
