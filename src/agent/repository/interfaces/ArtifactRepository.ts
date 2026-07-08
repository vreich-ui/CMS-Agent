import type { ExecutionArtifact } from "../../workspace/executionTypes.js";

export interface ArtifactRepository {
  listArtifacts(runId: string): Promise<ExecutionArtifact[]>;
}
